"""Build a location's Blender block-out from its declarative description.

    blender -b --factory-startup --python build_blockout.py -- <location dir>

Reads <location dir>/location.json and writes, beside it:
    location.blend          what blender_stage.py, visibility.py and tech_scout.py read
    build_report.json       objects built, warnings, errors
    previews/plan.png       the room from above, roof and ceiling hidden
    previews/view_N.png ... from the middle of the room at eye height, facing north,
                            east, south and west: the same four views pano_views.py
                            cuts from a panorama, so the two can be laid side by side

camera_lab's locations were built by a Python script per location, written by a
model. Here the model writes only data (the "blockout" key below) and this one
script builds every location from it, so nothing a model writes is executed.

Axes, as in camera_lab: metres, Z up, the room centred on the origin at floor
level. North is +Y, east is +X. Seen from above, turning right from north faces east.

location.json keys this reads (everything else is passed through untouched):
    id, revision, name, dimensions_m {width, depth, eave_height, ridge_height?},
    anchors {ANCHOR_name: [x, y, z]}, set_pieces {phrase: [object-name prefixes]},
    blockout {
      materials  {name: {rgb, rough?, metal?, emit?: {rgb, strength}}}
      room       {shape? 'rect'|'round', shell? (false: walls, floor and roof are among
                  the objects instead), wall_thickness?, wall, floor, ceiling?,
                  ridge_axis? 'y'|'x' (rect), segments? (round; default 32),
                  openings [{name, wall 'north'|'south'|'east'|'west', center,     (rect)
                             azimuth_deg (round: 0 north, 90 east),
                             bottom, width, height, fill?, frame?}]}
                 A round room's diameter is dimensions_m.width (depth should match);
                 its roof is a cone up to ridge_height, or a flat ceiling.
      objects    [{name, shape 'box'|'cylinder'|'cone'|'torus'|'sphere'|'poly',
                   at [x,y,z], rot_deg? [x,y,z], material,
                   size [x,y,z] (box) | radius, height, segments? (cylinder)
                   | radius1, radius2, height, segments? (cone)
                   | major, minor, segments?, ring? (torus) | radius, segments?, rings? (sphere)
                   | verts [[x,y,z]...], faces [[i,j,k...]...] (poly, world coordinates),
                   repeat? {count, step [dx,dy,dz]}, exterior? true,
                   cover? true (roof or ceiling: hidden in the plan)}]
      lights     [{name, type 'point'|'area'|'spot'|'sun', at, rot_deg?, energy, rgb?, size?}]
      world      {rgb, strength}
      view_from? [x, y, z]: where the reference panorama was taken from, and so
                 where the previews are rendered from (default [0, 0, 1.6])
    }
"""
import bpy
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _sets  # noqa: E402

LOC_DIR = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
spec = json.loads((LOC_DIR / 'location.json').read_text(encoding='utf-8'))
bo = spec.get('blockout') or {}
warnings, errors = [], []

if not bo:
    raise SystemExit('location.json has no "blockout": nothing to build from')

dims = spec.get('dimensions_m') or {}
W = float(dims.get('width', 0))
# A round room is as deep as it is wide.
D = float(dims.get('depth') or (W if (bo.get('room') or {}).get('shape') == 'round' else 0))
EAVE = float(dims.get('eave_height', 0))
RIDGE = float(dims.get('ridge_height') or EAVE)
if min(W, D, EAVE) <= 0:
    raise SystemExit('dimensions_m needs a positive width, depth and eave_height')

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = 'Scene'
scene.render.engine = 'CYCLES'
coll = bpy.data.collections.new('LOCATION_' + str(spec.get('id', 'set')).upper())
scene.collection.children.link(coll)
# Roof, ceiling and gables go in their own collection so the plan can hide them.
cover = bpy.data.collections.new('LOCATION_COVER')
coll.children.link(cover)


# ---------------------------------------------------------------- materials
materials = {}


