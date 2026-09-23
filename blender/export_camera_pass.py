"""Read an operated camera pass out of a saved take, for staging.

    blender -b <take.blend> --python export_camera_pass.py -- <out.json> [camera name]

After recording with VirtuCamera (or animating a camera by hand) in a take.blend and
saving it: every frame of the take's range, the camera's world matrix and focal
length, plus a summary. send_camera_pass.py sends it to 48-Blender-Sets as a shot
on the take ("stage" with takeId and shot.cameraPath).

The camera is TAKE_CAM unless named; frames past the last keyframe hold the last
position, as Blender plays them.
"""
import bpy
import json
import math
import sys

argv = sys.argv[sys.argv.index('--') + 1:]
out = argv[0]
s = bpy.context.scene
cam = s.objects.get(argv[1] if len(argv) > 1 else 'TAKE_CAM') or s.camera
if cam is None or cam.type != 'CAMERA':
    raise SystemExit('no camera to export (TAKE_CAM, or name one)')
eyes = s.objects.get('EYES_ACTOR')

rows = []
for f in range(s.frame_start, s.frame_end + 1):
    s.frame_set(f)
    m = cam.matrix_world
    rows.append({
        'frame': f - s.frame_start + 1,
        'matrix': [list(r) for r in m],
        'lens': cam.data.lens,
        'dist_to_eyes': (m.translation - eyes.matrix_world.translation).length if eyes else None,
    })

keyed = sorted({int(k.co[0]) for fc in (cam.animation_data.action.fcurves if cam.animation_data and cam.animation_data.action else [])
                for k in fc.keyframe_points})
pos = [(r['matrix'][0][3], r['matrix'][1][3], r['matrix'][2][3]) for r in rows]
summary = {
    'camera': cam.name, 'frames': len(rows), 'keyed_frames': [keyed[0], keyed[-1]] if keyed else None,
    'travel_m': round(sum(math.dist(pos[i], pos[i - 1]) for i in range(1, len(pos))), 3),
    'lens_mm': [min(r['lens'] for r in rows), max(r['lens'] for r in rows)],
    'closest_to_eyes_m': round(min(r['dist_to_eyes'] for r in rows), 3) if eyes else None,
}
json.dump({'summary': summary, 'frames': rows}, open(out, 'w'))
print('CAMERA_PASS', json.dumps(summary), flush=True)
