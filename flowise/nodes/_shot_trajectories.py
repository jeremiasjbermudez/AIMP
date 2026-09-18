"""Make the world travel to the shot cameras.

WHY. A splat is sharp where the world has been and smear where it has not.
HY-World expands a world along trajectories - WorldStereo generates photographs
along each path, constrained by the memory bank, and the gaussians are then
fitted to all of them. The builder plans its own paths (navigation targets,
anchor scans). Nothing ever sent it to where the SHOTS stand, so a plate
rendered from a shot camera is a render of somewhere the world never looked.

This writes one trajectory per shot into the workspace, in exactly the form the
builder's own planner writes (render_results/target_*/traj0/camera.json, 21
frames, the panorama intrinsics), so that the next build treats them as its own:
`HYWorld2Trajectories` picks them up from the folder, `HYWorld2WorldExpansion`
generates only the ones without a result, and training sees the shot positions.
After that, rendering the splat from a shot camera is APPLIED - the room's own
geometry - and clean.

Each trajectory sweeps from the panorama point (the origin, where every base
view was taken) AROUND the shot's subject to the shot position, aimed at the
subject the whole way - so every frame is a sensible view of it, the path never
crosses it, and the model is never asked to invent a view of nothing.

Cameras are the pack's own convention: `_make_anchor_scan_c2ws` builds columns
right / down / forward with world up +Z - which is OpenCV, which is what
look_at() already produces. No axis mapping.

Usage:
    python -X utf8 _shot_trajectories.py --plan <scene_floor_plans.id> --director-plan <id>
                                         [--frames 21] [--dry-run] [--render]
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _splat_camera import look_at, resolve, rows  # noqa: E402

NFRAME = 21           # what the builder's own trajectories use
SETTLE = 4            # frames held at the shot camera at the end of the dolly
PACK = r"C:/ComfyUI2/custom_nodes/ComfyUI_HYWorld2"


def pack_imports():
    """The pack's own panorama slicer, so start frames match the planner's exactly."""
    sys.path.insert(0, PACK)
    sys.path.insert(0, r"C:/ComfyUI2")
    from hyworld2.worldgen.src.panorama_utils import split_panorama_image  # noqa: E402
    return split_panorama_image


def workspace_panorama(workspace):
    """What the planner reads: the super-resolved panorama if there is one, else the source."""
    from PIL import Image
    for name in ("panorama_sr.png", "panorama.png"):
        p = os.path.join(workspace, name)
        if os.path.exists(p):
            return Image.open(p).convert("RGB")
    sys.exit(f"no panorama.png in {workspace}")


def start_frame(pano, w2c0, K, w, h, split):
    """The photograph at frame 0 - the panorama sliced at the first camera.

    Exactly what the planner and the anchor-scan writer do: intrinsics normalised
    by the frame size, INTER_AREA, first camera only. Frame 0 sits at the origin,
    which is where the panorama was taken, so this is a real photograph and the
    renderer uses it as the literal first frame of the trajectory.
    """
    import cv2
    K_pano = K.copy()
    K_pano[0, :] /= w
    K_pano[1, :] /= h
    return split(np.array(pano), w2c0[None], np.array([K_pano]), h=h, w=w, interp=cv2.INTER_AREA)[0]


def workspace_of(ply_path):
    p = os.path.normpath(ply_path)
    return os.path.dirname(os.path.dirname(os.path.dirname(p)))


def base_intrinsics(workspace):
    """The panorama slice intrinsics - the size the world was built at."""
    cams = os.path.join(workspace, "render_results", "pano_bank", "cameras.json")
    with open(cams, encoding="utf-8") as fh:
        c = json.load(fh)
    K = np.asarray(next(iter(c.values()))["intrinsic"], dtype=np.float64)
    return K, int(round(K[0][2] * 2)), int(round(K[1][2] * 2))


def arc(pos, target, up, n, settle):
    """W2C matrices from the origin to `pos`, sweeping AROUND `target`.

    Not a straight line. The panorama point is a metre and a half from the
    desk and a wide shot stands six metres beyond it, so a straight dolly
    would pass over the desk and spin the camera to look straight down at it
    - which is exactly the frame that failed the orientation check. Instead
    the camera's bearing, horizontal distance and height are each
    interpolated about the subject, so every frame is a sensible view of it
    and the path never crosses the thing it is looking at.
    """
    up = np.asarray(up, dtype=np.float64)
    up = up / np.linalg.norm(up)
    target = np.asarray(target, dtype=np.float64)
    pos = np.asarray(pos, dtype=np.float64)
    origin = np.zeros(3)

    def polar(p):
        rel = p - target
        h = float(np.dot(rel, up))
        flat = rel - up * h
        r = float(np.linalg.norm(flat))
        return h, r, (flat / r if r > 1e-9 else None)

    h0, r0, d0 = polar(origin)
    h1, r1, d1 = polar(pos)
    if d0 is None:
        d0 = d1
    if d1 is None:
        d1 = d0
    # Signed angle from d0 to d1 about up, the short way round.
    cos_a = float(np.clip(np.dot(d0, d1), -1.0, 1.0))
    sin_a = float(np.dot(up, np.cross(d0, d1)))
    ang = float(np.arctan2(sin_a, cos_a))

    travel = max(2, n - settle)
    w2cs = []
    for i in range(n):
        f = min(1.0, i / (travel - 1))
        th = ang * f
        c, sn = np.cos(th), np.sin(th)
        # Rodrigues about `up`, applied to the start bearing.
        d = d0 * c + np.cross(up, d0) * sn + up * np.dot(up, d0) * (1 - c)
        d = d / np.linalg.norm(d)
        p = target + d * (r0 + (r1 - r0) * f) + up * (h0 + (h1 - h0) * f)
        w2cs.append(look_at(p, target, up))
    # Land exactly on the shot camera so the last frames ARE the shot.
    for i in range(travel, n):
        w2cs[i] = look_at(pos, target, up)
    return np.asarray(w2cs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True, help="scene_floor_plans.id")
    ap.add_argument("--director-plan", required=True, help="director_plans.id")
    ap.add_argument("--frames", type=int, default=NFRAME)
    ap.add_argument("--shot", type=int, default=None,
                    help="one shot only, by position - what the Camera tab's Sharpen button uses")
    ap.add_argument("--dry-run", action="store_true", help="print what would be written, write nothing")
    ap.add_argument("--render", action="store_true",
                    help="after writing, run the pack's own point renderer so each trajectory gets its render.mp4")
    a = ap.parse_args()

    plan = rows("scene_floor_plans", {"select": "*", "id": f"eq.{a.plan}"})[0]
    shots = rows("director_shots", {
        "select": "id,position,shot_type",
        "plan_id": f"eq.{a.director_plan}",
        "scene_number": f"eq.{plan['scene_number']}",
        "order": "position.asc",
    })
    if a.shot:
        shots = [x for x in shots if x["position"] == a.shot]
    if not shots:
        sys.exit("no shots on that plan for this scene")

    ws = workspace_of(plan["ply_path"])
    K, w, h = base_intrinsics(ws)
    render_root = os.path.join(ws, "render_results")
    if not os.path.exists(os.path.join(render_root, "global_pcd.ply")):
        sys.exit(f"{render_root} has no global_pcd.ply - the renderer needs it")
    up = np.asarray(plan["up"], dtype=np.float64)
    print(f"world {plan['world_name']}  frames {a.frames}  intrinsics {w}x{h}")
    split = None
    pano = None
    if not a.dry_run:
        split = pack_imports()
        pano = workspace_panorama(ws)

    written = []
    for shot in shots:
        cams = rows("shot_cameras", {"select": "*", "shot_id": f"eq.{shot['id']}", "is_chosen": "eq.true"})
        if not cams:
            print(f"  #{shot['position']:>2} no chosen camera - skipped")
            continue
        pos, target, fov, _ = resolve(cams[0], plan)
        w2cs = arc(pos, target, up, a.frames, SETTLE)
        name = f"target_shot{shot['position']:02d}"
        traj_dir = os.path.join(render_root, name, "traj0")
        dist = float(np.linalg.norm(np.asarray(pos)))
        print(f"  #{shot['position']:>2} {shot['shot_type']:<12} {dist:5.2f} m out  -> {name}/traj0")
        if a.dry_run:
            continue
        # The anchor-scan writer's own sanity check: proper rotations, and the
        # camera's y axis pointing down in world (OpenCV, Z-up). A camera that
        # fails this would render upside down and poison the memory bank.
        c2ws = np.linalg.inv(w2cs)
        dets = np.linalg.det(w2cs[:, :3, :3])
        up_z = c2ws[:, 2, 1]
        if np.any(dets < 0.9) or np.any(dets > 1.1) or np.any(up_z > -0.5):
            sys.exit(f"shot {shot['position']}: invalid camera orientation (det {dets.min():.3f}..{dets.max():.3f}, y-axis z {up_z.min():.3f}..{up_z.max():.3f})")
        os.makedirs(traj_dir, exist_ok=True)
        from PIL import Image
        Image.fromarray(start_frame(pano, w2cs[0], K, w, h, split)).save(os.path.join(os.path.dirname(traj_dir), "start_frame.png"))
        with open(os.path.join(traj_dir, "camera.json"), "w", encoding="utf-8") as fh:
            json.dump({
                "id": 100 + int(shot["position"]),
                "type": "surround",
                "width": w, "height": h,
                "intrinsic": [K.tolist()] * len(w2cs),
                "extrinsic": [m.tolist() for m in w2cs],
            }, fh, indent=2)
        written.append(traj_dir)

    if a.dry_run:
        print("\ndry run - nothing written")
        return
    print(f"\n{len(written)} trajectories written under {render_root}")

    if a.render:
        # The pack's own renderer, exactly as HYWorld2Trajectories calls it in
        # Stage 4/5. It renders every trajectory folder that has a camera.json
        # from render_results/global_pcd.ply, so the new ones get render.mp4 and
        # render_mask.mp4 in the same form as the planner's.
        from argparse import Namespace
        sys.path.insert(0, r"C:/ComfyUI2/custom_nodes/ComfyUI_HYWorld2")
        sys.path.insert(0, r"C:/ComfyUI2")
        from hyworld2.worldgen import traj_render
        cfg = Namespace(target_path=ws, seed=1, node_rank=0, node_size=1,
                        llm_addr="localhost", llm_port=8000, llm_name="",
                        caption_workers=1, caption_sample_count=4, caption_max_tokens=256,
                        disable_vlm_caption=True)
        traj_render.run_traj_render(cfg, rank=0, world_size=1, local_rank=0)
        missing = [d for d in written if not os.path.exists(os.path.join(d, "render.mp4"))]
        if missing:
            sys.exit(f"{len(missing)} trajectories have no render.mp4 after rendering: {missing[:3]}")
        print(f"render.mp4 present for all {len(written)} shot trajectories")


if __name__ == "__main__":
    main()
