import time
from typing import Any, Dict, Optional

import requests

ZIPS_BASE_URL = 'https://api.zip-site.com/api'
SESSION_TTL_SECONDS = 10 * 60

FUNC_DATA = {
    'address_to_bluemap': {'id': '0002', 'subid': '0022'},
    'bluemap_to_address': {'id': '0002', 'subid': '0027'},
}

_cached_session: Dict[str, Any] | None = None
_cached_at = 0.0


class ZipsConfigurationError(RuntimeError):
    pass


class ZipsProxyError(RuntimeError):
    pass


def _get_zips_config(runtime_config: Dict[str, Any]) -> Dict[str, Any]:
    zips = runtime_config.get('server', {}).get('zips', {}) if runtime_config else {}
    if not zips.get('enabled', True):
        raise ZipsConfigurationError('ZIPS integration is disabled')
    if not zips.get('userId') or not zips.get('password') or not zips.get('serviceId'):
        raise ZipsConfigurationError('ZIPS credentials are not configured')
    return zips


def _login(zips_config: Dict[str, Any]) -> Dict[str, Any]:
    params = {
        'user_id': zips_config['userId'],
        'password': zips_config['password'],
        'service_id': zips_config['serviceId'],
        'device_flag': str(zips_config.get('deviceFlag', 1)),
    }
    try:
        response = requests.get(f'{ZIPS_BASE_URL}/auth/login', params=params, timeout=15)
    except requests.RequestException as exc:
        raise ZipsProxyError(f'ZIPS login failed: {exc}') from exc
    if response.status_code != 200:
        raise ZipsProxyError(f'ZIPS login failed: HTTP {response.status_code}')
    payload = response.json()
    if payload.get('status', {}).get('code') != '10100000':
        code = payload.get('status', {}).get('code', 'unknown')
        text = payload.get('status', {}).get('text')
        raise ZipsProxyError(f'ZIPS login failed: {code}{f" ({text})" if text else ""}')
    result = payload.get('result') or {}
    return {
        'kid': result.get('kid'),
        'aid': result.get('aid'),
        'funcs': (result.get('items') or {}).get('func') or [],
    }


def _get_session(zips_config: Dict[str, Any]) -> Dict[str, Any]:
    global _cached_session, _cached_at
    if _cached_session and (time.time() - _cached_at) < SESSION_TTL_SECONDS:
        return _cached_session
    _cached_session = _login(zips_config)
    _cached_at = time.time()
    return _cached_session


def _invalidate_session() -> None:
    global _cached_session, _cached_at
    _cached_session = None
    _cached_at = 0.0


def _build_lmtinf(funcs: list[Dict[str, Any]], func_name: str) -> str:
    meta = FUNC_DATA.get(func_name)
    if not meta:
        raise ZipsProxyError(f'Unknown ZIPS function: {func_name}')
    for item in funcs:
        if item.get('id') == meta['id'] and item.get('subid') == meta['subid']:
            return f"{item.get('areaCode')},{item.get('funcInfo')}"
    raise ZipsProxyError(f'Function not available: {func_name}')


def _request_json(url: str) -> Dict[str, Any]:
    try:
        response = requests.get(url, timeout=20)
    except requests.RequestException as exc:
        raise ZipsProxyError(f'ZIPS request failed: {exc}') from exc
    if response.status_code in {401, 403}:
        _invalidate_session()
    if response.status_code != 200:
        raise ZipsProxyError(f'ZIPS request failed: HTTP {response.status_code}')
    return response.json()


def _extract_bluemap_result(payload: Dict[str, Any]) -> Dict[str, Any]:
    items = ((payload.get('result') or {}).get('item') or [])
    item = items[0] if items else {}
    bluemap = item.get('bluemap') or item.get('bluemap_address') or item.get('bluemapAddress') or item.get('bm_address')
    position = None
    bluemap_address = None
    if isinstance(bluemap, list) and bluemap:
        first = bluemap[0] or {}
        bluemap_address = (
            first.get('bluemap_address')
            or first.get('bm_address')
            or first.get('address')
            or (first if isinstance(first, str) else None)
        )
        position = first.get('position') or first.get('match_position')
    elif isinstance(bluemap, str):
        bluemap_address = bluemap
    position = position or item.get('position') or item.get('match_position')
    latlng = None
    if isinstance(position, list) and len(position) >= 2:
        try:
            latlng = {'lng': float(position[0]), 'lat': float(position[1])}
        except (TypeError, ValueError):
            latlng = None
    return {'bluemapAddress': bluemap_address, 'position': latlng, 'raw': payload}


def _extract_address_result(payload: Dict[str, Any]) -> Dict[str, Any]:
    items = ((payload.get('result') or {}).get('item') or [])
    item = items[0] if items else {}
    address = item.get('address') or item.get('addr') or item.get('jyusho') or item.get('address_full')
    position = item.get('position') or item.get('match_position')
    latlng = None
    if isinstance(position, list) and len(position) >= 2:
        try:
            latlng = {'lng': float(position[0]), 'lat': float(position[1])}
        except (TypeError, ValueError):
            latlng = None
    return {'address': address, 'position': latlng, 'raw': payload}


def address_to_bluemap(address: str, runtime_config: Dict[str, Any]) -> Dict[str, Any]:
    query = (address or '').strip()
    if not query:
        raise ZipsProxyError('address is empty')
    zips_config = _get_zips_config(runtime_config)
    session = _get_session(zips_config)
    lmtinf = _build_lmtinf(session['funcs'], 'address_to_bluemap')
    url = (
        f'{ZIPS_BASE_URL}/zips/general/address_to_bluemap?'
        f'zis_zips_authkey={requests.utils.quote(session["kid"], safe="")}&'
        f'zis_authtype=aid&'
        f'zis_aid={requests.utils.quote(session["aid"], safe="")}&'
        f'zis_lmtinf={lmtinf}&'
        f'address={requests.utils.quote(query, safe="")}&'
        f'datum=JGD'
    )
    payload = _request_json(url)
    if payload.get('status') != 'OK':
        raise ZipsProxyError(f'ZIPS address_to_bluemap failed: {payload.get("status")}')
    return _extract_bluemap_result(payload)


def bluemap_to_address(bluemap: str, runtime_config: Dict[str, Any]) -> Dict[str, Any]:
    query = (bluemap or '').strip()
    if not query:
        raise ZipsProxyError('bluemap is empty')
    zips_config = _get_zips_config(runtime_config)
    session = _get_session(zips_config)
    lmtinf = _build_lmtinf(session['funcs'], 'bluemap_to_address')
    url = (
        f'{ZIPS_BASE_URL}/zips/general/bluemap_to_address?'
        f'zis_zips_authkey={requests.utils.quote(session["kid"], safe="")}&'
        f'zis_authtype=aid&'
        f'zis_aid={requests.utils.quote(session["aid"], safe="")}&'
        f'zis_lmtinf={lmtinf}&'
        f'bluemap_address={requests.utils.quote(query, safe="")}&'
        f'datum=JGD'
    )
    payload = _request_json(url)
    if payload.get('status') != 'OK':
        raise ZipsProxyError(f'ZIPS bluemap_to_address failed: {payload.get("status")}')
    return _extract_address_result(payload)
