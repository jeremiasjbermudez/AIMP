"""Cut a 360-degree panorama into four views: north, east, south and west.

    blender -b --factory-startup --python pano_views.py -- <panorama> <out dir> [size]

The views are the ones build_blockout.py renders of a block-out: 90 degrees wide,
square, level, from the middle of the room. A model reading them to write a
block-out, and then comparing its block-out with them, sees the same framing both
times.

The middle of the panorama is taken as north (+Y), and turning right in it as
turning east, as in a panorama viewer. Rendered with Cycles from the world
background alone, so it is an exact reprojection with nothing else in the scene.
"""
import bpy
import json
import math
import sys
from pathlib import Path

argv = sys.argv[sys.argv.index('--') + 1:]
PANO, OUT = Path(argv[0]), Path(argv[1])
SIZE = int(argv[2]) if len(argv) > 2 else 768
OUT.mkdir(parents=True, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 1
scene.cycles.use_denoising = False
scene.render.resolution_x = scene.render.resolution_y = SIZE
scene.render.image_settings.file_format = 'PNG'
scene.view_settings.view_transform = 'Standard'   # the panorama's own colours, not Filmic/AgX

world = bpy.data.worlds.new('Panorama')
scene.world = world
world.use_nodes = True
nt = world.node_tree
env = nt.nodes.new('ShaderNodeTexEnvironment')
env.image = bpy.data.images.load(str(PANO))
env.projection = 'EQUIRECTANGULAR'
# Blender puts the middle of an equirectangular image at +X. Turning the lookup
# by -90 degrees puts it at +Y, north.
coord = nt.nodes.new('ShaderNodeTexCoord')
mapping = nt.nodes.new('ShaderNodeMapping')
mapping.inputs['Rotation'].default_value = (0, 0, math.radians(-90))
nt.links.new(coord.outputs['Generated'], mapping.inputs['Vector'])
nt.links.new(mapping.outputs['Vector'], env.inputs['Vector'])
nt.links.new(env.outputs['Color'], nt.nodes['Background'].inputs['Color'])

cam_data = bpy.data.cameras.new('VIEW')
cam_data.lens_unit = 'FOV'
cam_data.angle = math.radians(90)
cam = bpy.data.objects.new('VIEW', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

views = []
for tag, yaw in (('N', 0), ('E', -90), ('S', 180), ('W', 90)):
    cam.rotation_euler = (math.radians(90), 0, math.radians(yaw))
    scene.render.filepath = str(OUT / f'view_{tag}.png')
    bpy.ops.render.render(write_still=True)
    views.append(f'view_{tag}.png')

(OUT / 'views.json').write_text(json.dumps({'panorama': str(PANO), 'size': SIZE, 'views': views}), encoding='utf-8')
print('PANO_VIEWS', json.dumps(views), flush=True)
