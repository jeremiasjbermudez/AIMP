# From camera_lab/pipeline (movie-mvp). Changed for AIMP: see blender/_sets.py.
"""Tech scout gate: BEFORE any H3 render, show what every Stage camera will actually see in the block-out and whether
it has enough relief to hold. Inputs: shot folders that have run blender_stage (shot.blend + blender/rgb) — this tool
re-runs visibility.py for each. Output: reviews/tech_scout_<name>.jpg (top-down plan with FOV wedges, each camera's
block-out view with its facts) and reviews/tech_scout_<name>.json (coverage matrix: set piece -> camera -> placement).
  python3 tech_scout.py <name> <shot_dir> [<shot_dir> ...]
Gate rule: no static camera may have background_risk; every set piece two cameras share must sit on the expected side
of frame in both (from the placement facts); dress the block-out until the sheet is clean, then render."""
import json, math, os, subprocess, sys
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import _sets
import numpy as np
from PIL import Image, ImageDraw
# Blender from AIMP_BLENDER (or `blender` on PATH); the sheet goes to AIMP_SCOUT_OUT, else beside the shots.
B = os.environ.get('AIMP_BLENDER', 'blender'); HERE = Path(__file__).resolve().parent
name = sys.argv[1]; shots = [Path(p).resolve() for p in sys.argv[2:]]
out = Path(os.environ.get('AIMP_SCOUT_OUT') or shots[0].parent / 'reviews'); out.mkdir(parents=True, exist_ok=True)
rows = []
for sd in shots:
    shot = json.loads((sd / 'shot.json').read_text())
    subprocess.run([str(B), '-b', str(sd / 'blender/shot.blend'), '--python', str(HERE / 'visibility.py'), '--', str(sd)], capture_output=True)
    vis = json.loads((sd / 'blender/visibility.json').read_text()); cm = json.loads((sd / 'blender/camera_manifest.json').read_text())
    rows.append({'shot': sd.name, 'camera': shot['camera'].get('stage_camera', shot['camera']).get('name', shot['camera']['id']), 'lens': shot['camera']['lens_mm'], 'static': not shot['camera']['move']['enabled'], 'revision': shot['location']['revision'], 'always': vis['summary']['always'], 'sometimes': vis['summary']['sometimes'], 'never': vis['summary']['never'], 'placement': vis.get('placement', {}), 'risk': vis.get('background_risk'), 'frames': cm['frames'], 'rgb': str(sd / 'blender/rgb/frame_0001.png')})
loc = _sets.location_json(json.loads((shots[0] / 'shot.json').read_text()), shots[0])
# coverage matrix
pieces = sorted({g for r in rows for g in r['always'] + r['sometimes']})
matrix = {g: {r['shot']: (r['placement'].get(g, 'in frame') if g in r['always'] else 'sometimes' if g in r['sometimes'] else '-') for r in rows} for g in pieces}
(out / f'tech_scout_{name}.json').write_text(json.dumps({'location': loc['id'], 'revisions': sorted({r['revision'] for r in rows}), 'cameras': [{k: v for k, v in r.items() if k not in ('frames', 'rgb')} for r in rows], 'coverage': matrix}, indent=2))
# sheet: top-down + per-camera views
W, D = loc['dimensions_m']['width'], loc['dimensions_m']['depth']; S = 150; pad = 60; plan = Image.new('RGB', (int(W * S) + 2 * pad, int(D * S) + 2 * pad), (245, 242, 235)); d = ImageDraw.Draw(plan)
P = lambda x, y: (pad + (x + W / 2) * S, pad + (D / 2 - y) * S); d.rectangle([P(-W / 2, D / 2), P(W / 2, -D / 2)], outline=(60, 60, 60), width=3)
for nm, pos in loc['anchors'].items(): d.ellipse([P(pos[0], pos[1])[0] - 4, P(pos[0], pos[1])[1] - 4, P(pos[0], pos[1])[0] + 4, P(pos[0], pos[1])[1] + 4], fill=(120, 120, 120)); d.text((P(pos[0], pos[1])[0] + 6, P(pos[0], pos[1])[1] - 6), nm.replace('ANCHOR_', ''), fill=(120, 120, 120))
cols = [(0, 140, 0), (160, 0, 160), (200, 120, 0), (0, 100, 200), (180, 0, 0)]
for i, r in enumerate(rows):
    c = cols[i % len(cols)]; half = math.degrees(math.atan(18 / r['lens'])) * 1.15
    for fi in (0, len(r['frames']) - 1) if not r['static'] else (0,):
        M = np.array(r['frames'][fi]['matrix']); pos = M[:3, 3]; f = -M[:3, 2]; ax = math.degrees(math.atan2(f[1], f[0]))
        for a in (ax - half, ax + half): d.line([P(pos[0], pos[1]), P(pos[0] + 3.5 * math.cos(math.radians(a)), pos[1] + 3.5 * math.sin(math.radians(a)))], fill=c, width=2)
        d.ellipse([P(pos[0], pos[1])[0] - 5, P(pos[0], pos[1])[1] - 5, P(pos[0], pos[1])[0] + 5, P(pos[0], pos[1])[1] + 5], fill=c); d.text((P(pos[0], pos[1])[0] + 7, P(pos[0], pos[1])[1] + 4), f"{r['camera']} {r['lens']:.0f}mm", fill=c)
vw, vh = 448, 192; sheet = Image.new('RGB', (plan.width + vw + 20, max(plan.height, len(rows) * (vh + 78)) + 20), (20, 20, 24)); sheet.paste(plan, (10, 10)); dd = ImageDraw.Draw(sheet)
for i, r in enumerate(rows):
    x = plan.width + 20; y = 10 + i * (vh + 78); sheet.paste(Image.open(r['rgb']).convert('RGB').resize((vw, vh)), (x, y + 16)); c = cols[i % len(cols)]
    dd.text((x, y), f"{r['shot']} · {r['camera']} {r['lens']:.0f}mm · {'static' if r['static'] else 'moving'} · {r['revision']}", fill=c)
    facts = 'IN: ' + ', '.join(f"{g} ({r['placement'].get(g, '?')})" for g in r['always'])[:110]; dd.text((x, y + vh + 18), facts, fill=(230, 230, 230))
    dd.text((x, y + vh + 32), ('SOMETIMES: ' + ', '.join(r['sometimes']))[:110], fill=(200, 200, 200))
    dd.text((x, y + vh + 46), 'RISK: PLAIN BACKGROUND — dress or move' if r['risk'] else 'ok: relief behind the actor', fill=(255, 90, 90) if r['risk'] else (120, 220, 120))
sheet.save(out / f'tech_scout_{name}.jpg', quality=90); print('TECH_SCOUT', out / f'tech_scout_{name}.jpg')
print('coverage:'); [print(' ', g, {k: v for k, v in matrix[g].items() if v != '-'}) for g in pieces]
