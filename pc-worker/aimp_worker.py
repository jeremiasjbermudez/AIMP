"""AIMP's worker on the render host: things Flowise needs done on THAT machine.

Flowise may run on another computer (a Mac reaching a Windows GPU box over
Tailscale), so it cannot start a process or touch a file here. This small
service does, on request. Standard library only; any Python 3.9+ runs it.

What it does now:

  World ComfyUI, on demand. HY-World 2 needs a Python environment the main
  ComfyUI cannot share (it pins numpy below what the main one runs, and
  compiles its own CUDA extensions), so world graphs run on a second ComfyUI
  with its own environment. It is not left running: one GPU server at a time is
  how this machine is meant to be used. A flow asks for it, the main ComfyUI is
  told to unload its models, the world one is started and waited for, and it
  is stopped again once it has sat idle.

    POST /world/start   -> {"url": "http://<host>:8195"}, once it answers
    POST /world/stop
    GET  /world/status
    GET  /health

Every request needs `Authorization: Bearer <token>`, the token in the config.

Config: aimp-worker.json beside this file (or AIMP_WORKER_CONFIG):
  {
    "port": 8190,
    "token": "...",
    "main_comfy": "http://127.0.0.1:8188",
    "world": {
      "python": "C:/ComfyUI-server/venv-world/Scripts/python.exe",
      "args": ["C:/ComfyUI-server/ComfyUI-0.37.0/main.py", "--port", "8195", ...],
      "port": 8195,
      "public_host": "thelastofpc",
      "idle_minutes": 10,
      "log": "C:/ComfyUI-server/logs/world-comfy.log"
    }
  }
"""
import hmac
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get('AIMP_WORKER_CONFIG') or os.path.join(HERE, 'aimp-worker.json')
with open(CONFIG_PATH, encoding='utf-8') as f:
    CONFIG = json.load(f)
WORLD = CONFIG['world']
LOCK = threading.Lock()


def log(msg):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), msg, flush=True)


def http_json(method, url, body=None, timeout=5):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
        return json.loads(raw) if raw else {}


class World:
    """The on-demand ComfyUI: one process, started and stopped under LOCK."""

    def __init__(self):
        self.proc = None
        self.idle_since = None
        self.local = f"http://127.0.0.1:{WORLD['port']}"
        self.public = f"http://{WORLD.get('public_host', '127.0.0.1')}:{WORLD['port']}"

    def answering(self):
        try:
            http_json('GET', self.local + '/system_stats', timeout=3)
            return True
        except Exception:
            return False

    def busy(self):
        try:
            q = http_json('GET', self.local + '/queue', timeout=3)
            return bool(q.get('queue_running') or q.get('queue_pending'))
        except Exception:
            return False

    def start(self):
        with LOCK:
            self.idle_since = None
            ours = self.proc is not None and self.proc.poll() is None
            if self.answering():
                if ours:
                    return self.public
                # Something else holds the port - another ComfyUI this machine
                # runs, say. Using it would send world graphs to a server that
                # cannot run them; reporting it names the fix.
                raise RuntimeError(f"port {WORLD['port']} is already in use by another program; "
                                   'set a free port for the world ComfyUI in aimp-worker.json')
            # The GPU is shared. The main ComfyUI keeps models resident, and a
            # world build on top of them runs out of memory, so they go first.
            try:
                http_json('POST', CONFIG['main_comfy'].rstrip('/') + '/free',
                          {'unload_models': True, 'free_memory': True}, timeout=10)
                log('asked the main ComfyUI to unload its models')
            except Exception as e:
                log(f'could not ask the main ComfyUI to free memory: {e}')
            os.makedirs(os.path.dirname(WORLD['log']), exist_ok=True)
            out = open(WORLD['log'], 'ab')
            flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
            self.proc = subprocess.Popen([WORLD['python'], *WORLD['args']], stdout=out, stderr=subprocess.STDOUT,
                                         cwd=WORLD.get('cwd'), creationflags=flags)
            log(f'started world ComfyUI, pid {self.proc.pid}')
            deadline = time.time() + WORLD.get('start_timeout', 300)
            while time.time() < deadline:
                if self.proc.poll() is not None:
                    raise RuntimeError(f"world ComfyUI exited during start (code {self.proc.returncode}); see {WORLD['log']}")
                if self.answering():
                    log('world ComfyUI is answering')
                    return self.public
                time.sleep(2)
            self._kill()
            raise RuntimeError(f"world ComfyUI did not answer within {WORLD.get('start_timeout', 300)}s; see {WORLD['log']}")

    def _kill(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    def stop(self):
        with LOCK:
            was = self.proc is not None and self.proc.poll() is None
            self._kill()
            self.idle_since = None
            if was:
                log('stopped world ComfyUI')
            return was

    def status(self):
        running = self.proc is not None and self.proc.poll() is None
        return {'running': running, 'answering': running and self.answering(),
                'busy': running and self.busy(), 'url': self.public,
                'idle_since': self.idle_since}

    def reap_idle(self):
        """Stop the world ComfyUI once it has had nothing to do for a while."""
        limit = WORLD.get('idle_minutes', 10) * 60
        while True:
            time.sleep(30)
            if self.proc is None or self.proc.poll() is not None:
                self.idle_since = None
                continue
            if self.busy():
                self.idle_since = None
            elif self.idle_since is None:
                self.idle_since = time.time()
            elif time.time() - self.idle_since > limit:
                log(f"idle for {WORLD.get('idle_minutes', 10)} min")
                self.stop()


WORLD_COMFY = World()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorised(self):
        got = self.headers.get('Authorization', '')
        return hmac.compare_digest(got, 'Bearer ' + CONFIG['token'])

    def _route(self, method):
        if not self._authorised():
            return self._send(401, {'error': 'unauthorised'})
        try:
            if method == 'GET' and self.path == '/health':
                return self._send(200, {'ok': True})
            if method == 'GET' and self.path == '/world/status':
                return self._send(200, WORLD_COMFY.status())
            if method == 'POST' and self.path == '/world/start':
                return self._send(200, {'url': WORLD_COMFY.start()})
            if method == 'POST' and self.path == '/world/stop':
                return self._send(200, {'stopped': WORLD_COMFY.stop()})
            return self._send(404, {'error': f'no route {method} {self.path}'})
        except Exception as e:
            log(f'{method} {self.path} failed: {e}')
            return self._send(500, {'error': str(e)})

    def do_GET(self):
        self._route('GET')

    def do_POST(self):
        self._route('POST')

    def log_message(self, fmt, *args):
        log(f'{self.address_string()} {fmt % args}')


def main():
    threading.Thread(target=WORLD_COMFY.reap_idle, daemon=True).start()
    server = ThreadingHTTPServer(('0.0.0.0', CONFIG.get('port', 8190)), Handler)
    log(f"AIMP worker on port {CONFIG.get('port', 8190)}")
    try:
        server.serve_forever()
    finally:
        WORLD_COMFY.stop()


if __name__ == '__main__':
    sys.exit(main())
