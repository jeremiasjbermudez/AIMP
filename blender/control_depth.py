"""A staged shot's depth pass as the control video MiniMax H3 is driven by, plus
what the clip's prompt and references need to know about the camera.

    python control_depth.py <shot dir> [plate count]

From camera_lab's compile_shot.py (build_control, resolve_plates and the camera
facts of build_prompt), without its Z-Image and H3 calls: in AIMP those are
flows. Reads <shot dir>/shot.json and <shot dir>/blender/, writes:

    control/control_depth.mp4    inverse depth, near = white, one range for the
                                 whole clip (0.5-99.5 percentile of every frame),
                                 8-bit RGB, lossless, exactly the shot's frames
    control/control_manifest.json the range, the check below, the coverage plates
                                 facing the way this camera faces, and where the
                                 camera is relative to the actor at start and end

A camera that passes within 0.35 m of the set on more than 2% of a frame is
refused, as in camera_lab: the control signal jumps to white and H3 loses the shot.
"""
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _sets  # noqa: E402

SHOT = Path(sys.argv[1]).resolve()
PLATE_COUNT = int(sys.argv[2]) if len(sys.argv) > 2 else 2
MIN_CLEAR_M = 0.35
FFMPEG = os.environ.get('AIMP_FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg'

shot = json.loads((SHOT / 'shot.json').read_text(encoding='utf-8'))
loc = json.loads(_sets.location_json(shot, SHOT).read_text(encoding='utf-8'))
B = SHOT / 'blender'
dm = json.loads((B / 'depth' / 'depth_manifest.json').read_text(encoding='utf-8'))
cm = json.loads((B / 'camera_manifest.json').read_text(encoding='utf-8'))
pm = json.loads((B / 'plates' / 'plates_manifest.json').read_text(encoding='utf-8'))
near, far = dm['near_m'], dm['far_m']
fps, frames = shot['clock']['fps'], shot['clock']['frames']


def depth_m(path):
    z16 = np.asarray(Image.open(path), dtype=np.float64)
    z16 = z16[..., 0] if z16.ndim == 3 else z16
    return near + (z16 / 65535.0) * (far - near)


def depth_file(row):
    # The manifest records where Blender wrote each frame; the frames are beside it.
    return B / 'depth' / Path(row['file']).name


# ---------------------------------------------------------------- the collision check
too_close = []
for row in dm['frames']:
    frac = float(np.mean(depth_m(depth_file(row)) < MIN_CLEAR_M))
    if frac > 0.02:
        too_close.append([row['frame'], round(frac, 3)])
if too_close:
    raise SystemExit(f'CAMERA_COLLISION: {len(too_close)} frames have more than 2% of the picture closer than '
                     f'{MIN_CLEAR_M} m (frame, fraction): {too_close[:12]}. Move the camera and stage it again.')

# ---------------------------------------------------------------- inverse depth, one range for the clip
inverse = lambda row: 1.0 / np.clip(depth_m(depth_file(row)), near, far)
lo = min(float(np.percentile(inverse(r), 0.5)) for r in dm['frames'])
hi = max(float(np.percentile(inverse(r), 99.5)) for r in dm['frames'])
out = SHOT / 'control'
(out / 'frames').mkdir(parents=True, exist_ok=True)
written = []
for row in dm['frames']:
    inv = np.clip((inverse(row) - lo) / max(hi - lo, 1e-9), 0, 1)
    f = out / 'frames' / f'frame_{row["frame"]:04d}.png'
    Image.fromarray(np.stack([(inv * 255 + 0.5).astype(np.uint8)] * 3, -1)).save(f)
    written.append(f)

video = out / 'control_depth.mp4'
if video.exists():
    video.unlink()
subprocess.run([FFMPEG, '-v', 'error', '-framerate', str(fps), '-i', str(out / 'frames' / 'frame_%04d.png'),
                '-frames:v', str(frames), '-c:v', 'libx264rgb', '-crf', '0', '-preset', 'fast', str(video)], check=True)

# Lossless means the frames read back exactly; checked rather than assumed.
cap = cv2.VideoCapture(str(video))
n = 0
for f in written:
    ok, px = cap.read()
    if not ok or not np.array_equal(cv2.cvtColor(px, cv2.COLOR_BGR2RGB), np.asarray(Image.open(f).convert('RGB'))):
        raise SystemExit(f'control video frame {n + 1} does not match {f.name}')
    n += 1
if cap.read()[0] or n != frames:
    raise SystemExit(f'control video has the wrong length ({n} frames for {frames})')
shutil.rmtree(out / 'frames')

# ---------------------------------------------------------------- the plates this camera faces
def forward_xy(m):
    f = -np.array(m)[:3, 2]
    f = f[:2]
    return f / (np.linalg.norm(f) + 1e-9)


fr = cm['frames']
views = [forward_xy(fr[i]['matrix']) for i in (0, len(fr) // 2, len(fr) - 1)]
score = {p['camera']: max(float(np.dot(forward_xy(p['matrix_world']), v)) for v in views) for p in pm['plates']}
plates = sorted(score, key=lambda c: -score[c])[:PLATE_COUNT]

# ---------------------------------------------------------------- where the camera is, seen from the actor
view = None
ch = shot.get('character')
if ch and ch.get('mark') in loc.get('anchors', {}) and ch.get('facing') in loc.get('anchors', {}):
    eye = np.array(cm['eyes_world'])
    mk, fc = np.array(loc['anchors'][ch['mark']]), np.array(loc['anchors'][ch['facing']])
    fwd = fc[:2] - mk[:2]
    fwd = fwd / (np.linalg.norm(fwd) + 1e-9)

    def rel_az(i):
        v = (np.array(fr[i]['matrix'])[:3, 3] - eye)[:2]
        v = v / (np.linalg.norm(v) + 1e-9)
        # + is the camera to the actor's left, as in camera_lab.
        return math.degrees(math.atan2(fwd[0] * v[1] - fwd[1] * v[0], fwd[0] * v[0] + fwd[1] * v[1]))

    def dist(i):
        return float(np.linalg.norm(np.array(fr[i]['matrix'])[:3, 3] - eye))

    view = {'start_deg': round(rel_az(0), 1), 'end_deg': round(rel_az(len(fr) - 1), 1),
            'start_m': round(dist(0), 3), 'end_m': round(dist(len(fr) - 1), 3)}

manifest = {
    'video': 'control/control_depth.mp4', 'frames': frames, 'fps': fps, 'size': shot['clock']['size'],
    'convention': 'inverse depth, one clip-wide range (0.5-99.5 percentile of all frames), near=white, 8-bit RGB, lossless',
    'range_inverse_m': [lo, hi], 'near_m': near, 'far_m': far,
    'plates': plates, 'plate_scores': {c: round(score[c], 3) for c in plates},
    'view': view, 'trajectory': cm.get('trajectory'), 'lens_mm': cm.get('lens_mm'),
}
(out / 'control_manifest.json').write_text(json.dumps(manifest, indent=1), encoding='utf-8')
print('CONTROL_READY', json.dumps({'frames': frames, 'plates': plates, 'view': view}), flush=True)
