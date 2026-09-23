# From camera_lab/pipeline (movie-mvp). Changed for AIMP: see blender/_sets.py.
"""Compiler stage 1 (Blender): from a shot.json and the location's project scene, build the shot scene and
render every geometric input the depth-only recipe needs. Repeatable and idempotent per shot folder.

  Blender -b <location scene.blend> --python blender_stage.py -- <shot_dir>

Produces in <shot_dir>/blender/:
  shot.blend                     saved shot scene (proxy on the mark, shot camera keyframed, coverage cameras)
  depth/frame_%04d.png           16-bit metric depth (camera-space Z), all frames, + depth_manifest.json
  mask/frame_%04d.png            8-bit proxy-figure mask (white = actor), all frames, for figure-free edge control
  rgb/frame_0001.png, frame_%04d.png for the last frame   proxy RGB endpoints for anchors
  plates/R01..R08.png            coverage plates of the empty room (proxy hidden) + plates_manifest.json
  camera_manifest.json           per-frame camera matrices, eye UV, lens; trajectory numbers for the prompt
"""
import bpy, json, sys, math, hashlib
import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _sets
from pathlib import Path
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

argv = sys.argv[sys.argv.index('--') + 1:]; SHOT = Path(argv[0]); shot = json.loads((SHOT / 'shot.json').read_text()); ONLY = set(argv[1].split(',')) if len(argv) > 1 else None
OUT = SHOT / 'blender'; OUT.mkdir(parents=True, exist_ok=True)
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
s = bpy.context.scene; source = Path(bpy.data.filepath); source_hash = sha(source)
fps, frames = shot['clock']['fps'], shot['clock']['frames']; W, H = shot['clock']['size']
s.render.fps = fps; s.render.fps_base = 1; s.frame_start = 1; s.frame_end = frames
s.render.resolution_x, s.render.resolution_y = W, H; s.render.resolution_percentage = 100; s.render.image_settings.file_format = 'PNG'
s.render.engine = 'CYCLES'; s.cycles.seed = 1703; s.cycles.use_animated_seed = False; s.cycles.adaptive_threshold = 0
_sets.use_best_gpu(bpy)   # was Metal-only; the render host has an NVIDIA card

# ---- marks -------------------------------------------------------------------------------------
ch = shot.get('character')   # None = room-only shot (e.g. the location canon pan): no proxy, no eyes target
if ch:
    mark = s.objects[ch['mark']].matrix_world.translation.copy(); face_to = s.objects[ch['facing']].matrix_world.translation.copy()
    fwd = (face_to - mark); fwd.z = 0; fwd.normalize()                       # character faces the visitor mark
    yaw = math.atan2(fwd.y, fwd.x) + math.pi / 2                                # proxy local -Y is its front
    eyes_world = Vector((mark.x, mark.y, 0)) + fwd * 0.11 + Vector((0, 0, ch['eye_height_m']))
else:
    fwd = Vector((0, -1, 0)); yaw = 0.0; eyes_world = Vector(shot['camera'].get('position', (0, 0, 1.5))) + Vector((0, 0, 0))

# ---- proxy figure (smooth v2), replacing any previous block proxies ----------------------------
for o in [o for o in s.objects if o.name.startswith('PROXY_')]: bpy.data.objects.remove(o, do_unlink=True)
coll = bpy.data.collections.get('PROXY_ACTOR') or bpy.data.collections.new('PROXY_ACTOR')
if coll.name not in [c.name for c in s.collection.children]: s.collection.children.link(coll)
root = bpy.data.objects.new('PROXY_ACTOR_ROOT', None); coll.objects.link(root)
standing = bool(ch) and ch.get('pose', 'seated') == 'standing'
if ch and standing:
    root.location = (mark.x, mark.y, ch['eye_height_m'] - 1.62); root.rotation_euler = (0, 0, yaw)   # v2 proxy eyes sit ~1.62 above root when legs are straight
elif ch:
    seat_offset = ch.get('seat_top_m', 0.60) - 0.60                                       # v2 proxy was authored for a 0.60 m seat
    root.location = (mark.x, mark.y, seat_offset); root.rotation_euler = (0, 0, yaw)
