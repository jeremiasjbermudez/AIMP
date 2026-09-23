"""Build a take: a set revision with its performers moving through the scene, timed,
so a camera can be operated against the action as it plays.

    blender -b <location.blend> --python build_take.py -- <take dir>

Reads <take dir>/take.json and writes, beside it:
    take.blend            the set, the performers animated frame by frame, the cues as
                          timeline markers, and TAKE_CAM, a starting camera for the
                          operator. Open it, press play, operate.
    take_manifest.json    every performer's position, heading, pose and eye point per
                          frame, and any warnings
    take.glb              the same scene for the browser: the set and the performers'
                          animation (glTF, Y up), for the camera setup page to play and
                          frame cameras against

A shot staged on a take (blender_stage.py with shot.take) uses these performers
instead of placing a proxy on a mark, so every camera pass over one take sees the
same performance - the coverage of one scene cuts together.

take.json (take/v0):
    take_id, location {id, revision, lighting_state}, clock {fps, frames}
    performers [{id, display, eye_height_m?, seat_top_m?,
                 keys [{t (seconds), mark | at [x, y], facing (an anchor) | facing_deg,
                        pose 'standing' | 'seated'}]}]
    cues [{t, text}]
    camera? {lens_mm, at [x, y, z], look_at (a performer id)}

A performer is at each key's place at its time. Between two keys at different places
they walk, facing the way they go, arms and legs swinging, and turn to the new
facing as they arrive; between two keys at one place they stay, and turn at the end
if the facing changes. A pose change happens at the key.
"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _proxy  # noqa: E402

TAKE_DIR = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
take = json.loads((TAKE_DIR / 'take.json').read_text(encoding='utf-8'))
s = bpy.context.scene
fps, frames = int(take['clock'].get('fps', 24)), int(take['clock']['frames'])
s.render.fps, s.render.fps_base = fps, 1
s.frame_start, s.frame_end = 1, frames
warnings = []

STRIDE_M = 0.7          # one step
TURN_S = 0.5            # how long a turn on arrival takes
LEG_SWING = math.radians(24)
ARM_SWING = math.radians(16)
BOB_M = 0.018

# The set's marks and extent.
anchors = {o.name: o.matrix_world.translation.copy() for o in s.objects if o.name.startswith('ANCHOR_')}
floor = [o for o in s.objects if o.type == 'MESH' and o.name.lower().startswith('floor')]
if floor:
    xs = [(o.matrix_world @ Vector(c)).x for o in floor for c in o.bound_box]
    ys = [(o.matrix_world @ Vector(c)).y for o in floor for c in o.bound_box]
    bounds = (min(xs), max(xs), min(ys), max(ys))
else:
    bounds = None


def place(key, who):
    if key.get('mark'):
        if key['mark'] not in anchors:
            raise SystemExit(f'{who}: {key["mark"]} is not a mark in this set ({", ".join(sorted(anchors))})')
        p = anchors[key['mark']]
        return Vector((p.x, p.y))
    if key.get('at'):
        return Vector((float(key['at'][0]), float(key['at'][1])))
    raise SystemExit(f'{who}: a key needs a mark or at [x, y]')


def heading(key, pos, who):
    """Yaw (radians, world) the performer faces at this key."""
    if key.get('facing'):
        if key['facing'] not in anchors:
            raise SystemExit(f'{who}: {key["facing"]} is not a mark in this set')
        d = anchors[key['facing']].xy - pos
        if d.length > 1e-6:
            return math.atan2(d.y, d.x)
    if key.get('facing_deg') is not None:
        return math.radians(float(key['facing_deg']))
    return None


def smoothstep(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def turn(a, b, t):
    d = (b - a + math.pi) % (2 * math.pi) - math.pi
    return a + d * smoothstep(t)


def timeline(perf):
    """Per frame: (position, yaw, pose, walking phase, walking) from the keys."""
    who = perf.get('display') or perf['id']
    keys = sorted(perf.get('keys') or [], key=lambda k: float(k.get('t', 0)))
    if not keys:
        raise SystemExit(f'{who}: no keys')
    pts = [place(k, who) for k in keys]
    yaws = []
    for i, k in enumerate(keys):
        y = heading(k, pts[i], who)
        if y is None:   # no facing given: the way they are going, or were going
            nxt = next((pts[j] for j in range(i + 1, len(pts)) if (pts[j] - pts[i]).length > 0.05), None)
            prv = next((pts[j] for j in range(i - 1, -1, -1) if (pts[i] - pts[j]).length > 0.05), None)
            d = (nxt - pts[i]) if nxt is not None else (pts[i] - prv) if prv is not None else Vector((0, 1))
            y = math.atan2(d.y, d.x)
        yaws.append(y)
    times = [float(k.get('t', 0)) for k in keys]
    poses = [k.get('pose', 'standing') for k in keys]
    rows = []
    travelled = 0.0
    last = pts[0].copy()
    for f in range(1, frames + 1):
        t = (f - 1) / fps
        i = max([j for j in range(len(keys)) if times[j] <= t] or [0])
        if t <= times[0] or i == len(keys) - 1:
            pos, yaw, walking = pts[i if t > times[0] else 0].copy(), yaws[i if t > times[0] else 0], False
            pose = poses[i if t > times[0] else 0]
        else:
            t0, t1 = times[i], times[i + 1]
            u = (t - t0) / max(t1 - t0, 1e-6)
            p0, p1 = pts[i], pts[i + 1]
            pose = poses[i]
            if (p1 - p0).length > 0.05:
                walking = True
                pos = p0.lerp(p1, smoothstep(u))
                travel = math.atan2((p1 - p0).y, (p1 - p0).x)
                # Turn to go, walk facing the way they go, turn to the new facing on arrival.
                span = max(t1 - t0, 1e-6)
                start_turn = min(TURN_S / span, 0.3)
                end_turn = min(TURN_S / span, 0.3)
                if u < start_turn:
                    yaw = turn(yaws[i], travel, u / start_turn)
                elif u > 1 - end_turn:
                    yaw = turn(travel, yaws[i + 1], (u - (1 - end_turn)) / end_turn)
                else:
                    yaw = travel
            else:
                walking = False
                pos = p0.copy()
                span = max(t1 - t0, 1e-6)
                start = max(0.0, 1 - TURN_S / span)
                yaw = turn(yaws[i], yaws[i + 1], (u - start) / max(1 - start, 1e-6)) if u > start else yaws[i]
        travelled += (pos - last).length
        last = pos.copy()
        rows.append({'frame': f, 'pos': pos, 'yaw': yaw, 'pose': pose, 'phase': math.pi * travelled / STRIDE_M, 'walking': walking})
    if bounds:
        for r in rows:
            x, y = r['pos']
            if not (bounds[0] <= x <= bounds[1] and bounds[2] <= y <= bounds[3]):
                warnings.append(f'{who} leaves the floor at frame {r["frame"]} ({x:.2f}, {y:.2f})')
                break
    return rows


# ---------------------------------------------------------------- performers
for o in [o for o in s.objects if o.name.startswith(('PROXY_', 'proxy_', 'EYES_'))]:
    bpy.data.objects.remove(o, do_unlink=True)
coll = bpy.data.collections.get('PROXY_ACTOR') or bpy.data.collections.new('PROXY_ACTOR')
if coll.name not in [c.name for c in s.collection.children]:
    s.collection.children.link(coll)


def empty(name, parent=None, loc=(0, 0, 0)):
    e = bpy.data.objects.new(name, None)
    coll.objects.link(e)
    e.parent = parent
    e.location = loc
    return e


def pivot(root, parts, name, at):
    """Re-hang a limb's parts from a joint, keeping where they are, so the joint can swing."""
    j = empty(name, root, at)
    bpy.context.view_layer.update()
    for p in parts:
        mw = p.matrix_world.copy()
        p.parent = j
        p.matrix_parent_inverse = Matrix.Identity(4)
        p.matrix_world = mw
    return j


