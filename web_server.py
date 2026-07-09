"""
Static web server for LOGISTICS OS.

Adds:
- GET  /api/status
- POST /api/start-yolo
- GET  /runtime-config.js
- POST /api/zips/address-to-bluemap
- POST /api/zips/bluemap-to-address
"""

import json
import os
import socket
import subprocess
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler

try:
    from server.runtime_settings import get_allowed_origins, get_public_runtime_config, load_runtime_settings
    from server.zips_proxy import (
        ZipsConfigurationError,
        ZipsProxyError,
        address_to_bluemap,
        bluemap_to_address,
    )
except ImportError:
    from runtime_settings import get_allowed_origins, get_public_runtime_config, load_runtime_settings
    from zips_proxy import ZipsConfigurationError, ZipsProxyError, address_to_bluemap, bluemap_to_address


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(BASE_DIR, 'server')
DEFAULT_BIND_HOST = '127.0.0.1'
RUNTIME_SETTINGS = load_runtime_settings()

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(RUNTIME_SETTINGS['server']['webPort'])
YOLO_PORT = int(os.environ.get('YOLO_PORT', str(RUNTIME_SETTINGS['server']['yoloPort'])))
_yolo_proc: 'subprocess.Popen | None' = None


def _resolve_bind_host() -> str:
    host = os.environ.get('LOGISTICS_HOST', '').strip() or str(RUNTIME_SETTINGS['server'].get('host') or DEFAULT_BIND_HOST)
    if host[:1] in {'"', "'"} and host[-1:] == host[:1]:
        host = host[1:-1].strip()
    try:
        socket.getaddrinfo(host, PORT)
        return host
    except OSError:
        print(f'[Web] Invalid LOGISTICS_HOST={host!r}; fallback to {DEFAULT_BIND_HOST}')
        return DEFAULT_BIND_HOST


BIND_HOST = _resolve_bind_host()


def _port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, fmt, *args):
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_POST(self):
        if self.path == '/api/start-yolo':
            self._start_yolo()
            return
        if self.path == '/api/zips/address-to-bluemap':
            self._zips_address_to_bluemap()
            return
        if self.path == '/api/zips/bluemap-to-address':
            self._zips_bluemap_to_address()
            return
        self.send_error(404)

    def do_GET(self):
        if self.path == '/api/status':
            self._status()
            return
        if self.path == '/runtime-config.js':
            self._runtime_config_script()
            return
        if self.path == '/':
            self.send_response(301)
            self.send_header('Location', '/index8.2.html')
            self.end_headers()
            return
        super().do_GET()

    def _status(self):
        ok = _port_open('127.0.0.1', YOLO_PORT)
        self._json({'yolo': 'running' if ok else 'stopped'})

    def _runtime_config_script(self):
        config = get_public_runtime_config()
        body = (
            'window.LOGISTICS_RUNTIME_CONFIG = Object.assign('
            '{}'
            ', window.LOGISTICS_RUNTIME_CONFIG || {}, '
            + json.dumps(config, ensure_ascii=False)
            + ');'
        ).encode('utf-8')
        self._send_body(body, 'application/javascript; charset=utf-8')

    def _start_yolo(self):
        global _yolo_proc
        if _port_open('127.0.0.1', YOLO_PORT):
            self._json({'status': 'already-running'})
            return

        if _yolo_proc is not None and _yolo_proc.poll() is not None:
            _yolo_proc = None

        if _yolo_proc is None:
            try:
                kwargs: dict = {}
                if os.name == 'nt':
                    kwargs['creationflags'] = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                env = os.environ.copy()
                env.setdefault('PORT', str(YOLO_PORT))
                _yolo_proc = subprocess.Popen(
                    [sys.executable, 'app.py'],
                    cwd=SERVER_DIR,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    env=env,
                    **kwargs,
                )
            except Exception as exc:
                self._json({'status': 'error', 'error': str(exc)}, 500)
                return

        self._json({'status': 'starting', 'pid': _yolo_proc.pid})

    def _read_json_body(self) -> dict:
        try:
            length = int(self.headers.get('Content-Length', '0') or '0')
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b'{}'
        if not raw:
            return {}
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            raise ValueError('invalid JSON body')

    def _zips_address_to_bluemap(self):
        try:
            payload = self._read_json_body()
            result = address_to_bluemap(str(payload.get('address') or ''), load_runtime_settings())
            self._json(result)
        except ValueError as exc:
            self._json({'error': str(exc)}, 400)
        except ZipsConfigurationError as exc:
            self._json({'error': str(exc)}, 503)
        except ZipsProxyError as exc:
            self._json({'error': str(exc)}, 502)

    def _zips_bluemap_to_address(self):
        try:
            payload = self._read_json_body()
            result = bluemap_to_address(str(payload.get('bluemap') or ''), load_runtime_settings())
            self._json(result)
        except ValueError as exc:
            self._json({'error': str(exc)}, 400)
        except ZipsConfigurationError as exc:
            self._json({'error': str(exc)}, 503)
        except ZipsProxyError as exc:
            self._json({'error': str(exc)}, 502)

    def _cors_headers(self):
        origin = self.headers.get('Origin', '')
        allowed_origins = get_allowed_origins(PORT)
        if '*' in allowed_origins:
            self.send_header('Access-Control-Allow-Origin', '*')
        elif origin and origin in allowed_origins:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _send_body(self, body: bytes, content_type: str, code: int = 200):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data: dict, code: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self._send_body(body, 'application/json; charset=utf-8', code)


if __name__ == '__main__':
    os.chdir(BASE_DIR)
    httpd = HTTPServer((BIND_HOST, PORT), Handler)
    print(f'[Web] http://{BIND_HOST}:{PORT}/index8.2.html')
    httpd.serve_forever()
