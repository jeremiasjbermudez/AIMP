"""Where a set's files are, for the Blender scripts in this folder.

These scripts came from camera_lab (movie-mvp), where every path was relative to
that project's folders. In AIMP a set lives in one sets folder on the render host:

    <sets root>/locations/<id>/<revision>/location.json, location.blend
    <sets root>/shots/<project>/<shot id>/shot.json, blender/...

The sets root is AIMP_SETS_ROOT. A shot may also name its location files
outright (location.location_json / location.scene_blend as absolute paths), and
a camera_lab checkout still works as it did.
"""
import json
import os
from pathlib import Path


def sets_root(shot_dir):
    env = os.environ.get('AIMP_SETS_ROOT')
    if env:
        return Path(env)
    # camera_lab layout: <root>/camera_lab/shots/<shot>
    return Path(shot_dir).resolve().parents[2]


def location_dir(shot, shot_dir):
    loc = shot['location']
    explicit = loc.get('location_json')
    if explicit and Path(explicit).is_absolute():
        return Path(explicit).parent
    root = sets_root(shot_dir)
    for candidate in (root / 'locations' / loc['id'] / loc['revision'],
                      root / 'camera_lab' / 'locations' / loc['id'] / loc['revision']):
        if (candidate / 'location.json').exists():
            return candidate
    raise FileNotFoundError(f"no location.json for {loc['id']} {loc['revision']} under {root}")


def location_json(shot, shot_dir):
    return json.loads((location_dir(shot, shot_dir) / 'location.json').read_text())


def scene_blend(shot, shot_dir):
    return location_dir(shot, shot_dir) / 'location.blend'


def use_best_gpu(bpy):
    """The fastest render device this machine has: OptiX, CUDA, Metal, else the CPU.

    camera_lab forced Metal, which exists only on a Mac. The render host has an
    NVIDIA card; OptiX renders the same scene, on the same seed, faster.
    """
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA', 'METAL', 'HIP', 'ONEAPI'):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
        except Exception:
            continue
        devices = [d for d in prefs.devices if d.type == kind]
        if devices:
            for d in prefs.devices:
                d.use = d.type == kind
            bpy.context.scene.cycles.device = 'GPU'
            print('RENDER_DEVICE', kind, [d.name for d in devices], flush=True)
            return kind
    bpy.context.scene.cycles.device = 'CPU'
    print('RENDER_DEVICE CPU', flush=True)
    return 'CPU'
