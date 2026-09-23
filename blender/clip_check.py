"""Check a rendered clip against the shot it was made from.

    python clip_check.py <clip.mp4> <shot dir> [<face models root>] [--every N]

Three numbers, so settings can be compared by measurement rather than by eye:

- pattern: a regular texture laid over the picture (the diamond pattern seen on walls)
  shows as sharp peaks in the spectrum of the fine detail. Score = the strongest
  mid-frequency peaks over the median; about 20 is clean, above about 40 it shows.
- faces: faces found on each sampled frame. The shot has one person, so more than one
  is a copy of the character.
- people: every person on each sampled frame (YOLO11 segmentation, back views too). A
  person who does not overlap the staged actor is an extra one: a copy of the character.
- follows the camera: the actor's outline in the clip against the staged actor mask
  (blender/mask, the proxy's exact silhouette on that frame): intersection over union,
  1 = the same shape in the same place. And where the eyes should be (camera_manifest
  eye_uv) against the detected face.

Prints one JSON object.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

args = [a for a in sys.argv[1:] if not a.startswith('--')]
yolo_path = sys.argv[sys.argv.index('--yolo') + 1] if '--yolo' in sys.argv else None
if yolo_path:
    args = [a for a in args if a != yolo_path]
every = int(sys.argv[sys.argv.index('--every') + 1]) if '--every' in sys.argv else 6
clip, shot = args[0], Path(args[1])
root = args[2] if len(args) > 2 else None

cm = json.loads((shot / 'blender' / 'camera_manifest.json').read_text(encoding='utf-8'))
expected = {r['frame']: r.get('eye_uv') for r in cm['frames']}

from insightface.app import FaceAnalysis  # noqa: E402
kw = {'root': root} if root else {}
app = FaceAnalysis(name='buffalo_l', providers=['CUDAExecutionProvider', 'CPUExecutionProvider'], **kw)
app.prepare(ctx_id=0, det_size=(640, 640))


def pattern(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    g = g - cv2.GaussianBlur(g, (0, 0), 6)
    win = np.hanning(g.shape[0])[:, None] * np.hanning(g.shape[1])[None, :]
    F = np.abs(np.fft.fftshift(np.fft.fft2(g * win)))
    h, w = F.shape
    yy, xx = np.mgrid[:h, :w]
    r = np.hypot((yy - h / 2) / h, (xx - w / 2) / w)
    band = F[(r > 0.03) & (r < 0.25)]
    return float(np.sort(band)[-20:].mean() / np.median(band))


yolo = None
if yolo_path:
    from ultralytics import YOLO
    yolo = YOLO(yolo_path)


def people(img, actor):
    """(persons, extra persons, best IoU with the actor mask) on one frame."""
    r = yolo.predict(img, classes=[0], conf=0.35, verbose=False, retina_masks=True)[0]
    if r.masks is None:
        return 0, 0, 0.0
    ms = (r.masks.data.cpu().numpy() > 0.5)
    if ms.shape[1:] != actor.shape:
        ms = np.stack([cv2.resize(m.astype(np.uint8), (actor.shape[1], actor.shape[0])) > 0 for m in ms])
    area = actor.shape[0] * actor.shape[1]
    ious, extra = [], 0
    for m in ms:
        inter = np.logical_and(m, actor).sum()
        union = np.logical_or(m, actor).sum()
        iou = inter / union if union else 0.0
        ious.append(iou)
        if m.sum() > 0.01 * area and inter < 0.1 * m.sum():
            extra += 1
    return len(ms), extra, float(max(ious) if ious else 0.0)


cap = cv2.VideoCapture(clip)
n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
rows = []
patterns = []
for f in range(1, n + 1):
    ok, img = cap.read()
    if not ok:
        break
    if f in (max(1, n // 4), n // 2, 3 * n // 4):
        patterns.append(round(pattern(img), 1))
    if (f - 1) % every:
        continue
    faces = [x for x in app.get(img) if x.det_score > 0.5 and (x.bbox[3] - x.bbox[1]) > 0.04 * H]
    e = expected.get(f)
    in_frame = bool(e) and 0 <= e[0] <= 1 and 0 <= e[1] <= 1
    err = None
    if faces and in_frame:
        # The face nearest where the actor's eyes should be is the actor.
        eyes = [((x.kps[0][0] + x.kps[1][0]) / 2 / W, (x.kps[0][1] + x.kps[1][1]) / 2 / H) for x in faces]
        err = min(float(np.hypot(u - e[0], (v - e[1]) * H / W)) for u, v in eyes)
    row = {'frame': f, 'faces': len(faces), 'eyes_in_frame': in_frame, 'eye_error': None if err is None else round(err, 3)}
    if yolo is not None:
        mp = shot / 'blender' / 'mask' / f'frame_{f:04d}.png'
        actor = cv2.imread(str(mp), cv2.IMREAD_GRAYSCALE) if mp.exists() else None
        if actor is not None:
            actor = cv2.resize(actor, (W, H)) > 127
            n_p, extra, iou = people(img, actor)
            row.update({'people': n_p, 'extra_people': extra, 'actor_iou': round(iou, 3)})
    rows.append(row)

errs = [r['eye_error'] for r in rows if r['eye_error'] is not None]
out = {
    'clip': Path(clip).name, 'frames': n, 'sampled': len(rows),
    'pattern': patterns, 'pattern_mean': round(float(np.mean(patterns)), 1) if patterns else None,
    'extra_faces_frames': sum(1 for r in rows if r['faces'] > 1),
    'max_faces': max((r['faces'] for r in rows), default=0),
    'eye_error_median': round(float(np.median(errs)), 3) if errs else None,
    'eye_error_max': round(float(max(errs)), 3) if errs else None,
    'eyes_expected': sum(1 for r in rows if r['eyes_in_frame']),
    'extra_people_frames': sum(1 for r in rows if r.get('extra_people', 0) > 0),
    'max_people': max((r.get('people', 0) for r in rows), default=0),
    'actor_iou_median': round(float(np.median([r['actor_iou'] for r in rows if 'actor_iou' in r])), 3) if any('actor_iou' in r for r in rows) else None,
    'actor_iou_min': round(float(min([r['actor_iou'] for r in rows if 'actor_iou' in r])), 3) if any('actor_iou' in r for r in rows) else None,
    'face_found_where_expected': len(errs),
    'per_frame': rows,
}
print(json.dumps(out))
