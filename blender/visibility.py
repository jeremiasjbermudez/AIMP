# From camera_lab/pipeline (movie-mvp). Changed for AIMP: see blender/_sets.py.
"""What the shot camera can see, occlusion included: object-index pass renders (1 sample) of the saved shot scene at
every 6th frame, pixel counts per named object group of the location. Writes blender/visibility.json with per-frame
pixel fractions, a summary (always / sometimes / never, threshold 0.15% of the frame) and time windows, so the prompt
can state what is and is not in view.   Blender -b <shot_dir>/blender/shot.blend --python visibility.py -- <shot_dir>"""
import bpy, json, sys, numpy as np
import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _sets
from pathlib import Path
argv = sys.argv[sys.argv.index('--') + 1:]; SHOT = Path(argv[0]); s = bpy.context.scene; cam = s.camera; assert cam and cam.name.startswith('SHOT_'), cam
shot = json.loads((SHOT / 'shot.json').read_text())
loc = _sets.location_json(shot, SHOT)
_sets.use_best_gpu(bpy)
GROUPS = loc['set_pieces']   # {phrase: [object-name prefixes]} declared per location (indoor openings, outdoor landmarks alike)
names = list(GROUPS); objs = {g: [o for o in s.objects if o.type == 'MESH' and any(o.name.startswith(p) for p in GROUPS[g])] for g in names}
for o in s.objects:
    if o.type == 'MESH': o.pass_index = 0
for gi, g in enumerate(names, start=1):
    for o in objs[g]: o.pass_index = gi
for o in s.objects:
    if o.name.startswith('proxy_') or o.name.startswith('PROXY_'): o.pass_index = 100   # the actor occludes but is not a set item
FOV_MARGIN = 1.15   # H3 renders ~15% wider than the nominal lens (hut Rear: door edge 11 deg outside the 50 mm frame still showed)
cam.data.lens = cam.data.lens / FOV_MARGIN
s.render.engine = 'CYCLES'; s.cycles.samples = 1; s.cycles.use_denoising = False; s.render.resolution_percentage = 50
s.view_layers[0].use_pass_object_index = True; s.use_nodes = True; tree = s.node_tree
for n in list(tree.nodes): tree.nodes.remove(n)
rl = tree.nodes.new('CompositorNodeRLayers'); of = tree.nodes.new('CompositorNodeOutputFile'); tmp = SHOT / 'blender' / '_vis'; tmp.mkdir(parents=True, exist_ok=True)
of.base_path = str(tmp); of.format.file_format = 'OPEN_EXR'; of.format.color_depth = '32'; of.format.exr_codec = 'NONE'; of.file_slots[0].path = 'idx_'
tree.links.new(rl.outputs['IndexOB'], of.inputs[0]); s.render.filepath = str(tmp / '_discard_')
fps = s.render.fps; frames = list(range(1, s.frame_end + 1, 6)); frames = frames + ([s.frame_end] if frames[-1] != s.frame_end else [])
rows = {}
for f in frames:
    s.frame_set(f); bpy.context.view_layer.update(); bpy.ops.render.render(write_still=False)
    p = tmp / f'idx_{f:04d}.exr'; img = bpy.data.images.load(str(p)); px = np.array(img.pixels[:], dtype=np.float32).reshape(-1, 4)[:, 0]; bpy.data.images.remove(img); p.unlink()
    idx = np.rint(px).astype(int); rows[f] = {g: round(float((idx == gi).mean()), 5) for gi, g in enumerate(names, start=1)}
    # relief per third of frame: set-piece pixels (openings and the actor excluded) in the left / centre / right third
    wpx_ = int(s.render.resolution_x * s.render.resolution_percentage / 100); col_ = np.tile(np.arange(wpx_), int(len(idx) / wpx_)); third = (col_ * 3) // wpx_
    # wall relief only: openings and ceiling-hung lamps do not dress the wall behind them; the actor's own pixels are
    # excluded from the denominator (a bare third hidden behind the actor is not bare)
    relief = np.isin(idx, [gi for gi, g in enumerate(names, start=1) if g not in ('window', 'doorway', 'snow outside') and 'lamp' not in g])
    notactor = idx != 100
    rows[f]['__thirds'] = [round(float(relief[(third == k) & notactor].sum() / max(1, ((third == k) & notactor).sum())), 4) for k in range(3)]
    # horizontal placement of each piece (mean column, 0 = left edge, 1 = right edge) for positional prompt facts
    wpx = int(s.render.resolution_x * s.render.resolution_percentage / 100); cols = np.tile(np.arange(wpx), int(len(idx) / wpx))
    for gi, g in enumerate(names, start=1):
        m_ = idx == gi
        if m_.sum(): rows[f][g + '__x'] = round(float(cols[m_].mean() / wpx), 3)
TH = 0.0015
summary = {'always': [g for g in names if all(rows[f][g] >= TH for f in frames)], 'never': [g for g in names if all(rows[f][g] < TH for f in frames)]}
summary['sometimes'] = [g for g in names if g not in summary['always'] and g not in summary['never']]
windows = {}
for g in summary['sometimes']:   # contiguous on-intervals (a pan that returns to its start sees a piece at the start AND the end)
    segs = []; prev = None
    for f in frames:
        on = rows[f][g] >= TH
        if on and (prev is None or not prev): segs.append([f, f])
        elif on: segs[-1][1] = f
        prev = on
    windows[g] = [{'from_s': round((a - 1) / fps, 2), 'to_s': round(min((b - 1) / fps + 6 / fps, s.frame_end / fps), 2)} for a, b in segs]
peak = {g: max(rows[f][g] for f in frames) for g in names}
thirds = [float(np.mean([rows[f]['__thirds'][k] for f in frames])) for k in range(3)]; bare_thirds = [('left', 'centre', 'right')[k] for k in range(3) if thirds[k] < 0.01]
xpos = {}
for g in names:
    xs = [rows[f][g + '__x'] for f in frames if g + '__x' in rows[f]]
    if xs: xm = float(np.mean(xs)); xpos[g] = 'left' if xm < 0.36 else 'right' if xm > 0.64 else 'centre'
structure = [g for g in names if peak[g] >= 0.02 and g not in ('window', 'doorway', 'snow outside')]
risk = (f"BARE THIRD(S): {', '.join(bare_thirds)} — no set-piece relief there (<1% of that third); H3 fills it from its prior. Dress or reframe." if bare_thirds else None) if structure else 'PLAIN BACKGROUND: no set piece (other than openings) covers >=2% of the frame at any time; H3 fills plain walls with its prior (windows) and neither prompt, pictures, reference video nor sparse guides held it (hut Front/Rear). Move the camera or dress the wall behind the actor with depth-visible pieces.'
(SHOT / 'blender' / 'visibility.json').write_text(json.dumps({'camera': cam.name, 'fps': fps, 'method': 'object-index pass, occlusion included, threshold 0.15% of frame, field of view widened 15% (H3 renders wider than the nominal lens)', 'sampled_frames': frames, 'frames': rows, 'peak_fraction': peak, 'summary': summary, 'placement': xpos, 'relief_per_third': [round(t, 4) for t in thirds], 'bare_thirds': bare_thirds, 'background_risk': risk, 'windows_s': windows, 'groups': {g: [o.name for o in objs[g]] for g in names}}, indent=1))
print('VISIBILITY', json.dumps(summary), json.dumps(windows), 'peak', {g: round(v, 4) for g, v in peak.items() if v > 0}, flush=True)
