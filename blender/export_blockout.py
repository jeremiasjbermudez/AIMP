"""Describe an existing location.blend as a declarative block-out.

    blender -b <location.blend> --python export_blockout.py -- <out.json>

camera_lab's locations were built by one Python script each. This reads what such
a script built and writes it as build_blockout.py's "blockout" data, so a model
can revise the location as data from then on. Rebuilding the export must give the
same room: that is how build_blockout.py was checked against warming_hut v007.

Primitives are recognised by the mesh Blender gave them (Cube, Cylinder, Cone,
Torus, Sphere) and measured from their vertices; anything else is written as a
poly in world coordinates, which is exact but not pleasant to edit.
"""
import bpy
import json
import math
import sys
from pathlib import Path

OUT = Path(sys.argv[sys.argv.index('--') + 1])
scene = bpy.context.scene

r4 = lambda v: round(float(v), 4)


def vec(v):
    return [r4(x) for x in v]


def rot(o):
    return [r4(math.degrees(a)) for a in o.rotation_euler]


materials = {}


def material_of(o):
    if not o.data.materials:
        return None
    m = o.data.materials[0]
    if m.name in materials or not m.use_nodes:
        return m.name
    b = m.node_tree.nodes.get('Principled BSDF')
    if not b:
        materials[m.name] = {'rgb': [0.5, 0.5, 0.5]}
        return m.name
    spec = {'rgb': vec(b.inputs['Base Color'].default_value[:3]),
            'rough': r4(b.inputs['Roughness'].default_value),
            'metal': r4(b.inputs['Metallic'].default_value)}
    strength = b.inputs['Emission Strength'].default_value
    if strength > 0 and any(c > 0 for c in b.inputs['Emission Color'].default_value[:3]):
        spec['emit'] = {'rgb': vec(b.inputs['Emission Color'].default_value[:3]), 'strength': r4(strength)}
    materials[m.name] = spec
    return m.name


def radius_xy(vs):
    return max(math.hypot(v.co.x, v.co.y) for v in vs)


def describe(o):
    me = o.data
    kind = me.name.split('.')[0]
    vs = me.vertices
    zs = [v.co.z for v in vs]
    uniform = all(abs(s - 1) < 1e-6 for s in o.scale)
    base = {'name': o.name, 'at': vec(o.location), 'material': material_of(o)}
    if any(abs(a) > 1e-6 for a in o.rotation_euler):
        base['rot_deg'] = rot(o)
    n = len(vs)
    if kind == 'Cube' and n == 8:
        span = [max(v.co[i] for v in vs) - min(v.co[i] for v in vs) for i in range(3)]
        return dict(base, shape='box', size=[r4(span[i] * o.scale[i]) for i in range(3)])
    if kind == 'Cylinder' and uniform and n % 2 == 0:
        return dict(base, shape='cylinder', radius=r4(radius_xy(vs)), height=r4(max(zs) - min(zs)), segments=n // 2)
    if kind == 'Cone' and uniform:
        lo, hi = min(zs), max(zs)
        bottom = [v for v in vs if abs(v.co.z - lo) < 1e-6]
        top = [v for v in vs if abs(v.co.z - hi) < 1e-6]
        return dict(base, shape='cone', radius1=r4(radius_xy(bottom)), radius2=r4(radius_xy(top)) if len(top) > 1 else 0,
                    height=r4(hi - lo), segments=len(bottom))
    if kind == 'Torus' and uniform:
        rs = [math.hypot(v.co.x, v.co.y) for v in vs]
        rmax, rmin = max(rs), min(rs)
        ring = len({round(v.co.z, 5) for v in vs}) if n else 12
        ring = 12 if n % 12 == 0 else ring
        return dict(base, shape='torus', major=r4((rmax + rmin) / 2), minor=r4((rmax - rmin) / 2), segments=n // ring, ring=ring)
    if kind == 'Sphere' and uniform:
        rings = 16 if (n - 2) % 16 == 0 else 16
        segments = (n - 2) // (rings - 1)
        return dict(base, shape='sphere', radius=r4(max(v.co.length for v in vs)), segments=segments, rings=rings)
    # Anything else: exact, in world coordinates.
    mw = o.matrix_world
    out = {'name': o.name, 'shape': 'poly', 'material': material_of(o),
           'verts': [vec(mw @ v.co) for v in vs], 'faces': [list(p.vertices) for p in me.polygons]}
    return out


objects, lights = [], []
for o in scene.objects:
    if o.name.startswith(('PROXY_', 'proxy_', 'SHOT_', 'EYES_', 'PREVIEW', 'PLAN_')):
        continue
    if o.type == 'MESH':
        d = describe(o)
        if o.name.startswith(('Roof', 'Gable', 'Ceiling')):
            d['cover'] = True
        objects.append(d)
    elif o.type == 'LIGHT':
        L = o.data
        lt = {'name': o.name, 'type': L.type.lower(), 'at': vec(o.location), 'energy': r4(L.energy), 'rgb': vec(L.color)}
        if any(abs(a) > 1e-6 for a in o.rotation_euler):
            lt['rot_deg'] = rot(o)
        if L.type == 'AREA':
            lt['size'] = r4(L.size)
        elif L.type in ('POINT', 'SPOT'):
            lt['size'] = r4(L.shadow_soft_size)
        lights.append(lt)

world = {'rgb': [0.25, 0.28, 0.32], 'strength': 0.3}
if scene.world and scene.world.use_nodes and scene.world.node_tree.nodes.get('Background'):
    bg = scene.world.node_tree.nodes['Background']
    world = {'rgb': vec(bg.inputs['Color'].default_value[:3]), 'strength': r4(bg.inputs['Strength'].default_value)}

blockout = {'materials': materials, 'room': {'shell': False}, 'objects': objects, 'lights': lights, 'world': world}
OUT.write_text(json.dumps(blockout, indent=1), encoding='utf-8')
print('EXPORTED', len(objects), 'objects', len(lights), 'lights', len(materials), 'materials', flush=True)