def mat(name, rgb):
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes['Principled BSDF']; b.inputs['Base Color'].default_value = (*rgb, 1); b.inputs['Roughness'].default_value = 0.85; return m
SKIN, JACKET, SHIRT, TROUSER, HAIR = mat('px_skin', (0.62, 0.45, 0.36)), mat('px_jacket', (0.80, 0.76, 0.66)), mat('px_shirt', (0.08, 0.08, 0.08)), mat('px_trouser', (0.12, 0.11, 0.10)), mat('px_hair', (0.85, 0.85, 0.85))
def part(name, kind, loc, scale, material, rot=(0, 0, 0)):
    if kind == 'sphere': bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1)
    elif kind == 'cyl': bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=1, depth=1)
    else: bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.active_object; o.name = name
    for c in list(o.users_collection): c.objects.unlink(o)
    coll.objects.link(o); o.parent = root; o.location = loc; o.scale = scale; o.rotation_euler = rot; o.data.materials.append(material)
    if kind == 'cube': bev = o.modifiers.new('bevel', 'BEVEL'); bev.width = 0.06; bev.segments = 4
    sub = o.modifiers.new('subsurf', 'SUBSURF'); sub.levels = 2; sub.render_levels = 3; bpy.ops.object.shade_smooth(); return o
if ch and standing:
    part('proxy_pelvis', 'cube', (0, 0.0, 0.92), (0.38, 0.26, 0.22), TROUSER)
    part('proxy_torso', 'cube', (0, 0.0, 1.27), (0.46, 0.30, 0.52), JACKET)
    part('proxy_shirt', 'cube', (0, -0.15, 1.30), (0.14, 0.04, 0.34), SHIRT)
    part('proxy_neck', 'cyl', (0, 0.0, 1.545), (0.055, 0.055, 0.08), SKIN)
    part('proxy_head', 'sphere', (0, 0.0, 1.66), (0.09, 0.11, 0.12), SKIN)
    part('proxy_hair', 'sphere', (0, 0.03, 1.70), (0.10, 0.12, 0.10), HAIR)
    part('proxy_nose', 'sphere', (0, -0.11, 1.63), (0.018, 0.022, 0.022), SKIN)
    for side in (-1, 1):
        part(f'proxy_eye_{side}', 'sphere', (side * 0.033, -0.10, 1.65), (0.011, 0.008, 0.011), SHIRT)
        part(f'proxy_upperarm_{side}', 'cyl', (side * 0.27, 0.0, 1.22), (0.055, 0.055, 0.34), JACKET)
        part(f'proxy_forearm_{side}', 'cyl', (side * 0.28, -0.02, 0.90), (0.045, 0.045, 0.30), JACKET)
        part(f'proxy_hand_{side}', 'sphere', (side * 0.28, -0.03, 0.72), (0.04, 0.05, 0.08), SKIN)
        part(f'proxy_thigh_{side}', 'cyl', (side * 0.10, 0.0, 0.58), (0.075, 0.075, 0.48), TROUSER)
        part(f'proxy_shin_{side}', 'cyl', (side * 0.10, 0.0, 0.20), (0.06, 0.06, 0.40), TROUSER)
        part(f'proxy_shoe_{side}', 'cube', (side * 0.10, -0.05, 0.03), (0.10, 0.27, 0.06), TROUSER)