manifest = {'take_id': take.get('take_id'), 'fps': fps, 'frames': frames, 'performers': {}, 'warnings': warnings}
for n, perf in enumerate(take.get('performers') or []):
    pid = str(perf['id'])
    who = perf.get('display') or pid
    eye_h = float(perf.get('eye_height_m', 1.62))
    seat = float(perf.get('seat_top_m', 0.60))
    rows = timeline(perf)

    top = empty(f'PROXY_{pid.upper()}_ROOT')
    stand_root = empty(f'PROXY_{pid.upper()}_STAND', top, (0, 0, eye_h - 1.62))
    sit_root = empty(f'PROXY_{pid.upper()}_SIT', top, (0, 0, seat - 0.60))
    _proxy.build(bpy, coll, stand_root, 'standing')
    _proxy.build(bpy, coll, sit_root, 'seated')
    stand_parts = [o for o in coll.objects if o.parent == stand_root]
    sit_parts = [o for o in coll.objects if o.parent == sit_root]

    # Joints for walking: hips at 0.82 m, shoulders at 1.42 m on the standing figure.
    limbs = {}
    for side in (-1, 1):
        leg = [o for o in stand_parts if any(o.name.startswith(f'proxy_{k}_{side}') for k in ('thigh', 'shin', 'shoe'))]
        arm = [o for o in stand_parts if any(o.name.startswith(f'proxy_{k}_{side}') for k in ('upperarm', 'forearm', 'hand'))]
        limbs[('hip', side)] = pivot(stand_root, leg, f'PROXY_{pid.upper()}_HIP_{side}', (side * 0.10, 0, 0.82))
        limbs[('shoulder', side)] = pivot(stand_root, arm, f'PROXY_{pid.upper()}_SHOULDER_{side}', (side * 0.27, 0, 1.42))

    # The eyes the camera aims at: the first performer's are EYES_ACTOR, as the stage expects.
    eyes = empty('EYES_ACTOR' if n == 0 else f'EYES_{pid.upper()}', top)

    per_frame = []
    for r in rows:
        f = r['frame']
        seated = r['pose'] == 'seated'
        bob = BOB_M * abs(math.sin(r['phase'])) if r['walking'] else 0.0
        top.location = (r['pos'].x, r['pos'].y, bob)
        # The figure's front is its local -Y; yaw is the world heading.
        top.rotation_euler = (0, 0, r['yaw'] + math.pi / 2)
        top.keyframe_insert('location', frame=f)
        top.keyframe_insert('rotation_euler', frame=f)
        for part, hide in [(o, seated) for o in stand_parts] + [(o, not seated) for o in sit_parts]:
            part.hide_render = hide
            part.hide_viewport = hide
            part.keyframe_insert('hide_render', frame=f)
            part.keyframe_insert('hide_viewport', frame=f)
        swing = math.sin(r['phase']) if r['walking'] else 0.0
        for side in (-1, 1):
            limbs[('hip', side)].rotation_euler = (side * LEG_SWING * swing, 0, 0)
            limbs[('shoulder', side)].rotation_euler = (-side * ARM_SWING * swing, 0, 0)
            limbs[('hip', side)].keyframe_insert('rotation_euler', frame=f)
            limbs[('shoulder', side)].keyframe_insert('rotation_euler', frame=f)
        eyes.location = (0, -0.10, seat - 0.60 + 1.32) if seated else (0, -0.11, eye_h)
        eyes.keyframe_insert('location', frame=f)
        per_frame.append({'frame': f, 'x': round(r['pos'].x, 4), 'y': round(r['pos'].y, 4),
                          'heading_deg': round(math.degrees(r['yaw']) % 360, 2), 'pose': r['pose'], 'walking': r['walking']})
    # Every frame is keyed; stepped keys for visibility, straight lines for the rest.
    for ob in [top, eyes] + stand_parts + sit_parts + list(limbs.values()):
        if ob.animation_data and ob.animation_data.action:
            for fc in ob.animation_data.action.fcurves:
                for kp in fc.keyframe_points:
                    kp.interpolation = 'CONSTANT' if fc.data_path.startswith('hide_') else 'LINEAR'
    bpy.context.view_layer.update()
    manifest['performers'][pid] = {'display': who, 'root': top.name, 'eyes': eyes.name, 'frames': per_frame}

