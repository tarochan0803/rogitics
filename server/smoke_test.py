import json
import os
import subprocess
import sys
import time
from urllib import error, request


def get_json(url: str, timeout: float = 5.0):
    req = request.Request(url)
    with request.urlopen(req, timeout=timeout) as res:
        body = res.read().decode('utf-8', 'replace')
        return res.status, json.loads(body)


def post_json(url: str, payload: dict, timeout: float = 120.0):
    data = json.dumps(payload).encode('utf-8')
    req = request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    with request.urlopen(req, timeout=timeout) as res:
        body = res.read().decode('utf-8', 'replace')
        return res.status, json.loads(body)


def wait_healthy(base_url: str, deadline_sec: float = 90.0):
    start = time.time()
    while time.time() - start < deadline_sec:
        try:
            status, body = get_json(f'{base_url}/health', timeout=2.0)
            if status == 200 and body.get('status') == 'ok':
                return body
        except Exception:
            pass
        time.sleep(1.0)
    raise RuntimeError('server did not become healthy in time')


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    env = os.environ.copy()
    env.setdefault('PORT', '8011')
    port = env['PORT']
    base_url = f'http://127.0.0.1:{port}'

    proc = subprocess.Popen(
        [sys.executable, os.path.join('server', 'app.py')],
        cwd=root,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    try:
        health = wait_healthy(base_url)
        print('[OK] /health', health)

        status, body = get_json(f'{base_url}/status')
        print('[OK] /status', status, body)

        sample = {'image_url': 'https://ultralytics.com/images/bus.jpg', 'conf': 0.25, 'iou': 0.45}
        status, body = post_json(f'{base_url}/detect', sample)
        print('[OK] /detect', status, 'count=', body.get('count'))

        status, body = post_json(f'{base_url}/segment', sample)
        print('[OK] /segment', status, 'count=', body.get('count'))

        batch = {
            'items': [
                {'id': 'a', 'image_url': 'https://ultralytics.com/images/bus.jpg'},
                {'id': 'b', 'image_url': 'https://ultralytics.com/images/zidane.jpg'},
            ]
        }
        status, body = post_json(f'{base_url}/detect-batch', batch)
        print('[OK] /detect-batch', status, 'items=', len(body.get('items') or []))

        status, body = post_json(f'{base_url}/segment-batch', batch)
        print('[OK] /segment-batch', status, 'items=', len(body.get('items') or []))

        print('\nSmoke test passed.')
        return 0
    except error.HTTPError as exc:
        payload = exc.read().decode('utf-8', 'replace')
        print(f'[FAIL] HTTP {exc.code}: {payload}')
        return 1
    except Exception as exc:
        print(f'[FAIL] {exc}')
        if proc.stdout:
            try:
                out = proc.stdout.read()
                if out:
                    print(out[-2000:])
            except Exception:
                pass
        return 1
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


if __name__ == '__main__':
    raise SystemExit(main())