elif ch:
    part('proxy_pelvis', 'cube', (0, 0.08, 0.70), (0.40, 0.30, 0.20), TROUSER)
    part('proxy_torso', 'cube', (0, 0.10, 1.00), (0.42, 0.24, 0.50), JACKET, rot=(math.radians(-6), 0, 0))
    part('proxy_shirt', 'cube', (0, -0.045, 1.02), (0.16, 0.06, 0.40), SHIRT, rot=(math.radians(-6), 0, 0))
    part('proxy_neck', 'cyl', (0, 0.02, 1.235), (0.055, 0.055, 0.09), SKIN)
    part('proxy_head', 'sphere', (0, 0.0, 1.33), (0.09, 0.11, 0.12), SKIN)
    part('proxy_hair', 'sphere', (0, 0.03, 1.36), (0.105, 0.125, 0.115), HAIR)
    part('proxy_nose', 'sphere', (0, -0.11, 1.30), (0.018, 0.022, 0.022), SKIN)
    for side in (-1, 1):
        part(f'proxy_eye_{side}', 'sphere', (side * 0.033, -0.10, 1.32), (0.011, 0.008, 0.011), SHIRT)
        part(f'proxy_upperarm_{side}', 'cyl', (side * 0.24, 0.10, 0.98), (0.05, 0.05, 0.34), JACKET, rot=(math.radians(-6), 0, 0))
        part(f'proxy_forearm_{side}', 'cyl', (side * 0.19, -0.08, 0.82), (0.042, 0.042, 0.30), JACKET, rot=(math.radians(-85), 0, math.radians(side * -10)))
        part(f'proxy_hand_{side}', 'sphere', (side * 0.10, -0.24, 0.79), (0.045, 0.06, 0.028), SKIN)
        part(f'proxy_thigh_{side}', 'cyl', (side * 0.11, -0.20, 0.66), (0.07, 0.07, 0.48), TROUSER, rot=(math.radians(-88), 0, 0))
        part(f'proxy_shin_{side}', 'cyl', (side * 0.12, -0.46, 0.30), (0.055, 0.055, 0.58), TROUSER, rot=(math.radians(-6), 0, 0))
bpy.ops.object.select_all(action='DESELECT')
eyes = s.objects.get('EYES_ACTOR') or bpy.data.objects.new('EYES_ACTOR', None)
if eyes.name not in s.objects: s.collection.objects.link(eyes)
eyes.location = eyes_world

# ---- shot camera --------------------------------------------------------------------------------
cam_spec = shot['camera']; cname = 'SHOT_' + cam_spec['id']
if cname in bpy.data.objects: bpy.data.objects.remove(bpy.data.objects[cname], do_unlink=True)
cd = bpy.data.cameras.new(cname); cd.lens = cam_spec['lens_mm']; cd.sensor_width = cam_spec['sensor_width_mm']; cd.sensor_fit = 'HORIZONTAL'
cd.dof.use_dof = bool(ch); cd.dof.aperture_fstop = cam_spec['f_stop']; cd.dof.focus_object = eyes if ch else None
# eye line: place the tracked eyes at a fraction from the top of frame via vertical lens shift (Blender shift_y is in units of the sensor's larger dimension)
el = cam_spec.get('eye_line_from_top'); cd.shift_y = (0.5 - el) * (H / W) * -1 if el is not None else 0.0
cam = bpy.data.objects.new(cname, cd); s.collection.objects.link(cam); s.camera = cam
stage_cam = cam_spec.get('stage_camera')  # a camera object exported from Director's Stage; overrides the azimuth/distance spec
pan_spec = cam_spec if cam_spec.get('type') == 'pan' else None   # room-only pan: fixed position, yaw keyframed (location canon pass)
az = math.radians(cam_spec.get('azimuth_deg_from_character', 0)); rel = Vector((math.cos(az), math.sin(az), 0))
# azimuth measured from the character's facing direction: 0 = straight in front of her
ang0 = math.atan2(fwd.y, fwd.x); direction = Vector((math.cos(ang0 + az), math.sin(ang0 + az), 0))
def cam_pos(dist): p = eyes_world + direction * dist; return Vector((p.x, p.y, cam_spec['height_m']))
def smoothstep(t): return t * t * (3 - 2 * t)
if pan_spec:
    mv = pan_spec['move']; cam.location = Vector(pan_spec['position']); y0, y1 = pan_spec['yaw_start_deg'], pan_spec['yaw_end_deg']; pitch = pan_spec.get('pitch_deg', 0.0)
    for f in range(1, frames + 1):
        t = 0.0 if f <= mv['start_frame'] else 1.0 if f >= mv['end_frame'] else (f - mv['start_frame']) / (mv['end_frame'] - mv['start_frame'])
        cam.rotation_euler = (math.radians(90 - pitch), 0, math.radians(y0 + (y1 - y0) * t - 90)); cam.keyframe_insert('rotation_euler', frame=f)
    d0 = d1 = 0.0