# ---------------------------------------------------------------- cues and the operator's camera
s.timeline_markers.clear()
for cue in take.get('cues') or []:
    f = max(1, min(frames, int(round(float(cue.get('t', 0)) * fps)) + 1))
    s.timeline_markers.new(str(cue.get('text', 'cue'))[:63], frame=f)

cam_spec = take.get('camera') or {}
cd = bpy.data.cameras.new('TAKE_CAM')
cd.lens = float(cam_spec.get('lens_mm', 35))
cd.sensor_width = 36
cd.sensor_fit = 'HORIZONTAL'
cam = bpy.data.objects.new('TAKE_CAM', cd)
s.collection.objects.link(cam)
s.frame_set(1)
first_eyes = s.objects.get('EYES_ACTOR')
target = first_eyes.matrix_world.translation.copy() if first_eyes else Vector((0, 0, 1.5))
if cam_spec.get('at'):
    cam.location = Vector(cam_spec['at'])
elif bounds:
    # Across the room from the first performer, at eye height: somewhere to start from.
    centre = Vector(((bounds[0] + bounds[1]) / 2, (bounds[2] + bounds[3]) / 2))
    away = (centre - target.xy)
    away = away.normalized() if away.length > 1e-6 else Vector((0, -1))
    reach = 0.8 * min(bounds[1] - bounds[0], bounds[3] - bounds[2]) / 2
    cam.location = Vector((centre.x + away.x * reach * 0.5, centre.y + away.y * reach * 0.5, 1.6))
