# From camera_lab/pipeline/blender_stage.py (movie-mvp): the proxy actor, moved here
# unchanged so the shot stage and the take builder (build_take.py) build the same
# figure. Geometry and materials are exactly the stage's; only the wiring changed.
"""The smooth v2 proxy actor: a standing or seated figure of primitives, parented to a root.

    build(bpy, coll, root, pose)   pose 'standing' | 'seated'

Parts are named proxy_* (visibility.py treats proxy_ objects as the actor, not the set),
linked to `coll` and parented to `root`, whose local -Y is the figure's front.
Standing: eyes about 1.62 m above the root. Seated: authored for a 0.60 m seat.
"""
import math



def mat(name, rgb):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes['Principled BSDF']; b.inputs['Base Color'].default_value = (*rgb, 1); b.inputs['Roughness'].default_value = 0.85; return m
def part(name, kind, loc, scale, material, rot=(0, 0, 0)):
    if kind == 'sphere': bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1)
    elif kind == 'cyl': bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=1, depth=1)
    else: bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.active_object; o.name = name
    for c in list(o.users_collection): c.objects.unlink(o)
    coll.objects.link(o); o.parent = root; o.location = loc; o.scale = scale; o.rotation_euler = rot; o.data.materials.append(material)
    if kind == 'cube': bev = o.modifiers.new('bevel', 'BEVEL'); bev.width = 0.06; bev.segments = 4
    sub = o.modifiers.new('subsurf', 'SUBSURF'); sub.levels = 2; sub.render_levels = 3; bpy.ops.object.shade_smooth(); return o
def _figure(pose):
  if pose == 'standing':
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
  else:
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


def build(bpy_module, collection, root_object, pose):
    """Build the figure under root_object. The stage's code, with bpy/coll/root passed in."""
    global bpy, coll, root, SKIN, JACKET, SHIRT, TROUSER, HAIR
    bpy, coll, root = bpy_module, collection, root_object
    SKIN, JACKET, SHIRT, TROUSER, HAIR = mat('px_skin', (0.62, 0.45, 0.36)), mat('px_jacket', (0.80, 0.76, 0.66)), mat('px_shirt', (0.08, 0.08, 0.08)), mat('px_trouser', (0.12, 0.11, 0.10)), mat('px_hair', (0.85, 0.85, 0.85))
    _figure('standing' if pose == 'standing' else 'seated')
