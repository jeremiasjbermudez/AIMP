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

  Blender sets (blender/ in the repository, from camera_lab). A shot is staged
  against a versioned Blender block-out of its location: depth, masks, plates
  and camera matrices for the control-to-video route. Renders take minutes, so
  they are jobs, run one at a time, each after the main ComfyUI has unloaded its
  models:

    POST /blender/jobs  {"kind": "stage", "shot": {...shot.json...}, "project": "slug"}
                        {"kind": "visibility" | "assets", "shotDir": "shots/<project>/<id>"}
                        {"kind": "scout", "name": "...", "shotDirs": ["shots/...", ...]}
                        -> {"id": "..."}
    GET  /blender/jobs/<id> -> {"status": "queued|running|done|error", "result": {...}, "log": "..."}
    GET  /blender/locations -> every location revision in the sets folder, with its location.json

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
  and, for Blender sets:
    "blender": {
      "exe": "C:/ComfyUI-server/blender-4.5.9/blender.exe",
      "scripts": "C:/AIMP/blender",
      "sets_root": "C:/Users/alexk/ComfyUI/input/sets",
      "scout_python": "<a Python with numpy and Pillow>"
    }
"""
import hmac
import json
import os
import queue
import re
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
            # UTF-8, because output goes to a file: on Windows Python then writes
            # cp1252, and the first emoji a node pack logs kills ComfyUI.
            env = dict(os.environ, PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
            self.proc = subprocess.Popen([WORLD['python'], *WORLD['args']], stdout=out, stderr=subprocess.STDOUT,
                                         cwd=WORLD.get('cwd'), creationflags=flags, env=env)
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


class BlenderJobs:
    """Blender renders for sets, queued and run one at a time."""

    KINDS = ('stage', 'visibility', 'scout', 'assets', 'pano_views', 'build', 'export', 'control', 'take')

    def __init__(self, cfg):
        self.cfg = cfg or {}
        self.jobs = {}
        self.queue = queue.Queue()
        self.counter = 0

    @property
    def root(self):
        return os.path.realpath(self.cfg['sets_root'])

    @property
    def comfy_root(self):
        # The sets root is <ComfyUI>/input/sets unless configured otherwise.
        return os.path.realpath(self.cfg.get('comfy_root') or os.path.dirname(os.path.dirname(self.root)))

    def comfy_file(self, rel):
        """A file in ComfyUI's input or output folder, for reading only."""
        full = os.path.realpath(os.path.join(self.comfy_root, str(rel)))
        allowed = [os.path.join(self.comfy_root, d) for d in ('input', 'output')]
        if not any(full.startswith(a + os.sep) for a in allowed) or not os.path.isfile(full):
            raise ValueError(f'{rel} is not a file in ComfyUI\'s input or output folder')
        return full

    def inside(self, rel):
        """A path under the sets root, or an error: nothing outside it is touched."""
        full = os.path.realpath(os.path.join(self.root, str(rel)))
        if full != self.root and not full.startswith(self.root + os.sep):
            raise ValueError(f'{rel} is outside the sets folder')
        return full

    def submit(self, body):
        if not self.cfg:
            raise RuntimeError('Blender is not configured on this worker (no "blender" in aimp-worker.json)')
        kind = body.get('kind')
        if kind not in self.KINDS:
            raise ValueError(f'kind must be one of {", ".join(self.KINDS)}')
        plain = lambda v: bool(re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', str(v))) and not set(str(v)) <= {'.'}
        blender = [self.cfg['exe'], '-b']
        script = lambda name: os.path.join(self.cfg['scripts'], name)
        if kind == 'pano_views':
            # A panorama cut into the four views a block-out is written from and checked against.
            name = str(body.get('name', ''))
            if not plain(name):
                raise ValueError('pano_views needs a plain name')
            out = self.inside(os.path.join('panos', name))
            args = {'cmd': blender + ['--factory-startup', '--python', script('pano_views.py'), '--',
                                      self.comfy_file(body.get('pano', '')), out, str(int(body.get('size', 768)))],
                    'out': out}
        elif kind == 'build':
            # A location revision from its description. Revisions are never rebuilt in place.
            key, rev = str(body.get('locationKey', '')), str(body.get('revision', ''))
            loc = body.get('location')
            if not plain(key) or not plain(rev) or not isinstance(loc, dict):
                raise ValueError('build needs a plain locationKey and revision, and the location')
            # A preview build (of a set made before previews existed) is not a revision.
            out = self.inside(os.path.join('scratch' if body.get('preview') else 'locations', key, rev))
            if os.path.exists(os.path.join(out, 'location.blend')):
                raise ValueError(f'{key} {rev} already exists; a change is a new revision')
            os.makedirs(out, exist_ok=True)
            with open(os.path.join(out, 'location.json'), 'w', encoding='utf-8') as f:
                json.dump(dict(loc, id=key, revision=rev), f, indent=1)
            args = {'cmd': blender + ['--factory-startup', '--python', script('build_blockout.py'), '--', out], 'out': out}
        elif kind == 'export':
            # An older, script-built location described as data, so it can be revised as data.
            key, rev = str(body.get('locationKey', '')), str(body.get('revision', ''))
            if not plain(key) or not plain(rev):
                raise ValueError('export needs a plain locationKey and revision')
            out = self.inside(os.path.join('locations', key, rev))
            blend = os.path.join(out, 'location.blend')
            if not os.path.exists(blend):
                raise FileNotFoundError(f'no location.blend for {key} {rev}')
            args = {'cmd': blender + [blend, '--python', script('export_blockout.py'), '--',
                                      os.path.join(out, 'blockout_export.json')], 'out': out}
        elif kind == 'take':
            # A performance in a set: performers moving to their marks on a timeline (build_take.py).
            tk = body.get('take') or {}
            project, take_id = str(body.get('project', '')), str(tk.get('take_id', ''))
            if not plain(project) or not plain(take_id):
                raise ValueError('a take job needs a plain project and take_id')
            loc = tk.get('location') or {}
            blend = self.inside(os.path.join('locations', str(loc.get('id')), str(loc.get('revision')), 'location.blend'))
            if not os.path.exists(blend):
                raise FileNotFoundError(f"no location.blend for {loc.get('id')} {loc.get('revision')}")
            out = self.inside(os.path.join('takes', project, take_id))
            os.makedirs(out, exist_ok=True)
            with open(os.path.join(out, 'take.json'), 'w', encoding='utf-8') as f:
                json.dump(tk, f, indent=1)
            for stale in ('take.blend', 'take_manifest.json'):
                if os.path.exists(os.path.join(out, stale)):
                    os.remove(os.path.join(out, stale))
            args = {'cmd': blender + [blend, '--python', script('build_take.py'), '--', out], 'out': out}
        elif kind == 'control':
            # A staged shot's depth as the control video a clip is driven by.
            shot_dir = self.inside(body.get('shotDir', ''))
            if not os.path.exists(os.path.join(shot_dir, 'blender', 'depth', 'depth_manifest.json')):
                raise FileNotFoundError('that shot has not been staged (no depth pass)')
            count = max(1, min(int(body.get('plateCount', 2)), 8))
            args = {'cmd': [self.cfg.get('scout_python') or sys.executable, script('control_depth.py'), shot_dir, str(count)],
                    'out': shot_dir}
        elif kind == 'stage':
            shot = body.get('shot') or {}
            shot_id, project = str(shot.get('shot_id', '')), str(body.get('project', ''))
            if not plain(shot_id) or not plain(project):
                raise ValueError('a stage job needs a shot with a plain shot_id, and a plain project name')
            shot_dir = self.inside(os.path.join('shots', project, shot_id))
            os.makedirs(shot_dir, exist_ok=True)
            with open(os.path.join(shot_dir, 'shot.json'), 'w', encoding='utf-8') as f:
                json.dump(shot, f, indent=2)
            loc = shot.get('location') or {}
            tk = shot.get('take')
            if tk:
                # Staged on a take: its performers are already in the scene, moving.
                blend = self.inside(os.path.join('takes', str(tk.get('project', project)), str(tk.get('id')), 'take.blend'))
                if not os.path.exists(blend):
                    raise FileNotFoundError(f"take {tk.get('id')} has not been built")
            else:
                blend = self.inside(os.path.join('locations', str(loc.get('id')), str(loc.get('revision')), 'location.blend'))
                if not os.path.exists(blend):
                    raise FileNotFoundError(f"no location.blend for {loc.get('id')} {loc.get('revision')}")
            args = [blend, 'blender_stage.py', shot_dir] + ([','.join(body['only'])] if body.get('only') else [])
        elif kind in ('visibility', 'assets'):
            shot_dir = self.inside(body.get('shotDir', ''))
            script = 'visibility.py' if kind == 'visibility' else 'stage_assets.py'
            extra = [self.inside(os.path.join(os.path.relpath(shot_dir, self.root), 'stage'))] if kind == 'assets' else []
            args = [os.path.join(shot_dir, 'blender', 'shot.blend'), script, shot_dir] + extra
        else:
            dirs = [self.inside(d) for d in body.get('shotDirs') or []]
            if not dirs:
                raise ValueError('a scout job needs shotDirs')
            name = str(body.get('name') or 'scout')
            if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', name):
                raise ValueError('scout name must be plain')
            args = ['__scout__', name] + dirs
        with LOCK:
            self.counter += 1
            job_id = f'b{int(time.time())}-{self.counter}'
            self.jobs[job_id] = {'id': job_id, 'kind': kind, 'status': 'queued', 'queued_at': time.time(), 'log': '', 'result': None}
        self.queue.put((job_id, kind, args))
        return job_id

    def locations(self):
        """Every locations/<id>/<revision> that has a location.json and a location.blend."""
        base = os.path.join(self.root, 'locations')
        found = []
        for loc_id in sorted(os.listdir(base)) if os.path.isdir(base) else []:
            if loc_id.startswith('_'):   # tests and scratch, not sets
                continue
            for rev in sorted(os.listdir(os.path.join(base, loc_id))):
                d = os.path.join(base, loc_id, rev)
                meta = self._read(os.path.join(d, 'location.json'))
                blend = os.path.join(d, 'location.blend')
                if meta and os.path.exists(blend):
                    found.append({'id': loc_id, 'revision': rev, 'blend': f'locations/{loc_id}/{rev}/location.blend',
                                  'blendBytes': os.path.getsize(blend), 'location': meta})
        return found

    def get(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            raise KeyError(job_id)
        return job

    def run_forever(self):
        while True:
            job_id, kind, args = self.queue.get()
            job = self.jobs[job_id]
            job['status'] = 'running'
            job['started_at'] = time.time()
            try:
                job['result'] = self._run(job, kind, args)
                job['status'] = 'done'
            except Exception as e:
                job['status'] = 'error'
                job['error'] = str(e)
                log(f'blender job {job_id} failed: {e}')
            job['finished_at'] = time.time()

    def _run(self, job, kind, args):
        env = dict(os.environ, AIMP_SETS_ROOT=self.root, AIMP_BLENDER=self.cfg['exe'],
                   PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
        if self.cfg.get('ffmpeg'):
            env['AIMP_FFMPEG'] = self.cfg['ffmpeg']
        # The GPU is shared, as for the world ComfyUI: the main one unloads first.
        try:
            http_json('POST', CONFIG['main_comfy'].rstrip('/') + '/free', {'unload_models': True, 'free_memory': True}, timeout=10)
        except Exception:
            pass
        flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        if isinstance(args, dict):
            cmd = args['cmd']
        elif args[0] == '__scout__':
            name, dirs = args[1], args[2:]
            env['AIMP_SCOUT_OUT'] = os.path.join(self.root, 'reviews')
            cmd = [self.cfg.get('scout_python') or sys.executable, os.path.join(self.cfg['scripts'], 'tech_scout.py'), name] + dirs
        else:
            blend, script, shot_dir, *rest = args
            cmd = [self.cfg['exe'], '-b', blend, '--python', os.path.join(self.cfg['scripts'], script), '--', shot_dir] + rest
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace',
                              env=env, creationflags=flags, timeout=self.cfg.get('timeout_s', 3600))
        out = (proc.stdout or '') + (proc.stderr or '')
        job['log'] = out[-4000:]
        if proc.returncode != 0 or 'Traceback' in out:
            raise RuntimeError(f'{os.path.basename(cmd[0])} exited {proc.returncode}: ' + out[-800:])
        rel = lambda p: os.path.relpath(p, self.root).replace(os.sep, '/')
        if kind == 'pano_views':
            return {'dir': rel(args['out']), 'views': [f'{rel(args["out"])}/view_{t}.png' for t in 'NESW']}
        if kind == 'build':
            if not os.path.exists(os.path.join(args['out'], 'location.blend')):
                raise RuntimeError('the block-out was not built: ' + out[-800:])
            report = self._read(os.path.join(args['out'], 'build_report.json')) or {}
            report['previews'] = [f'{rel(args["out"])}/{p}' for p in report.get('previews', [])]
            return {'dir': rel(args['out']), 'blend': rel(os.path.join(args['out'], 'location.blend')),
                    'report': report, 'location': self._read(os.path.join(args['out'], 'location.json'))}
        if kind == 'take':
            if not os.path.exists(os.path.join(args['out'], 'take.blend')):
                raise RuntimeError('the take was not built: ' + out[-800:])
            return {'dir': rel(args['out']), 'blend': rel(os.path.join(args['out'], 'take.blend')),
                    'manifest': self._read(os.path.join(args['out'], 'take_manifest.json'))}
        if kind == 'control':
            manifest = self._read(os.path.join(args['out'], 'control', 'control_manifest.json')) or {}
            return dict(manifest, video=rel(os.path.join(args['out'], 'control', 'control_depth.mp4')))
        if kind == 'export':
            return {'blockout': self._read(os.path.join(args['out'], 'blockout_export.json'))}
        if kind == 'scout':
            return {'sheet': f'reviews/tech_scout_{args[1]}.jpg', 'coverage': self._read(os.path.join(self.root, 'reviews', f'tech_scout_{args[1]}.json'))}
        shot_dir = args[2]
        blender_dir = os.path.join(shot_dir, 'blender')
        if kind == 'stage':
            manifest = self._read(os.path.join(blender_dir, 'camera_manifest.json')) or {}
            manifest.pop('frames', None)   # per-frame matrices stay in the file; the summary comes back
            return {'shotDir': rel(shot_dir), 'blenderDir': rel(blender_dir), 'camera': manifest,
                    'plates': self._read(os.path.join(blender_dir, 'plates', 'plates_manifest.json')),
                    'depthFrames': len([f for f in os.listdir(os.path.join(blender_dir, 'depth')) if f.endswith('.png')]) if os.path.isdir(os.path.join(blender_dir, 'depth')) else 0}
        if kind == 'visibility':
            vis = self._read(os.path.join(blender_dir, 'visibility.json')) or {}
            return {k: vis.get(k) for k in ('summary', 'placement', 'background_risk', 'bare_thirds', 'windows_s', 'peak_fraction')}
        return {'stageDir': rel(os.path.join(shot_dir, 'stage'))}

    @staticmethod
    def _read(path):
        try:
            with open(path, encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return None


BLENDER = BlenderJobs(CONFIG.get('blender'))


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
            if method == 'POST' and self.path == '/blender/jobs':
                length = int(self.headers.get('Content-Length') or 0)
                body = json.loads(self.rfile.read(length) or b'{}') if length else {}
                return self._send(200, {'id': BLENDER.submit(body)})
            if method == 'GET' and self.path == '/blender/locations':
                return self._send(200, {'locations': BLENDER.locations()})
            if method == 'GET' and self.path.startswith('/blender/jobs/'):
                try:
                    return self._send(200, BLENDER.get(self.path.rsplit('/', 1)[1]))
                except KeyError:
                    return self._send(404, {'error': 'no such job'})
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
    threading.Thread(target=BLENDER.run_forever, daemon=True).start()
    server = ThreadingHTTPServer(('0.0.0.0', CONFIG.get('port', 8190)), Handler)
    log(f"AIMP worker on port {CONFIG.get('port', 8190)}")
    try:
        server.serve_forever()
    finally:
        WORLD_COMFY.stop()


if __name__ == '__main__':
    sys.exit(main())
