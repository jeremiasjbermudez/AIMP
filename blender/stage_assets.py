# From camera_lab/pipeline (movie-mvp). Changed for AIMP: see blender/_sets.py.
"""Export Director's Stage assets for a location from a shot scene (proxy + cameras + marks):
  Blender -b <shot.blend> --python stage_assets.py -- <shot_dir> <director_web/public/locations/<id>>
Writes scene.json (Stage recipe: location, targets, cameras), floor-plan.json (bounds + furniture rectangles),
framing.glb (location meshes with simplified materials; proxies excluded), assets.json (provenance).
"""
import bpy, json, sys, hashlib, math
import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _sets
from pathlib import Path
from mathutils import Vector
argv = sys.argv[sys.argv.index('--') + 1:]; SHOT = Path(argv[0]); OUT = Path(argv[1]); OUT.mkdir(parents=True, exist_ok=True)
shot = json.loads((SHOT / 'shot.json').read_text())
loc = _sets.location_json(shot, SHOT)
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest(); s = bpy.context.scene
def bounds(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]; return [min(p[i] for p in pts) for i in range(3)], [max(p[i] for p in pts) for i in range(3)]
ch = shot['character']; eyes = s.objects['EYES_ACTOR'].matrix_world.translation; face_to = s.objects[ch['facing']].matrix_world.translation
targets = {'EYES_ACTOR': {'label': f"{ch['display']} · eyes", 'position': list(eyes)}, 'LOOK_TARGET': {'label': 'Eyeline target', 'position': [face_to.x, face_to.y, eyes.z]}}
cams = []
for o in [o for o in s.objects if o.type == 'CAMERA' and o.name.startswith('SHOT_')]:
    s.frame_set(s.frame_start); start = list(o.matrix_world.translation); rot = list(o.matrix_world.to_euler()); s.frame_set(s.frame_end); end = list(o.matrix_world.translation)
    mv = shot['camera']['move']
    cams.append({'id': o.name.replace('SHOT_', ''), 'name': o.name.replace('SHOT_', ''), 'lens_mm': o.data.lens, 'sensor_width_mm': o.data.sensor_width, 'start': start, 'end': end, 'rotation_euler_rad': rot, 'target_id': 'EYES_ACTOR', 'aim_mode': 'track', 'shift': [o.data.shift_x, o.data.shift_y], 'f_stop': o.data.dof.aperture_fstop, 'move': {'enabled': (Vector(end) - Vector(start)).length > 1e-4, 'start_frame': mv['start_frame'], 'end_frame': mv['end_frame'], 'easing': mv['easing']}})
s.frame_set(1)
scene = {'schema_version': 1, 'name': f"{loc['name']} / {shot['shot_id']}", 'location': {'id': loc['id'], 'revision': loc['revision'], 'sha256': sha(_sets.scene_blend(shot, SHOT)), 'lighting': shot['location']['lighting_state']}, 'fps': shot['clock']['fps'], 'frame_count': shot['clock']['frames'], 'resolution': shot['clock']['size'], 'targets': targets, 'cameras': cams}
(OUT / 'scene.json').write_text(json.dumps(scene, indent=2) + '\n')
meshes = [o for o in s.objects if o.type == 'MESH' and not o.name.startswith('proxy_') and not o.hide_render]
floor = [o for o in meshes if 'floor' in o.name.lower()] or meshes
furniture = []
for label, keys in [('Table', ('table top',)), ('Shelf', ('shelf unit',)), ('Chair W', ('chair west seat',)), ('Chair E', ('chair east seat',)), ('Desk', ('desk top',)), ('Walls', ('wall ',))]:
    objs = [o for o in meshes if any(o.name.lower().startswith(k) for k in keys)]
    if objs: lo, hi = bounds(objs); furniture.append([label, lo, hi])
(OUT / 'floor-plan.json').write_text(json.dumps({'bounds': bounds(floor), 'furniture': furniture}, indent=2) + '\n')
palette = {'wood': (.45, .30, .16, 1), 'metal': (.45, .45, .47, 1), 'paper': (.75, .70, .58, 1), 'cloth': (.16, .16, .15, 1), 'glass': (.55, .65, .80, 1), 'accent': (.80, .35, .08, 1)}
mats = {}
for name, color in palette.items():
    m = bpy.data.materials.new('Preview ' + name); m.use_nodes = True; m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = color; m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = .65; mats[name] = m
coll = bpy.data.collections.new('BROWSER_GEOMETRY'); s.collection.children.link(coll); copies = []
for old in meshes:
    n = old.name.lower(); key = 'metal' if any(k in n for k in ['leg', 'steel', 'thermos', 'cup', 'rail', 'shelf', 'chair', 'housing', 'lantern']) else 'paper' if 'map' in n else 'cloth' if 'duffel' in n else 'accent' if any(k in n for k in ['backpack', 'rope']) else 'glass' if 'frosted' in n else 'wood'
    o = old.copy(); o.data = old.data.copy(); o.animation_data_clear(); o.matrix_world = old.matrix_world.copy(); coll.objects.link(o); o.data.materials.clear(); o.data.materials.append(mats[key])
    for p in o.data.polygons: p.material_index = 0
    copies.append(o)
bpy.ops.object.select_all(action='DESELECT')
for o in copies: o.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(OUT / 'framing.glb'), export_format='GLB', use_selection=True, export_yup=True, export_cameras=False, export_lights=False)
(OUT / 'assets.json').write_text(json.dumps({'shot_id': shot['shot_id'], 'shot_blend': bpy.data.filepath, 'shot_blend_sha256': sha(bpy.data.filepath), 'location_sha256': scene['location']['sha256'], 'glb_sha256': sha(OUT / 'framing.glb'), 'preview': 'Block-out meshes, simplified materials; framing only.'}, indent=2))
print('STAGE_ASSETS_READY', OUT, flush=True)