elif stage_cam:
    cd.lens = stage_cam['lens_mm']; cd.sensor_width = stage_cam['sensor_width_mm']; cd.shift_x, cd.shift_y = stage_cam['shift']; cd.dof.aperture_fstop = stage_cam['f_stop']
    mv = stage_cam['move']; p0, p1 = Vector(stage_cam['start']), Vector(stage_cam['end'] if mv['enabled'] else stage_cam['start'])
    if stage_cam['aim_mode'] == 'track':
        tr = cam.constraints.new('TRACK_TO'); tr.target = eyes; tr.track_axis = 'TRACK_NEGATIVE_Z'; tr.up_axis = 'UP_Y'
    else:
        cam.rotation_euler = stage_cam['rotation_euler_rad']
    # path_mode 'polar' (default): interpolate distance, azimuth and height about the eyes separately, so a move that
    # ends beside the actor swings round on a shrinking arc instead of the straight line that dips closest mid-move
    # and backs off again (P_T11's 'bounce': linear path min 1.22 m at f90, end 1.46 m). 'linear' = straight line.
    path_mode = stage_cam.get('path_mode', cam_spec.get('path_mode', 'clamped'))
    r0, r1 = (p0 - eyes_world), (p1 - eyes_world); h0, h1 = p0.z, p1.z; d0s, d1s = r0.length, r1.length
    q0, q1 = Vector((r0.x, r0.y, 0)), Vector((r1.x, r1.y, 0)); L0, L1 = q0.length, q1.length
    a0, a1 = math.atan2(q0.y, q0.x), math.atan2(q1.y, q1.x); da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
    for f in range(1, frames + 1):
        t = 0.0 if f <= mv['start_frame'] else 1.0 if f >= mv['end_frame'] else (f - mv['start_frame']) / (mv['end_frame'] - mv['start_frame'])
        t = smoothstep(t) if mv['easing'] == 'smoothstep' else t
        if path_mode == 'polar' and mv['enabled'] and L0 > 1e-6 and L1 > 1e-6:
            L, a, h = L0 + (L1 - L0) * t, a0 + da * t, h0 + (h1 - h0) * t
            cam.location = Vector((eyes_world.x + math.cos(a) * L, eyes_world.y + math.sin(a) * L, h))
        elif path_mode == 'clamped' and mv['enabled']:
            # 'clamped' (default): the Stage line's direction, but the distance to the eyes never passes the end
            # distance — a push that ends beside the actor arrives at the end distance and arcs round at it instead
            # of dipping closer and backing off (the P_T11 bounce); a polar arc would leave a small room
            q = p0.lerp(p1, t); r = q - eyes_world; L = r.length; Lc = max(L, min(d0s, d1s)) if d1s <= d0s else min(L, max(d0s, d1s))
            cam.location = eyes_world + r * (Lc / L) if L > 1e-6 else q
        else:
            cam.location = p0.lerp(p1, t)
        cam.keyframe_insert('location', frame=f)
    d0, d1 = (p0 - eyes_world).length, (p1 - eyes_world).length
else:
    tr = cam.constraints.new('TRACK_TO'); tr.target = eyes; tr.track_axis = 'TRACK_NEGATIVE_Z'; tr.up_axis = 'UP_Y'
    mv = cam_spec['move']; d0, d1 = cam_spec['start_distance_m'], cam_spec['end_distance_m']
    for f in range(1, frames + 1):
        t = 0.0 if f <= mv['start_frame'] else 1.0 if f >= mv['end_frame'] else (f - mv['start_frame']) / (mv['end_frame'] - mv['start_frame'])
        t = smoothstep(t) if mv['easing'] == 'smoothstep' else t
        cam.location = cam_pos(d0 + (d1 - d0) * t); cam.keyframe_insert('location', frame=f)
for fc in cam.animation_data.action.fcurves:
    for kp in fc.keyframe_points: kp.interpolation = 'LINEAR'

