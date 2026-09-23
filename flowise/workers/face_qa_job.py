"""Face QA: how closely a rendered clip's face matches a character's references.

Run by the 24-Face-QA flow, on the machine that has the clip, with the Python
that has insightface (ComfyUI's own). Measurement only; it changes nothing.

    python face_qa_job.py @payload.json

The payload is JSON, one of:
    {"action": "probe"}
    {"action": "score",  "video": "output/...", "references": ["output/...", ...],
     "everyNth": 8, "maxFrames": 40, "comfyRoot": "C:/.../ComfyUI/"}
    {"action": "detect", "video": "output/...", "everyNth": 8, "maxFrames": 40, "comfyRoot": "..."}

Paths may be relative to comfyRoot. The result is one line of JSON, printed
last: insightface prints model-loading chatter on stdout first, and the flow
reads the last line.

score: every reference face is embedded, the embeddings are averaged into one
identity, and each sampled frame's face is measured against it by cosine
similarity. The headline is the WORST sampled frame, not the mean, because
drift is usually a short stretch that an average would hide. In a frame with
several faces the closest one counts: that is the character, if they are there.

detect: for a character who is never seen unmasked. Any identifiable face is
reported, with where it first appears. It says a face is there, not whose.
"""
import json
import os
import sys

# A face smaller than this (pixels across) is not identifiable, and scoring it
# gives a number that means nothing.
MIN_FACE = 40
# Below this the detector is guessing.
MIN_DET_SCORE = 0.5


def out(result):
    print(json.dumps(result))
    sys.exit(0)


def load_payload():
    arg = sys.argv[1] if len(sys.argv) > 1 else ''
    if arg.startswith('@'):
        with open(arg[1:], encoding='utf-8') as f:
            return json.load(f)
    return json.loads(arg or '{}')


def resolve(p, root):
    p = str(p).replace('\\', '/')
    if os.path.isabs(p) or not root:
        return os.path.normpath(p)
    return os.path.normpath(os.path.join(root, p))


def face_app():
    from insightface.app import FaceAnalysis
    app = FaceAnalysis(name='buffalo_l', providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
    app.prepare(ctx_id=0, det_size=(640, 640))
    return app


def usable(face):
    x1, y1, x2, y2 = face.bbox
    return face.det_score >= MIN_DET_SCORE and min(x2 - x1, y2 - y1) >= MIN_FACE


def sample_frames(video, every_nth, max_frames):
    """(index, seconds, BGR frame) for every Nth frame, at most max_frames of them."""
    import cv2
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise RuntimeError(f'cannot open the video: {video}')
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    frames = []
    index = 0
    while len(frames) < max_frames:
        ok, frame = cap.read()
        if not ok:
            break
        if index % every_nth == 0:
            frames.append((index, round(index / fps, 3), frame))
        index += 1
    cap.release()
    return frames, fps, total or index


def score(payload, app):
    import cv2
    import numpy as np
    root = payload.get('comfyRoot')
    vecs, used, skipped = [], [], []
    for ref in payload.get('references') or []:
        path = resolve(ref, root)
        img = cv2.imread(path)
        if img is None:
            skipped.append({'reference': ref, 'reason': 'could not be read'})
            continue
        faces = [f for f in app.get(img) if usable(f)]
        if not faces:
            skipped.append({'reference': ref, 'reason': 'no face large enough to identify'})
            continue
        largest = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        vecs.append(largest.normed_embedding)
        used.append(ref)
    if not vecs:
        return {'error': 'None of the references has a face large enough to identify.', 'skipped': skipped}
    centroid = np.mean(vecs, axis=0)
    centroid = centroid / np.linalg.norm(centroid)

    frames, fps, total = sample_frames(resolve(payload['video'], root),
                                       max(1, int(payload.get('everyNth') or 8)),
                                       max(1, int(payload.get('maxFrames') or 40)))
    scored, no_face = [], 0
    for index, seconds, frame in frames:
        faces = [f for f in app.get(frame) if usable(f)]
        if not faces:
            no_face += 1
            continue
        sim = max(float(np.dot(f.normed_embedding, centroid)) for f in faces)
        scored.append({'frame': index, 'time': seconds, 'similarity': round(sim, 4)})
    if not scored:
        return {'error': 'No face large enough to identify in any sampled frame.', 'skipped': skipped,
                'sampled': len(frames), 'framesWithNoFace': no_face}
    sims = [s['similarity'] for s in scored]
    return {
        'worst': min(scored, key=lambda s: s['similarity']),
        'best': max(scored, key=lambda s: s['similarity']),
        'mean': round(sum(sims) / len(sims), 4),
        'sampled': len(frames),
        'framesScanned': total,
        'framesWithNoFace': no_face,
        'fps': round(fps, 3),
        'referencesUsed': len(used),
        'referencesSkipped': skipped,
        'frames': scored,
    }


def detect(payload, app):
    frames, fps, total = sample_frames(resolve(payload['video'], payload.get('comfyRoot')),
                                       max(1, int(payload.get('everyNth') or 8)),
                                       max(1, int(payload.get('maxFrames') or 40)))
    uncovered = []
    for index, seconds, frame in frames:
        faces = [f for f in app.get(frame) if usable(f)]
        if faces:
            uncovered.append({'frame': index, 'time': seconds,
                              'score': round(float(max(f.det_score for f in faces)), 3)})
    return {
        'uncoveredFrames': len(uncovered),
        'coveredFrames': len(frames) - len(uncovered),
        'sampled': len(frames),
        'framesScanned': total,
        'fps': round(fps, 3),
        'uncovered': uncovered,
    }


def main():
    try:
        payload = load_payload()
    except Exception as e:
        out({'error': f'unreadable payload: {e}'})
    action = payload.get('action')
    try:
        if action == 'probe':
            import insightface
            import onnxruntime
            out({'ok': True, 'insightface': insightface.__version__,
                 'providers': onnxruntime.get_available_providers()})
        app = face_app()
        if action == 'score':
            out(score(payload, app))
        if action == 'detect':
            out(detect(payload, app))
        out({'error': f'unknown action: {action}'})
    except SystemExit:
        raise
    except Exception as e:
        out({'error': f'{type(e).__name__}: {e}'})


if __name__ == '__main__':
    main()
