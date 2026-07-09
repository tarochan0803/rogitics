import json
import os
import re
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_DIR = BASE_DIR / 'config'
RUNTIME_CONFIG_PATH = Path(os.getenv('LOGISTICS_RUNTIME_CONFIG', CONFIG_DIR / 'runtime.local.json'))
LEGACY_USER_CONFIG_PATH = BASE_DIR / 'user_config.js'

DEFAULT_RUNTIME_CONFIG: Dict[str, Any] = {
    'public': {
        'googleMapsApiKey': '',
        'yoloServerUrl': '',
        'remoteVoxelServerUrl': '',
        'defaultDriverSkill': 1.0,
        'companyName': '',
        'reporterName': '',
    },
    'server': {
        'host': '127.0.0.1',
        'webPort': 8080,
        'yoloPort': 8001,
        'allowedOrigins': [],
        'zips': {
            'enabled': True,
            'userId': '',
            'password': '',
            'serviceId': '50000001',
            'deviceFlag': 1,
        },
    },
}


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def _read_json_file(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def _legacy_string_value(text: str, key: str) -> str:
    match = re.search(rf'{re.escape(key)}\s*:\s*[\'"]([^\'"]*)[\'"]', text)
    return match.group(1).strip() if match else ''


def _legacy_number_value(text: str, key: str, fallback: float) -> float:
    match = re.search(rf'{re.escape(key)}\s*:\s*([0-9]+(?:\.[0-9]+)?)', text)
    if not match:
        return fallback
    try:
        return float(match.group(1))
    except ValueError:
        return fallback


def _load_legacy_user_config() -> Dict[str, Any]:
    if not LEGACY_USER_CONFIG_PATH.exists():
        return {}
    try:
        text = LEGACY_USER_CONFIG_PATH.read_text(encoding='utf-8', errors='ignore')
    except Exception:
        return {}

    return {
        'public': {
            'googleMapsApiKey': _legacy_string_value(text, 'googleMapsApiKey'),
            'yoloServerUrl': _legacy_string_value(text, 'yoloServerUrl'),
            'remoteVoxelServerUrl': _legacy_string_value(text, 'remoteVoxelServerUrl'),
            'defaultDriverSkill': _legacy_number_value(text, 'defaultDriverSkill', 1.0),
            'companyName': _legacy_string_value(text, 'companyName'),
            'reporterName': _legacy_string_value(text, 'reporterName'),
        },
        'server': {
            'zips': {
                'userId': _legacy_string_value(text, 'zipsUserId'),
                'password': _legacy_string_value(text, 'zipsPassword'),
                'serviceId': '50000001',
                'deviceFlag': 1,
            }
        },
    }


def _env_str(name: str, fallback: str = '') -> str:
    value = os.getenv(name)
    if value is None:
        return fallback
    return value.strip()


def _env_int(name: str, fallback: int) -> int:
    raw = _env_str(name, '')
    if not raw:
        return fallback
    try:
        return int(raw)
    except ValueError:
        return fallback


def _env_float(name: str, fallback: float) -> float:
    raw = _env_str(name, '')
    if not raw:
        return fallback
    try:
        return float(raw)
    except ValueError:
        return fallback


def _env_bool(name: str, fallback: bool) -> bool:
    raw = _env_str(name, '')
    if not raw:
        return fallback
    return raw.lower() in {'1', 'true', 'yes', 'on'}


def load_runtime_settings() -> Dict[str, Any]:
    config = deepcopy(DEFAULT_RUNTIME_CONFIG)
    _deep_merge(config, _load_legacy_user_config())
    _deep_merge(config, _read_json_file(RUNTIME_CONFIG_PATH))

    public = config['public']
    server = config['server']
    zips = server['zips']

    public['googleMapsApiKey'] = _env_str('LOGISTICS_PUBLIC_GOOGLE_MAPS_API_KEY', public['googleMapsApiKey'])
    public['yoloServerUrl'] = _env_str('LOGISTICS_PUBLIC_YOLO_URL', public['yoloServerUrl'])
    public['remoteVoxelServerUrl'] = _env_str('LOGISTICS_PUBLIC_REMOTE_VOXEL_URL', public.get('remoteVoxelServerUrl', ''))
    public['companyName'] = _env_str('LOGISTICS_PUBLIC_COMPANY_NAME', public['companyName'])
    public['reporterName'] = _env_str('LOGISTICS_PUBLIC_REPORTER_NAME', public['reporterName'])
    public['defaultDriverSkill'] = _env_float('LOGISTICS_DEFAULT_DRIVER_SKILL', public['defaultDriverSkill'])

    server['host'] = _env_str('LOGISTICS_HOST', server['host'])
    server['webPort'] = _env_int('WEB_PORT', server['webPort'])
    server['yoloPort'] = _env_int('YOLO_PORT', server['yoloPort'])

    allowed_origins = _env_str('LOGISTICS_ALLOWED_ORIGINS', '')
    if allowed_origins:
        if allowed_origins == '*':
            server['allowedOrigins'] = ['*']
        else:
            server['allowedOrigins'] = [item.strip() for item in allowed_origins.split(',') if item.strip()]

    zips['enabled'] = _env_bool('LOGISTICS_ZIPS_ENABLED', bool(zips.get('enabled', True)))
    zips['userId'] = _env_str('ZIPS_USER_ID', zips.get('userId', ''))
    zips['password'] = _env_str('ZIPS_PASSWORD', zips.get('password', ''))
    zips['serviceId'] = _env_str('ZIPS_SERVICE_ID', zips.get('serviceId', '50000001')) or '50000001'
    zips['deviceFlag'] = _env_int('ZIPS_DEVICE_FLAG', int(zips.get('deviceFlag', 1) or 1))

    public['zipsEnabled'] = is_zips_enabled(config)
    return config


def is_zips_enabled(config: Dict[str, Any] | None = None) -> bool:
    cfg = config or load_runtime_settings()
    zips = cfg.get('server', {}).get('zips', {})
    if not zips.get('enabled', True):
        return False
    return bool(zips.get('userId') and zips.get('password') and zips.get('serviceId'))


def get_public_runtime_config() -> Dict[str, Any]:
    cfg = load_runtime_settings()
    public = cfg['public']
    remote_voxel_url = public.get('remoteVoxelServerUrl', '') or public.get('yoloServerUrl', '')
    return {
        'googleMapsApiKey': public.get('googleMapsApiKey', ''),
        'yoloServerUrl': public.get('yoloServerUrl', ''),
        'remoteVoxelServerUrl': remote_voxel_url,
        'defaultDriverSkill': public.get('defaultDriverSkill', 1.0),
        'companyName': public.get('companyName', ''),
        'reporterName': public.get('reporterName', ''),
        'zipsEnabled': is_zips_enabled(cfg),
    }


def get_allowed_origins(default_port: int = 8080) -> list[str]:
    cfg = load_runtime_settings()
    server = cfg['server']
    allowed = server.get('allowedOrigins') or []
    if allowed:
        return allowed
    port = int(server.get('webPort') or default_port or 8080)
    return [
        f'http://127.0.0.1:{port}',
        f'http://localhost:{port}',
    ]