# ---- coverage cameras for plates -------------------------------------------------------------------
floor_objs = [o for o in s.objects if o.type == 'MESH' and o.name.lower().startswith('floor')] or [o for o in s.objects if o.type == 'MESH' and not o.name.startswith('proxy_') and not o.name.lower().startswith('snow')]
xs = [v.x for o in floor_objs for v in [o.matrix_world @ Vector(c) for c in o.bound_box]]; ys = [v.y for o in floor_objs for v in [o.matrix_world @ Vector(c) for c in o.bound_box]]
cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2; radius = 0.35 * min(max(xs) - min(xs), max(ys) - min(ys))
cov = []
for i, name in enumerate(['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08']):
    a = math.radians(90 - 45 * i)   # R01 faces +Y (north), clockwise
    old = bpy.data.objects.get(name)
    if old: bpy.data.objects.remove(old, do_unlink=True)
    c = bpy.data.cameras.new(name); c.lens = 24; c.sensor_width = 36; o = bpy.data.objects.new(name, c); s.collection.objects.link(o)
    o.location = (cx - math.cos(a) * radius, cy - math.sin(a) * radius, 1.65); o.rotation_euler = (math.radians(90), 0, a - math.radians(90)); cov.append(o)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'shot.blend'), copy=False)

# ---- renders ----------------------------------------------------------------------------------------
def render_to(path, samples, denoise=True):
    s.cycles.samples = samples; s.cycles.use_denoising = denoise; s.render.filepath = str(path); bpy.ops.render.render(write_still=True)
s.camera = cam; (OUT / 'rgb').mkdir(exist_ok=True)
if ONLY is None or 'rgb' in ONLY:
    for f in (1, frames): s.frame_set(f); bpy.context.view_layer.update(); render_to(OUT / 'rgb' / f'frame_{f:04d}.png', 32)
    print('RGB_ENDPOINTS_DONE', flush=True)
if (ONLY is None or 'rgb' in ONLY) and 'canny' in shot['recipe'].get('controls', [shot['recipe'].get('control', 'depth')]):
    # full RGB sequence at low samples for the edge control (edges only need geometry outlines)
    for f in range(1, frames + 1):
        if f in (1, frames): continue
        s.frame_set(f); bpy.context.view_layer.update(); render_to(OUT / 'rgb' / f'frame_{f:04d}.png', 8)
        if f % 40 == 0: print('RGB_PROGRESS', f, flush=True)
    print('RGB_SEQUENCE_DONE', flush=True)
coll.hide_render = True; (OUT / 'plates').mkdir(exist_ok=True); plates = []
for o in (cov if (ONLY is None or 'plates' in ONLY) else []):
    s.camera = o; s.frame_set(1); render_to(OUT / 'plates' / f'{o.name}.png', 32); plates.append({'camera': o.name, 'lens_mm': 24, 'matrix_world': [list(r) for r in o.matrix_world], 'file': str(OUT / 'plates' / f'{o.name}.png'), 'sha256': sha(OUT / 'plates' / f'{o.name}.png')})
if plates: (OUT / 'plates' / 'plates_manifest.json').write_text(json.dumps({'location': shot['location']['id'], 'revision': shot['location']['revision'], 'lighting_state': shot['location']['lighting_state'], 'source_scene': str(source), 'source_scene_sha256': source_hash, 'size': [W, H], 'render_samples': 32, 'seed': 1703, 'proxy_collections_hidden': True, 'plates': plates}, indent=2))
print('PLATES_DONE', flush=True)
coll.hide_render = False; s.camera = cam
if ONLY is not None and 'depth' not in ONLY:
    print('BLENDER_STAGE_COMPLETE', flush=True); sys.exit(0)
