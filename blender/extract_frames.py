"""Still frames out of a rendered clip, for another clip to be given as references.

    python extract_frames.py <video> <out dir> <frame> [<frame> ...]

Frames are 1-based. Writes <out dir>/f<frame>.png for each and prints them. Used for
canon frames (camera_lab's cross-shot anchor): when several cameras film one take, the
master camera's frames go to the others, so every angle shows the same room, the same
light and the same person.
"""
import sys
from pathlib import Path

import cv2

video, out = sys.argv[1], Path(sys.argv[2])
wanted = sorted({max(1, int(f)) for f in sys.argv[3:]})
out.mkdir(parents=True, exist_ok=True)
cap = cv2.VideoCapture(video)
total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
if not cap.isOpened() or total < 1:
    raise SystemExit(f'cannot read {video}')
written = []
for f in wanted:
    f = min(f, total)
    cap.set(cv2.CAP_PROP_POS_FRAMES, f - 1)
    ok, img = cap.read()
    if not ok:
        raise SystemExit(f'frame {f} of {video} did not read')
    p = out / f'f{f:04d}.png'
    cv2.imwrite(str(p), img)
    written.append(p.name)
print('FRAMES', ' '.join(written), flush=True)
