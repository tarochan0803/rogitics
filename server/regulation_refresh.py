"""Bounded, auditable regulation refreshes from fixed upstreams."""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Optional, Tuple
from urllib import error, parse, request

SCHEMA_VERSION = 1
OVERPASS_QUERY_VERSION = 2
OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
# Fixed official reference only; changed text is flagged for review, never parsed as rules.
NPA_SPEC_URL = "https://www.npa.go.jp/bureau/traffic/seibi2/kisei/mokuteki/mokuteki.html"
JARTIC_OPEN_DATA_URL = "https://www.jartic.or.jp/service/opendata/"
JARTIC_CATALOG_URL = "https://www.jartic.or.jp/d/opendata/opendata.json"
JARTIC_CATALOG_MONITOR_VERSION = 1
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RUNTIME_DIR = PROJECT_ROOT / "runtime" / "regulations"


class RegulationInputError(ValueError):
    pass


class RegulationFetchError(RuntimeError):
    pass


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Optional[datetime] = None) -> str:
    return (value or _utc_now()).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_time(value: Any) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def validate_bbox(value: Any, *, max_area_km2: Optional[float] = None) -> Tuple[float, float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise RegulationInputError("bbox must be an array of four numbers: [west, south, east, north]")
    try:
        west, south, east, north = (float(item) for item in value)
    except (TypeError, ValueError) as exc:
        raise RegulationInputError("bbox values must be finite numbers") from exc
    if not all(math.isfinite(item) for item in (west, south, east, north)):
        raise RegulationInputError("bbox values must be finite numbers")
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise RegulationInputError("bbox must be ordered W,S,E,N within longitude/latitude limits")
    mean_lat = math.radians((south + north) / 2)
    area_km2 = (east - west) * 111.32 * max(math.cos(mean_lat), 0.01) * (north - south) * 110.57
    allowed = max_area_km2 if max_area_km2 is not None else float(_env_int("REGULATION_MAX_BBOX_AREA_KM2", 250))
    if area_km2 > allowed:
        raise RegulationInputError(f"bbox area exceeds the {allowed:g} km2 limit")
    return west, south, east, north


def _bbox_id(bbox: Tuple[float, float, float, float]) -> str:
    text = ",".join(f"{number:.6f}" for number in bbox)
    return hashlib.sha256(text.encode("ascii")).hexdigest()[:20]


def _overpass_query(bbox: Tuple[float, float, float, float]) -> str:
    west, south, east, north = bbox
    box = f"{south:.6f},{west:.6f},{north:.6f},{east:.6f}"
    return (
        "[out:json][timeout:25];\n(\n"
        f'  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|track)$"]["area"!~"yes"]({box});\n'
        f'  node["traffic_sign"~"^JP:3"]({box});\n'
        f'  node["barrier"]({box});\n'
        f'  node["highway"~"^(stop|give_way)$"]({box});\n'
        f'  relation["type"~"^restriction"]({box});\n'
        ");\nout meta geom;"
    )


class _NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


def _default_fetch(url: str, method: str, data: Optional[bytes], timeout: float, max_bytes: int) -> Tuple[bytes, Dict[str, str]]:
    headers = {"Accept": "application/json, text/html;q=0.9, */*;q=0.1", "User-Agent": "LOGISTICS-OS-regulation-refresh/1"}
    if data:
        headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8"
    req = request.Request(url, data=data, method=method, headers=headers)
    try:
        with request.build_opener(_NoRedirect()).open(req, timeout=timeout) as response:
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > max_bytes:
                raise RegulationFetchError("upstream response exceeds configured size limit")
            chunks = []
            size = 0
            while True:
                chunk = response.read(min(65536, max_bytes + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > max_bytes:
                    raise RegulationFetchError("upstream response exceeds configured size limit")
            return b"".join(chunks), dict(response.headers.items())
    except RegulationFetchError:
        raise
    except (error.HTTPError, error.URLError, OSError, ValueError) as exc:
        raise RegulationFetchError(f"upstream request failed: {exc}") from exc


class RegulationRefreshService:
    """Dynamic AOI registry with atomic last-known-good payload writes."""

    def __init__(self, runtime_dir: Path | str = DEFAULT_RUNTIME_DIR, *, fetch: Callable[[str, str, Optional[bytes], float, int], Any] = _default_fetch, now: Callable[[], datetime] = _utc_now) -> None:
        self.runtime_dir = Path(runtime_dir)
        self.index_path = self.runtime_dir / "index.json"
        self.audit_path = self.runtime_dir / "audit.jsonl"
        self.fetch, self.now = fetch, now
        self.osm_refresh_seconds = _env_int("REGULATION_OSM_REFRESH_SECONDS", 15 * 60)
        self.osm_stale_seconds = _env_int("REGULATION_OSM_STALE_SECONDS", 6 * 60 * 60)
        self.osm_expired_seconds = _env_int("REGULATION_OSM_EXPIRED_SECONDS", 72 * 60 * 60)
        self.npa_refresh_seconds = _env_int("REGULATION_NPA_REFRESH_SECONDS", 24 * 60 * 60)
        self.jartic_refresh_seconds = _env_int("REGULATION_JARTIC_REFRESH_SECONDS", 24 * 60 * 60)
        self.timeout_seconds = _env_int("REGULATION_FETCH_TIMEOUT_SECONDS", 30)
        self.max_response_bytes = _env_int("REGULATION_MAX_RESPONSE_BYTES", 8 * 1024 * 1024)
        self.max_area_km2 = float(_env_int("REGULATION_MAX_BBOX_AREA_KM2", 250))
        self._lock, self._refresh_lock = threading.RLock(), threading.Lock()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def _empty_index(self) -> Dict[str, Any]:
        return {"schemaVersion": SCHEMA_VERSION, "aois": {}, "npaSpec": {}}

    def _load_index(self) -> Dict[str, Any]:
        if not self.index_path.exists():
            return self._empty_index()
        try:
            result = json.loads(self.index_path.read_text(encoding="utf-8"))
            if isinstance(result, dict) and isinstance(result.get("aois"), dict):
                result.setdefault("schemaVersion", SCHEMA_VERSION)
                result.setdefault("npaSpec", {})
                return result
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        return self._empty_index()

    def _atomic_write(self, path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            try:
                directory_fd = os.open(str(path.parent), os.O_DIRECTORY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except (AttributeError, OSError):
                pass
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _save_index(self, index: Dict[str, Any]) -> None:
        self._atomic_write(self.index_path, json.dumps(index, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))

    def _audit(self, event: str, **details: Any) -> None:
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        line = json.dumps({"at": _iso(self.now()), "event": event, **details}, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
        with self.audit_path.open("a", encoding="utf-8") as handle:
            handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())

    @staticmethod
    def _error(exc: BaseException) -> str:
        return str(exc).replace("\n", " ")[:300] or exc.__class__.__name__

    def _due(self, metadata: Dict[str, Any], interval: int, force: bool) -> bool:
        checked = _parse_time(metadata.get("checkedAt"))
        return force or checked is None or (self.now() - checked).total_seconds() >= interval

    def _request(self, url: str, method: str, data: Optional[bytes] = None) -> Tuple[bytes, Dict[str, str]]:
        """Normalize test fetchers while retaining HTTP metadata from the real client."""
        result = self.fetch(url, method, data, self.timeout_seconds, self.max_response_bytes)
        if isinstance(result, tuple) and len(result) == 2:
            payload, headers = result
            if isinstance(payload, bytes) and isinstance(headers, dict):
                return payload, {str(key).lower(): str(value) for key, value in headers.items()}
        if isinstance(result, bytes):
            return result, {}
        raise RegulationFetchError("upstream fetcher returned an invalid response")

    def _register_aoi(self, index: Dict[str, Any], bbox: Tuple[float, float, float, float]) -> Tuple[str, Dict[str, Any]]:
        key = _bbox_id(bbox)
        if key not in index["aois"]:
            index["aois"][key] = {"bbox": list(bbox), "registeredAt": _iso(self.now()), "osm": {}}
            self._audit("aoi_registered", aoi=key, bbox=list(bbox))
        return key, index["aois"][key]

    def _refresh_osm(self, key: str, aoi: Dict[str, Any], force: bool) -> list[Dict[str, Any]]:
        metadata = aoi.setdefault("osm", {})
        force = force or metadata.get("queryVersion") != OVERPASS_QUERY_VERSION
        if not self._due(metadata, self.osm_refresh_seconds, force):
            return []
        body = parse.urlencode({"data": _overpass_query(tuple(aoi["bbox"]))}).encode("utf-8")
        attempts: list[Dict[str, Any]] = []
        for endpoint in OVERPASS_ENDPOINTS:
            try:
                payload, _ = self._request(endpoint, "POST", body)
                decoded = json.loads(payload.decode("utf-8"))
                if not isinstance(decoded, dict) or not isinstance(decoded.get("elements", []), list):
                    raise RegulationFetchError("Overpass response is not OSM JSON")
                # A new content-addressed file is written before the atomically
                # replaced index points at it, preserving a coherent LKG snapshot.
                filename = f"osm-{key}-{hashlib.sha256(payload).hexdigest()}.json"
                self._atomic_write(self.runtime_dir / filename, payload)
                metadata.update({
                    "checkedAt": _iso(self.now()),
                    "lastSuccessAt": _iso(self.now()),
                    "sourceUpdatedAt": decoded.get("osm3s", {}).get("timestamp_osm_base"),
                    "dataFile": filename,
                    "sha256": hashlib.sha256(payload).hexdigest(),
                    "elementCount": len(decoded["elements"]),
                    "lastEndpoint": endpoint,
                    "lastError": None,
                    "queryVersion": OVERPASS_QUERY_VERSION,
                })
                self._prune_osm_snapshots(key, keep={filename})
                attempts.append({"endpoint": endpoint, "ok": True})
                self._audit("osm_refresh_succeeded", aoi=key, endpoint=endpoint, elements=len(decoded["elements"]))
                return attempts
            except Exception as exc:
                attempts.append({"endpoint": endpoint, "ok": False, "error": self._error(exc)})
        metadata["checkedAt"] = _iso(self.now())
        metadata["lastError"] = {"at": _iso(self.now()), "message": attempts[-1]["error"]}
        self._audit("osm_refresh_failed", aoi=key, attempts=attempts)
        return attempts

    def _prune_osm_snapshots(self, key: str, keep: set[str], retain: int = 3) -> None:
        candidates = sorted(
            self.runtime_dir.glob(f"osm-{key}-*.json"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        retained = 0
        for path in candidates:
            if path.name in keep or retained < retain:
                retained += 1
                continue
            try:
                path.unlink()
            except OSError:
                pass

    def _load_osm_snapshot(self, aoi: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        filename = aoi.get("osm", {}).get("dataFile")
        if not isinstance(filename, str) or Path(filename).name != filename:
            return None
        path = self.runtime_dir / filename
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
            return None
        return payload

    def _refresh_npa(self, index: Dict[str, Any], force: bool) -> None:
        metadata = index.setdefault("npaSpec", {})
        if not self._due(metadata, self.npa_refresh_seconds, force):
            return
        try:
            payload, _ = self._request(NPA_SPEC_URL, "GET")
            digest, previous = hashlib.sha256(payload).hexdigest(), metadata.get("sha256")
            if digest != previous:
                filename = f"npa-spec-{digest}.html"
                self._atomic_write(self.runtime_dir / filename, payload)
                metadata["dataFile"] = filename
            metadata.update({"checkedAt": _iso(self.now()), "lastSuccessAt": _iso(self.now()), "sha256": digest, "lastError": None})
            if previous and previous != digest:
                metadata.update({"previousSha256": previous, "reviewRequired": True})
                self._audit("npa_spec_changed", previousSha256=previous, sha256=digest, url=NPA_SPEC_URL)
            else:
                metadata.setdefault("reviewRequired", False)
                self._audit("npa_spec_checked", changed=False, sha256=digest, url=NPA_SPEC_URL)
        except Exception as exc:
            metadata.update({"checkedAt": _iso(self.now()), "lastError": {"at": _iso(self.now()), "message": self._error(exc)}})
            self._audit("npa_spec_failed", error=metadata["lastError"]["message"], url=NPA_SPEC_URL)

    def _refresh_jartic(self, index: Dict[str, Any], force: bool) -> None:
        """Monitor the public catalog only; no contract-only traffic feed is assumed."""
        metadata = index.setdefault("jarticOpenData", {})
        if not self._due(metadata, self.jartic_refresh_seconds, force):
            return
        try:
            payload, headers = self._request(JARTIC_CATALOG_URL, "GET")
            catalog = json.loads(payload.decode("utf-8"))
            type_d = next((item for item in catalog if isinstance(item, dict) and item.get("type") == "typeD"), None)
            if not isinstance(type_d, dict) or not isinstance(type_d.get("targetList"), list):
                raise RegulationFetchError("JARTIC open-data catalog has no typeD dataset")
            digest = hashlib.sha256(payload).hexdigest()
            same_monitor = metadata.get("monitorVersion") == JARTIC_CATALOG_MONITOR_VERSION
            previous = metadata.get("pageHash") if same_monitor else None
            filename = f"jartic-catalog-{digest}.json"
            self._atomic_write(self.runtime_dir / filename, payload)
            metadata.update({
                "checkedAt": _iso(self.now()),
                "lastSuccessAt": _iso(self.now()),
                "pageHash": digest,
                "dataFile": filename,
                "lastModified": headers.get("last-modified"),
                "sourceUrl": JARTIC_OPEN_DATA_URL,
                "catalogUrl": JARTIC_CATALOG_URL,
                "targetMonth": type_d.get("targetMonth"),
                "releaseDay": type_d.get("releaseDay"),
                "artifactCount": len(type_d["targetList"]),
                "monitorVersion": JARTIC_CATALOG_MONITOR_VERSION,
                "lastError": None,
                "notConfigured": True,
                "dataStatus": "catalogAvailable",
            })
            metadata["changeDetected"] = bool(previous and previous != digest)
            if previous and previous != digest:
                metadata.update({"previousPageHash": previous, "reviewRequired": True})
                self._audit("jartic_open_data_changed", previousPageHash=previous, pageHash=digest, targetMonth=type_d.get("targetMonth"), releaseDay=type_d.get("releaseDay"), url=JARTIC_CATALOG_URL)
            else:
                if not same_monitor:
                    metadata["reviewRequired"] = False
                    metadata.pop("previousPageHash", None)
                else:
                    metadata.setdefault("reviewRequired", False)
                self._audit("jartic_open_data_checked", changed=False, pageHash=digest, targetMonth=type_d.get("targetMonth"), releaseDay=type_d.get("releaseDay"), url=JARTIC_CATALOG_URL)
        except Exception as exc:
            metadata.update({
                "checkedAt": _iso(self.now()),
                "lastError": {"at": _iso(self.now()), "message": self._error(exc)},
                "sourceUrl": JARTIC_OPEN_DATA_URL,
                "notConfigured": True,
                "dataStatus": "notConfigured",
            })
            self._audit("jartic_open_data_failed", error=metadata["lastError"]["message"], url=JARTIC_CATALOG_URL)

    def _source_view(self, metadata: Dict[str, Any], stale_after: Optional[int], expired_after: Optional[int]) -> Dict[str, Any]:
        success, error_info = _parse_time(metadata.get("lastSuccessAt")), metadata.get("lastError")
        if success is None:
            freshness, age = "missing", None
        else:
            age = max(0, int((self.now() - success).total_seconds()))
            freshness = "expired" if expired_after is not None and age >= expired_after else "stale" if stale_after is not None and age >= stale_after else "fresh"
        state = (
            "error" if isinstance(error_info, dict)
            else "stale" if metadata.get("reviewRequired") or metadata.get("notConfigured")
            else freshness
        )
        view: Dict[str, Any] = {
            "state": state,
            "freshness": freshness,
            "checkedAt": metadata.get("checkedAt"),
            "lastSuccessAt": metadata.get("lastSuccessAt"),
            "fetchedAt": metadata.get("lastSuccessAt"),
            "ageSeconds": age,
            "stale": freshness == "stale",
            "expired": freshness == "expired",
            "hasLastKnownGood": success is not None,
            "error": error_info.get("message") if isinstance(error_info, dict) else None,
        }
        for field in ("sha256", "elementCount", "lastEndpoint", "queryVersion", "sourceUpdatedAt", "previousSha256", "pageHash", "previousPageHash", "lastModified", "sourceUrl", "catalogUrl", "targetMonth", "releaseDay", "artifactCount", "changeDetected", "notConfigured", "dataStatus"):
            if field in metadata:
                view[field] = metadata[field]
        if "reviewRequired" in metadata:
            view["reviewRequired"] = bool(metadata["reviewRequired"])
        if "elementCount" in metadata:
            view["featureCount"] = metadata["elementCount"]
        return view

    @staticmethod
    def _overall(sources: Iterable[Dict[str, Any]]) -> str:
        items = list(sources)
        if any(item["freshness"] == "missing" for item in items): return "error"
        if any(item["freshness"] == "expired" for item in items): return "expired"
        if any(item["state"] == "error" for item in items): return "error"
        if any(item.get("reviewRequired") for item in items): return "stale"
        if any(item["state"] == "stale" for item in items): return "stale"
        if any(item["freshness"] == "stale" for item in items): return "stale"
        return "fresh"

    def _response(self, index: Dict[str, Any], key: str, include_snapshot: bool = False, attempts: Optional[list[Dict[str, Any]]] = None) -> Dict[str, Any]:
        osm = self._source_view(index["aois"][key].get("osm", {}), self.osm_stale_seconds, self.osm_expired_seconds)
        npa = self._source_view(index.get("npaSpec", {}), self.npa_refresh_seconds * 2, self.npa_refresh_seconds * 7)
        jartic_metadata = dict(index.get("jarticOpenData", {}))
        jartic_metadata.setdefault("sourceUrl", JARTIC_OPEN_DATA_URL)
        jartic_metadata.setdefault("notConfigured", True)
        jartic_metadata.setdefault("dataStatus", "notConfigured")
        jartic_metadata.setdefault("changeDetected", False)
        jartic_metadata.setdefault("reviewRequired", False)
        jartic = self._source_view(jartic_metadata, self.jartic_refresh_seconds * 2, self.jartic_refresh_seconds * 7)
        j_system = {
            "state": "not_configured",
            "freshness": "missing",
            "configured": False,
            "dataStatus": "notConfigured",
            "sourceUrl": "https://www.jartic.or.jp/s/service/forcorporation/forcorporation01/",
            "error": None,
        }
        result: Dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "overall": self._overall((osm, npa, jartic)),
            "checkedAt": _iso(self.now()),
            "sources": {
                "osm": osm,
                "npaSpec": npa,
                "jarticOpenData": jartic,
                "jarticJSystem": j_system,
            },
        }
        if attempts is not None:
            result["refreshAttempts"] = attempts
        if include_snapshot:
            result["overpass"] = self._load_osm_snapshot(index["aois"][key])
        return result

    def refresh(self, bbox: Any, force: bool = False) -> Dict[str, Any]:
        if not isinstance(force, bool):
            raise RegulationInputError("force must be a boolean")
        normalized = validate_bbox(bbox, max_area_km2=self.max_area_km2)
        with self._refresh_lock, self._lock:
            index = self._load_index()
            key, aoi = self._register_aoi(index, normalized)
            self._refresh_npa(index, force)
            self._refresh_jartic(index, force)
            attempts = self._refresh_osm(key, aoi, force)
            self._save_index(index)
            return self._response(index, key, include_snapshot=True, attempts=attempts)

    def status(self, bbox: Any) -> Dict[str, Any]:
        normalized = validate_bbox(bbox, max_area_km2=self.max_area_km2)
        key = _bbox_id(normalized)
        with self._lock:
            index = self._load_index()
            if key not in index["aois"]:
                index["aois"][key] = {"bbox": list(normalized), "osm": {}}
            return self._response(index, key)

    def run_scheduled_once(self) -> None:
        with self._refresh_lock, self._lock:
            index = self._load_index()
            self._refresh_npa(index, False)
            self._refresh_jartic(index, False)
            for key, aoi in index.get("aois", {}).items():
                if self._due(aoi.get("osm", {}), self.osm_refresh_seconds, False):
                    self._refresh_osm(key, aoi, False)
            if index.get("aois") or index.get("npaSpec"):
                self._save_index(index)

    def start_background(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive(): return
            self._stop_event.clear()
            poll = _env_int("REGULATION_BACKGROUND_POLL_SECONDS", 60, 5)
            def worker() -> None:
                while not self._stop_event.is_set():
                    try: self.run_scheduled_once()
                    except Exception as exc: self._audit("scheduler_failed", error=self._error(exc))
                    self._stop_event.wait(poll)
            self._thread = threading.Thread(target=worker, name="regulation-refresh", daemon=True)
            self._thread.start()

    def stop_background(self) -> None:
        self._stop_event.set()
        if self._thread: self._thread.join(timeout=2)