def material(name):
    if not name:
        name = 'default'
    if name in materials:
        return materials[name]
    m_spec = (bo.get('materials') or {}).get(name)
    if m_spec is None:
        if name != 'default':
            warnings.append(f'material {name!r} is not defined; grey used')
        m_spec = {'rgb': [0.5, 0.5, 0.5]}
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*num3(m_spec.get('rgb', [0.5, 0.5, 0.5]), 'rgb of ' + name), 1)
    b.inputs['Roughness'].default_value = float(m_spec.get('rough', 0.7))
    b.inputs['Metallic'].default_value = float(m_spec.get('metal', 0.0))
    emit = m_spec.get('emit')
    if emit:
        b.inputs['Emission Color'].default_value = (*num3(emit.get('rgb', [1, 1, 1]), 'emit of ' + name), 1)
        b.inputs['Emission Strength'].default_value = float(emit.get('strength', 1.0))
    materials[name] = m
    return m


def num3(v, what):
    if not (isinstance(v, (list, tuple)) and len(v) == 3):
        raise ValueError(f'{what} must be three numbers, got {v!r}')
    return tuple(float(x) for x in v)


# ---------------------------------------------------------------- shapes
def link(o, into=None):
    for c in list(o.users_collection):
        c.objects.unlink(o)
    (into or coll).objects.link(o)
    return o


def finish(o, name, mat_name, rot=(0, 0, 0), into=None):
    o.name = name
    o.rotation_euler = tuple(math.radians(r) for r in rot)
    if o.type == 'MESH':
        o.data.materials.append(material(mat_name))
    return link(o, into)


def make(obj, at, into=None):
    """One object from its description, placed at `at` (repeat moves `at`)."""
    shape = obj.get('shape')
    name = str(obj.get('name') or shape)
    rot = num3(obj.get('rot_deg', [0, 0, 0]), f'rot_deg of {name}')
    mat_name = obj.get('material')
    if shape == 'box':
        bpy.ops.mesh.primitive_cube_add(size=1, location=at)
        o = bpy.context.active_object
        o.scale = num3(obj.get('size'), f'size of {name}')
    elif shape == 'cylinder':
        bpy.ops.mesh.primitive_cylinder_add(vertices=int(obj.get('segments', 24)), radius=float(obj['radius']),
                                            depth=float(obj['height']), location=at)
        o = bpy.context.active_object
    elif shape == 'cone':
        bpy.ops.mesh.primitive_cone_add(vertices=int(obj.get('segments', 32)), radius1=float(obj['radius1']),
                                        radius2=float(obj.get('radius2', 0)), depth=float(obj['height']), location=at)
        o = bpy.context.active_object
    elif shape == 'torus':
        bpy.ops.mesh.primitive_torus_add(major_segments=int(obj.get('segments', 48)), minor_segments=int(obj.get('ring', 12)),
                                         major_radius=float(obj['major']), minor_radius=float(obj['minor']), location=at)
        o = bpy.context.active_object
    elif shape == 'sphere':
        bpy.ops.mesh.primitive_uv_sphere_add(segments=int(obj.get('segments', 32)), ring_count=int(obj.get('rings', 16)),
                                             radius=float(obj['radius']), location=at)
        o = bpy.context.active_object
    elif shape == 'poly':
        verts = [num3(v, f'a vertex of {name}') for v in obj.get('verts') or []]
        faces = [tuple(int(i) for i in f) for f in obj.get('faces') or []]
        if not verts or not faces or any(i >= len(verts) for f in faces for i in f):
            raise ValueError(f'{name}: a poly needs verts and faces that index them')
        off = at
        me = bpy.data.meshes.new(name)
        me.from_pydata([(v[0] + off[0], v[1] + off[1], v[2] + off[2]) for v in verts], [], faces)
        me.update()
        o = bpy.data.objects.new(name, me)
        scene.collection.objects.link(o)
    else:
        raise ValueError(f'{name}: unknown shape {shape!r}')
    return finish(o, name, mat_name, rot, into)