# depth pass via compositor: metric Z mapped over [near, far] to 16-bit grey
near, far = 0.3, 8.0; s.cycles.samples = 1; s.cycles.use_denoising = False
s.view_layers[0].use_pass_z = True; s.use_nodes = True; tree = s.node_tree
for n in list(tree.nodes): tree.nodes.remove(n)
rl = tree.nodes.new('CompositorNodeRLayers'); mr = tree.nodes.new('CompositorNodeMapRange'); mr.inputs['From Min'].default_value = near; mr.inputs['From Max'].default_value = far; mr.inputs['To Min'].default_value = 0; mr.inputs['To Max'].default_value = 1; mr.use_clamp = True
of = tree.nodes.new('CompositorNodeOutputFile'); (OUT / 'depth').mkdir(exist_ok=True); of.base_path = str(OUT / 'depth'); of.format.file_format = 'PNG'; of.format.color_mode = 'BW'; of.format.color_depth = '16'; of.file_slots[0].path = 'frame_'
tree.links.new(rl.outputs['Depth'], mr.inputs['Value']); tree.links.new(mr.outputs['Value'], of.inputs[0])
# figure mask pass (object index 1 = proxy actor) so the edge control can be built from set geometry only
for o in coll.all_objects: o.pass_index = 1
s.view_layers[0].use_pass_object_index = True; idm = tree.nodes.new('CompositorNodeIDMask'); idm.index = 1; idm.use_antialiasing = False
mf = tree.nodes.new('CompositorNodeOutputFile'); (OUT / 'mask').mkdir(exist_ok=True); mf.base_path = str(OUT / 'mask'); mf.format.file_format = 'PNG'; mf.format.color_mode = 'BW'; mf.format.color_depth = '8'; mf.file_slots[0].path = 'frame_'
tree.links.new(rl.outputs['IndexOB'], idm.inputs['ID value']); tree.links.new(idm.outputs['Alpha'], mf.inputs[0])
s.view_settings.view_transform = 'Standard'; s.render.filepath = str(OUT / 'depth' / '_discard_')
rows = []; drows = []
for f in range(1, frames + 1):
    s.frame_set(f); bpy.context.view_layer.update(); bpy.ops.render.render(write_still=False)
    dfile = OUT / 'depth' / f'frame_{f:04d}.png'; assert dfile.exists(); assert (OUT / 'mask' / f'frame_{f:04d}.png').exists()
    eye = world_to_camera_view(s, cam, eyes.matrix_world.translation); p = cam.matrix_world.translation; dist = (p - eyes.matrix_world.translation).length
    rows.append({'frame': f, 'matrix': [list(r) for r in cam.matrix_world], 'eye_uv': [eye.x, 1 - eye.y], 'distance_to_eyes_m': dist}); drows.append({'frame': f, 'file': str(dfile), 'sha256': sha(dfile)})
    if f % 40 == 0: print('DEPTH_PROGRESS', f, flush=True)
(OUT / 'depth' / 'depth_manifest.json').write_text(json.dumps({'camera': cname, 'snapshot': str(OUT / 'shot.blend'), 'near_m': near, 'far_m': far, 'encoding': '16-bit grey, 0=near_m, 65535=far_m, linear camera-space Z, clamped', 'frames': drows}, indent=2))
d0r, d1r = rows[0]['distance_to_eyes_m'], rows[-1]['distance_to_eyes_m']
(OUT / 'camera_manifest.json').write_text(json.dumps({'shot_id': shot['shot_id'], 'camera': cname, 'lens_mm': cd.lens, 'fstop': cd.dof.aperture_fstop, 'sensor_width_mm': cd.sensor_width, 'fps': fps, 'frames': frames, 'size': [W, H], 'source_scene': str(source), 'source_scene_sha256': source_hash, 'shot_blend': str(OUT / 'shot.blend'), 'shot_blend_sha256': sha(OUT / 'shot.blend'), 'eyes_world': list(eyes_world), 'trajectory': {'type': ('pan' if pan_spec else 'push' if abs(d1 - d0) > 0.05 and (not stage_cam or ((Vector(stage_cam['start']) - eyes_world).normalized().dot((Vector(stage_cam['end']) - eyes_world).normalized()) > 0.98)) else 'hold' if abs(d1 - d0) <= 0.05 else 'general'), 'hold_until_s': (mv['start_frame'] - 1) / fps, 'move_end_s': (mv['end_frame'] - 1) / fps, 'total_s': (frames - 1) / fps + 1 / fps, 'radius_end_ratio': (d1r / d0r) if d0r > 1e-6 else 1.0, 'start_distance_m': d0r, 'end_distance_m': d1r, 'easing': mv['easing'], 'path_mode': (stage_cam.get('path_mode', cam_spec.get('path_mode', 'clamped')) if stage_cam else 'pan' if pan_spec else 'radial')}, 'frames': rows}, indent=2))
print('BLENDER_STAGE_COMPLETE', flush=True)