else:
    cam.location = target + Vector((0, -2.5, 0))
cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
s.camera = cam
w, h = (take['clock'].get('size') or [1344, 576])
s.render.resolution_x, s.render.resolution_y = int(w), int(h)

bpy.ops.wm.save_as_mainfile(filepath=str(TAKE_DIR / 'take.blend'), copy=False)

# Eye points on every frame, in Blender's coordinates: the camera setup page aims and
# moves cameras from these, and sends the resulting path back to be staged exactly.
for pid, pm in manifest['performers'].items():
    e = s.objects[pm['eyes']]
    for row in pm['frames']:
        s.frame_set(row['frame'])
        p = e.matrix_world.translation
        row['eyes'] = [round(p.x, 4), round(p.y, 4), round(p.z, 4)]
s.frame_set(1)

# The browser's copy. glTF cannot key visibility, so a figure variant the take never uses
# (the seated one, usually) is removed from this export; the .blend keeps both.
never_seated = {pid for pid, pm in manifest['performers'].items() if all(r['pose'] != 'seated' for r in pm['frames'])}
for pid in never_seated:
    sit = s.objects.get(f'PROXY_{pid.upper()}_SIT')
    if sit:
        for o in list(sit.children_recursive) + [sit]:
            bpy.data.objects.remove(o, do_unlink=True)
for o in [o for o in s.objects if o.type in ('CAMERA', 'LIGHT')]:
    o.hide_set(True)
try:
    bpy.ops.export_scene.gltf(
        filepath=str(TAKE_DIR / 'take.glb'), export_format='GLB', export_apply=True,
        export_animations=True, export_animation_mode='SCENE', export_force_sampling=True,
        export_frame_range=True, export_cameras=False, export_lights=False, export_yup=True,
        use_visible=True)
    manifest['glb'] = 'take.glb'
except Exception as e:  # the .blend is what staging uses; the browser copy is a convenience
    warnings.append(f'the browser copy (take.glb) was not exported: {e}')
(TAKE_DIR / 'take_manifest.json').write_text(json.dumps(manifest, indent=1), encoding='utf-8')
print('TAKE_SAVED', json.dumps({'performers': len(manifest['performers']), 'frames': frames,
                                'cues': len(take.get('cues') or []), 'warnings': warnings}), flush=True)