def box(name, center, size, mat_name, into=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    o = bpy.context.active_object
    o.scale = size
    return finish(o, name, mat_name, into=into)


def poly(name, verts, faces, mat_name, into=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    o = bpy.data.objects.new(name, me)
    scene.collection.objects.link(o)
    return finish(o, name, mat_name, into=into)


# ---------------------------------------------------------------- the room
room = bo.get('room') or {}
ROUND = room.get('shape') == 'round'
SHELL = room.get('shell', True) is not False
T = float(room.get('wall_thickness', 0.04))
WALL = room.get('wall')
if SHELL and not ROUND:
    box('Floor', (0, 0, -T / 2), (W + 2 * T, D + 2 * T, T), room.get('floor'))

# A wall is a run along one side, cut into pieces around its openings.
# `u` runs along the wall in room coordinates: x for north and south, y for east and west.
WALLS = {
    'north': {'axis': 'x', 'len': W, 'fixed': D / 2 + T / 2},
    'south': {'axis': 'x', 'len': W, 'fixed': -D / 2 - T / 2},
    'east': {'axis': 'y', 'len': D, 'fixed': W / 2 + T / 2},
    'west': {'axis': 'y', 'len': D, 'fixed': -W / 2 - T / 2},
}


def wall_piece(side, u0, u1, z0, z1, name):
    if u1 - u0 < 1e-4 or z1 - z0 < 1e-4:
        return
    w = WALLS[side]
    uc, zc = (u0 + u1) / 2, (z0 + z1) / 2
    if w['axis'] == 'x':
        box(name, (uc, w['fixed'], zc), (u1 - u0, T, z1 - z0), WALL)
    else:
        box(name, (w['fixed'], uc, zc), (T, u1 - u0, z1 - z0), WALL)


openings = room.get('openings') or []
for side, w in (WALLS.items() if SHELL and not ROUND else ()):
    ours = sorted([o for o in openings if o.get('wall') == side], key=lambda o: float(o.get('center', 0)))
    half = w['len'] / 2
    # The side walls run past the corners by a wall's thickness, so corners close.
    lo, hi = (-half - T, half + T) if w['axis'] == 'y' else (-half, half)
    cursor = lo
    for i, op in enumerate(ours):
        c, ow = float(op.get('center', 0)), float(op.get('width', 0.8))
        bottom, height = float(op.get('bottom', 0)), float(op.get('height', 2.0))
        u0, u1 = c - ow / 2, c + ow / 2
        if u0 < -half - 1e-6 or u1 > half + 1e-6 or bottom + height > EAVE + 1e-6:
            warnings.append(f'opening {op.get("name", side)} does not fit in the {side} wall')
        wall_piece(side, cursor, u0, 0, EAVE, f'Wall {side} {i}a')
        wall_piece(side, u0, u1, 0, bottom, f'Wall {side} {i} below')
        wall_piece(side, u0, u1, bottom + height, EAVE, f'Wall {side} {i} header')
        cursor = u1
        nm = str(op.get('name') or f'{side} opening {i}')
        w_ = WALLS[side]
        centre = (c, w_['fixed'], bottom + height / 2) if w_['axis'] == 'x' else (w_['fixed'], c, bottom + height / 2)
        pane = (ow, T * 0.5, height) if w_['axis'] == 'x' else (T * 0.5, ow, height)
        if op.get('fill'):
            box(nm, centre, pane, op['fill'])
        if op.get('frame'):
            f = 0.06
            if w_['axis'] == 'x':
                box(nm + ' frame left', (u0 - f / 2, w_['fixed'], bottom + height / 2), (f, T * 2, height), op['frame'])
                box(nm + ' frame right', (u1 + f / 2, w_['fixed'], bottom + height / 2), (f, T * 2, height), op['frame'])
                box(nm + ' frame head', (c, w_['fixed'], bottom + height + f / 2), (ow + 2 * f, T * 2, f), op['frame'])
            else:
                box(nm + ' frame left', (w_['fixed'], u0 - f / 2, bottom + height / 2), (T * 2, f, height), op['frame'])
                box(nm + ' frame right', (w_['fixed'], u1 + f / 2, bottom + height / 2), (T * 2, f, height), op['frame'])
                box(nm + ' frame head', (w_['fixed'], c, bottom + height + f / 2), (T * 2, ow + 2 * f, f), op['frame'])
    wall_piece(side, cursor, hi, 0, EAVE, f'Wall {side} end')

# Roof: a pitched roof when the ridge is above the eaves, a flat ceiling otherwise.
CEIL = room.get('ceiling') or WALL
if not SHELL:
    pass
elif ROUND:
    # A ring of flat panels. An opening takes out the middle of the panels it
    # crosses, leaving what is below and above it, as on a straight wall.
    R = W / 2
    n = max(8, int(room.get('segments', 32)))
    step = 2 * math.pi / n
    panel_w = 2 * (R + T) * math.tan(step / 2) + 0.01
    rnd_open = [o for o in openings if 'azimuth_deg' in o]
    for o in openings:
        if 'azimuth_deg' not in o:
            warnings.append(f'opening {o.get("name")} needs azimuth_deg in a round room')
    for k in range(n):
        a = k * step
        centre = ((R + T / 2) * math.sin(a), (R + T / 2) * math.cos(a))
        cut = None
        for op in rnd_open:
            half = float(op.get('width', 0.8)) / 2 / R + 1e-6
            d = (a - math.radians(float(op['azimuth_deg'])) + math.pi) % (2 * math.pi) - math.pi
            if abs(d) < half + step / 2:   # the panel overlaps the opening
                cut = op
                break
        spans = [(0, EAVE)] if not cut else [
            (0, float(cut.get('bottom', 0))),
            (float(cut.get('bottom', 0)) + float(cut.get('height', 2.0)), EAVE)]
        for j, (z0, z1) in enumerate(spans):
            if z1 - z0 > 1e-4:
                o = box(f'Wall {k:02d}' + (f' {"below" if j == 0 else "header"}' if cut else ''),
                        (centre[0], centre[1], (z0 + z1) / 2), (panel_w, T, z1 - z0), WALL)
                o.rotation_euler = (0, 0, -a)
    for i, op in enumerate(rnd_open):
        a = math.radians(float(op['azimuth_deg']))
        bottom, height, ow = float(op.get('bottom', 0)), float(op.get('height', 2.0)), float(op.get('width', 0.8))
        nm = str(op.get('name') or f'opening {i}')
        if op.get('fill'):
            o = box(nm, ((R + T / 2) * math.sin(a), (R + T / 2) * math.cos(a), bottom + height / 2), (ow, T * 0.5, height), op['fill'])
            o.rotation_euler = (0, 0, -a)
        if op.get('frame'):
            # Left, right and head pieces, along the wall's tangent at the opening.
            f, r = 0.06, R + T / 2
            tx, ty = math.cos(a), -math.sin(a)
            cx, cy = r * math.sin(a), r * math.cos(a)
            for part, off in (('left', -(ow + f) / 2), ('right', (ow + f) / 2)):
                o = box(f'{nm} frame {part}', (cx + tx * off, cy + ty * off, bottom + height / 2), (f, T * 2, height), op['frame'])
                o.rotation_euler = (0, 0, -a)
            o = box(f'{nm} frame head', (cx, cy, bottom + height + f / 2), (ow + 2 * f, T * 2, f), op['frame'])
            o.rotation_euler = (0, 0, -a)
    bpy.ops.mesh.primitive_cylinder_add(vertices=n, radius=R + T, depth=T, location=(0, 0, -T / 2))
    finish(bpy.context.active_object, 'Floor', room.get('floor'))
    if RIDGE > EAVE + 1e-3:
        bpy.ops.mesh.primitive_cone_add(vertices=n, radius1=R + T, radius2=0, depth=RIDGE - EAVE, location=(0, 0, (EAVE + RIDGE) / 2))
        finish(bpy.context.active_object, 'Roof', room.get('ceiling') or WALL, into=cover)
    else:
        bpy.ops.mesh.primitive_cylinder_add(vertices=n, radius=R + T, depth=T, location=(0, 0, EAVE + T / 2))
        finish(bpy.context.active_object, 'Ceiling', room.get('ceiling') or WALL, into=cover)
elif RIDGE > EAVE + 1e-3:
    along_y = room.get('ridge_axis', 'y') == 'y'
    if along_y:
        hx, y0, y1 = W / 2 + T, -D / 2 - T, D / 2 + T
        poly('Roof west', [(-hx, y0, EAVE), (0, y0, RIDGE), (0, y1, RIDGE), (-hx, y1, EAVE)], [(0, 1, 2, 3)], CEIL, cover)
        poly('Roof east', [(hx, y0, EAVE), (0, y0, RIDGE), (0, y1, RIDGE), (hx, y1, EAVE)], [(0, 1, 2, 3)], CEIL, cover)
        for nm, y in (('Gable north', D / 2 + T), ('Gable south', -D / 2 - T)):
            poly(nm, [(-W / 2, y, EAVE), (W / 2, y, EAVE), (0, y, RIDGE)], [(0, 1, 2)], WALL, cover)
    else:
        hy, x0, x1 = D / 2 + T, -W / 2 - T, W / 2 + T
        poly('Roof south', [(x0, -hy, EAVE), (x0, 0, RIDGE), (x1, 0, RIDGE), (x1, -hy, EAVE)], [(0, 1, 2, 3)], CEIL, cover)
        poly('Roof north', [(x0, hy, EAVE), (x0, 0, RIDGE), (x1, 0, RIDGE), (x1, hy, EAVE)], [(0, 1, 2, 3)], CEIL, cover)
        for nm, x in (('Gable east', W / 2 + T), ('Gable west', -W / 2 - T)):
            poly(nm, [(x, -D / 2, EAVE), (x, D / 2, EAVE), (x, 0, RIDGE)], [(0, 1, 2)], WALL, cover)
else:
    box('Ceiling', (0, 0, EAVE + T / 2), (W + 2 * T, D + 2 * T, T), CEIL, cover)

# ---------------------------------------------------------------- objects
built = 0
for obj in bo.get('objects') or []:
    try:
        at = num3(obj.get('at', [0, 0, 0]), f'at of {obj.get("name")}')
        rep = obj.get('repeat') or {}
        count = max(1, min(int(rep.get('count', 1)), 200))
        step = num3(rep.get('step', [0, 0, 0]), f'repeat step of {obj.get("name")}') if count > 1 else (0, 0, 0)
        for i in range(count):
            p = (at[0] + step[0] * i, at[1] + step[1] * i, at[2] + step[2] * i)
            o = make(dict(obj, name=obj.get('name') if count == 1 else f'{obj.get("name")} {i + 1}'), p,
                     cover if obj.get('cover') else None)
            built += 1
            if not obj.get('exterior'):
                x, y, z = p
                if abs(x) > W / 2 + 0.3 or abs(y) > D / 2 + 0.3 or z < -0.3 or z > max(RIDGE, EAVE) + 0.3:
                    warnings.append(f'{o.name} is outside the room at {tuple(round(v, 2) for v in p)}; mark it exterior if it is meant to be')
    except (KeyError, ValueError, TypeError) as e:
        errors.append(f'{obj.get("name", "an object")}: {e}')

# ---------------------------------------------------------------- lights, world, marks
for lt in bo.get('lights') or []:
    try:
        kind = str(lt.get('type', 'point')).upper()
        if kind not in ('POINT', 'AREA', 'SPOT', 'SUN'):
            raise ValueError(f'unknown light type {lt.get("type")!r}')
        name = str(lt.get('name') or kind.title())
        data = bpy.data.lights.new(name, kind)
        data.energy = float(lt.get('energy', 20))
        data.color = num3(lt.get('rgb', [1, 1, 1]), f'rgb of {name}')
        if kind == 'AREA':
            data.size = float(lt.get('size', 0.5))
        elif kind in ('POINT', 'SPOT'):
            data.shadow_soft_size = float(lt.get('size', 0.1))
        o = bpy.data.objects.new(name, data)
        coll.objects.link(o)
        o.location = num3(lt.get('at', [0, 0, EAVE - 0.2]), f'at of {name}')
        o.rotation_euler = tuple(math.radians(r) for r in num3(lt.get('rot_deg', [0, 0, 0]), f'rot_deg of {name}'))
    except (ValueError, TypeError) as e:
        errors.append(f'light {lt.get("name")}: {e}')
if not bo.get('lights'):
    warnings.append('no lights: the plates will be lit by the world alone')

wd = bo.get('world') or {'rgb': [0.25, 0.28, 0.32], 'strength': 0.3}
world = bpy.data.worlds.new('World')
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes['Background']
bg.inputs['Color'].default_value = (*num3(wd.get('rgb', [0.25, 0.28, 0.32]), 'world rgb'), 1)
bg.inputs['Strength'].default_value = float(wd.get('strength', 0.3))

for name, pos in (spec.get('anchors') or {}).items():
    e = bpy.data.objects.new(name, None)
    coll.objects.link(e)
    e.location = num3(pos, f'anchor {name}')
    e.empty_display_size = 0.15
    if abs(pos[0]) > W / 2 or abs(pos[1]) > D / 2:
        warnings.append(f'{name} is outside the room')

names = [o.name for o in coll.all_objects]
for phrase, prefixes in (spec.get('set_pieces') or {}).items():
    if not any(n.startswith(p) for p in prefixes for n in names):
        warnings.append(f'set piece {phrase!r} names no object ({", ".join(prefixes)})')

scene.render.resolution_x, scene.render.resolution_y = 1344, 576
bpy.ops.wm.save_as_mainfile(filepath=str(LOC_DIR / 'location.blend'), copy=False)
print('LOCATION_SAVED', LOC_DIR / 'location.blend', len(names), 'objects', flush=True)

# ---------------------------------------------------------------- previews
_sets.use_best_gpu(bpy)
prev = LOC_DIR / 'previews'
prev.mkdir(exist_ok=True)
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.image_settings.file_format = 'PNG'


def render_to(path):
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


cam_data = bpy.data.cameras.new('PREVIEW')
cam = bpy.data.objects.new('PREVIEW', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

# The four views, matching pano_views.py: 90 degrees wide, square, from where the
# panorama was taken, so a view and its reference can be compared like for like.
try:
    view_from = num3(bo.get('view_from', [0, 0, float(bo.get('eye_height', 1.6))]), 'view_from')
except ValueError as e:
    warnings.append(str(e))
    view_from = (0, 0, 1.6)
cam_data.lens_unit = 'FOV'
cam_data.angle = math.radians(90)
scene.render.resolution_x = scene.render.resolution_y = 768
cam.location = view_from
for tag, yaw in (('N', 0), ('E', -90), ('S', 180), ('W', 90)):
    # A Blender camera looks down -Z; X 90 levels it to look along +Y, then Z turns it.
    cam.rotation_euler = (math.radians(90), 0, math.radians(yaw))
    render_to(prev / f'view_{tag}.png')

# The plan: straight down, orthographic, with the roof lifted off.
cover.hide_render = True
cam_data.type = 'ORTHO'
span = max(W, D) + 1.0
cam_data.ortho_scale = span
scene.render.resolution_x = int(768 * (W + 1.0) / span)
scene.render.resolution_y = int(768 * (D + 1.0) / span)
cam.location = (0, 0, max(RIDGE, EAVE) + 5)
cam.rotation_euler = (0, 0, 0)
sun = bpy.data.objects.new('PLAN_LIGHT', bpy.data.lights.new('PLAN_LIGHT', 'SUN'))
sun.data.energy = 3
scene.collection.objects.link(sun)
render_to(prev / 'plan.png')

report = {'objects': len(names), 'built': built, 'warnings': warnings, 'errors': errors,
          'previews': ['previews/plan.png'] + [f'previews/view_{t}.png' for t in 'NESW']}
(LOC_DIR / 'build_report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print('BUILD_REPORT', json.dumps({'objects': len(names), 'warnings': len(warnings), 'errors': len(errors)}), flush=True)
