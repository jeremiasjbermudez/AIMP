"""Cameras inside a 3D world: survey a room, place shots in it, render plates.

    survey     sweep a splat, measure its walls, write a floor plan
    landmarks  name what the sweep is looking at (this is a person's job)
    seed       give every shot in a scene a starting camera
    render     resolve the chosen cameras and render their plates

The whole point is that a camera is stored as INTENT - a landmark to look at, a
fraction of the room's radius to stand back, a lens - not as coordinates. Every
reconstruction has its own origin, axes and scale (A1S2's two builds differ by
about 5x), so coordinates die on the first rebuild while intent re-resolves.

Rendering is done here rather than in a ComfyUI graph because the pack's own
VNCCS_PLYSceneRenderer only offers presets that put the camera at the centre of
the room, which cannot express coverage.

    python _splat_camera.py survey    --movie <id> --act 1 --scene 2
    python _splat_camera.py landmarks --plan <id> --set desk=0 --set door=140
    python _splat_camera.py seed      --director-plan <id> --scene 2
    python _splat_camera.py render    --plan <id> [--shot 9]
"""
import argparse
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request

import numpy as np

INSFORGE = "http://localhost:7130"
KEY = "<INSFORGE_API_KEY>"
COMFY_ROOT = "C:/ComfyUI2"

SWEEP_W, SWEEP_H = 672, 384
SWEEP_FOV = 62.0
SWEEP_STEP = 20
PLATE_W, PLATE_H = 1344, 768

# How far out each shot type stands, as a fraction of the room's radius, and on
# what lens. Starting points only - every one is editable per shot afterwards.
SHOT_STYLE = {
    "establishing": (0.75, 62),
    "wide":         (0.62, 55),
    "medium":       (0.38, 45),
    "close":        (0.22, 35),
    "reaction":     (0.24, 35),
    "cutaway":      (0.40, 45),
    "insert":       (0.13, 30),
}
# A person's head sits well above the floor plan's centre, which is a desk
# surface. Aiming at the centre is why every framing test came back looking at a
# globe rather than at anybody.
EYE = 0.09
HEAD = 0.085


# --------------------------------------------------------------------- insforge
def _req(method, path, body=None, params=None):
    url = INSFORGE + path
    if params:
        from urllib.parse import urlencode
        url += "?" + urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Authorization", "Bearer " + KEY)
    if data:
        r.add_header("Content-Type", "application/json")
        r.add_header("Prefer", "return=representation")
    try:
        with urllib.request.urlopen(r, timeout=120) as f:
            raw = f.read().decode()
            return json.loads(raw) if raw.strip() else []
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} failed: {e.code} {e.read().decode()[:400]}")


def rows(table, params):
    return _req("GET", f"/api/database/records/{table}", params=params)


def insert(table, records):
    return _req("POST", f"/api/database/records/{table}", body=records)


def patch(table, params, values):
    return _req("PATCH", f"/api/database/records/{table}", body=values, params=params)


# ------------------------------------------------------------------- geometry
def rotate_about(v, axis, deg):
    a = np.asarray(axis, dtype=np.float64)
    a = a / np.linalg.norm(a)
    t = math.radians(deg)
    return v * math.cos(t) + np.cross(a, v) * math.sin(t) + a * np.dot(a, v) * (1 - math.cos(t))


def look_at(eye, target, up):
    """World-to-camera. OpenCV: +X right, +Y DOWN, +Z forward.

    The negation on `u` is not cosmetic: stacking the up vector renders the room
    upside down, which is the same axis mistake that had the splat viewer
    inverted for weeks.
    """
    eye, target, up = (np.asarray(x, dtype=np.float64) for x in (eye, target, up))
    f = target - eye
    f = f / (np.linalg.norm(f) + 1e-9)
    if abs(float(np.dot(f, up))) > 0.999:
        up = np.array([0.0, 1.0, 0.0]) if abs(up[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    r = np.cross(f, up)
    r = r / (np.linalg.norm(r) + 1e-9)
    u = np.cross(r, f)
    R = np.stack([r, -u, f], axis=0)
    m = np.eye(4)
    m[:3, :3] = R
    m[:3, 3] = -R @ eye
    return m


class Splat:
    """A .ply loaded onto the GPU once, rendered from many cameras."""

    def __init__(self, ply_path):
        import torch
        from plyfile import PlyData

        self.torch = torch
        self.dev = torch.device("cuda")
        ply = PlyData.read(ply_path)
        v = ply["vertex"]
        xyz = np.stack([v["x"], v["y"], v["z"]], axis=1).astype(np.float32)
        op = 1.0 / (1.0 + np.exp(-np.asarray(v["opacity"], dtype=np.float32)))
        sc = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], axis=1).astype(np.float32))
        q = np.stack([v["rot_0"], v["rot_1"], v["rot_2"], v["rot_3"]], axis=1).astype(np.float32)
        q /= np.linalg.norm(q, axis=1, keepdims=True) + 1e-9
        SH0 = 0.28209479177387814
        rgb = np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], axis=1).astype(np.float32) * SH0 + 0.5
        self.xyz_np = xyz
        self.op_np = op
        self.g = (
            torch.from_numpy(xyz).to(self.dev), torch.from_numpy(q).to(self.dev),
            torch.from_numpy(sc).to(self.dev), torch.from_numpy(op).to(self.dev),
            torch.from_numpy(np.clip(rgb, 0, 1)).to(self.dev),
        )
        self.count = len(xyz)

    def render(self, w2c, fov, w, h, out_path):
        from gsplat import rasterization
        torch = self.torch
        xyz, quats, scales, opacity, rgb = self.g
        fx = fy = (w / 2) / math.tan(math.radians(fov) / 2)
        K = torch.tensor([[fx, 0, w / 2], [0, fy, h / 2], [0, 0, 1]], dtype=torch.float32, device=self.dev)
        vm = torch.from_numpy(w2c.astype(np.float32)).to(self.dev)
        out, _, _ = rasterization(means=xyz, quats=quats, scales=scales, opacities=opacity,
                                  colors=rgb, viewmats=vm[None], Ks=K[None], width=w, height=h)
        img = (out[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
        from PIL import Image
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        Image.fromarray(img).save(out_path)
        return out_path

    def wall_distance(self, center, up, direction, cone_deg=7.0, pct=88.0, band=0.6):
        """How far the wall is in one direction.

        Marches out through the solid gaussians inside a narrow cone and takes
        the far edge of the mass. Measured rather than assumed because scale is
        arbitrary per reconstruction - a distance copied from another world
        means nothing.
        """
        rel = self.xyz_np.astype(np.float64) - center
        solid = self.op_np > 0.5
        h = rel @ up
        keep = solid & (np.abs(h) < band)
        flat = rel[keep] - np.outer(h[keep], up)
        d = np.linalg.norm(flat, axis=1)
        ok = d > 1e-6
        unit = flat[ok] / d[ok][:, None]
        inside = (unit @ direction) >= math.cos(math.radians(cone_deg))
        n = int(inside.sum())
        if n < 50:
            return float("nan"), n
        return float(np.percentile(d[ok][inside], pct)), n


def world_frame(ply_path):
    """Centre, up and facing for a splat, from its own meta file."""
    meta_path = os.path.join(os.path.dirname(ply_path), "position_meta_info.json")
    meta = json.load(open(meta_path))
    center = np.asarray(meta["center_point"], dtype=np.float64)
    up = np.asarray(meta["up_direction"], dtype=np.float64)
    up /= np.linalg.norm(up)
    facing = np.asarray(meta["facing_direction"], dtype=np.float64)
    facing -= up * np.dot(up, facing)
    facing /= np.linalg.norm(facing)
    return center, up, facing, meta


# ------------------------------------------------------------------- resolving
def facing_of(frame, up):
    """The room's zero-degree bearing, flattened - its own sense of forward."""
    f = np.asarray(frame["facing"], dtype=np.float64)
    f = f - up * float(np.dot(up, f))
    n = float(np.linalg.norm(f))
    if n < 1e-6:
        axis = np.array([1.0, 0.0, 0.0]) if abs(up[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        f = np.cross(up, axis)
        n = float(np.linalg.norm(f))
    return f / n


def aim_side_direction(marks, look, up, facing):
    """Which way is 'to one side of' a landmark, horizontally.

    Taken from the landmark's own bearing so it means the same thing in any
    build of the room. A landmark marked as the room's CENTRE has no meaningful
    bearing of its own, so the room's facing stands in.
    """
    m = marks.get(look) or {}
    d = None
    if m.get("kind") != "center" and m.get("direction") is not None:
        d = np.asarray(m["direction"], dtype=np.float64)
        d = d - up * float(np.dot(up, d))
        if float(np.linalg.norm(d)) < 1e-6:
            d = None
    if d is None:
        d = facing
    side = np.cross(up, d)
    n = float(np.linalg.norm(side))
    if n < 1e-9:
        return np.zeros(3)
    return side / n


def resolve(camera, plan):
    """Intent + floor plan -> (position, target, fov).

    The one function every mode goes through, so a plate, a preview and a
    WorldStereo trajectory can never disagree about what a camera means.
    """
    frame = plan["frame"] if "frame" in plan else plan
    center = np.asarray(plan["center"], dtype=np.float64)
    up = np.asarray(plan["up"], dtype=np.float64)
    up /= np.linalg.norm(up)
    radius = float(plan["room_radius"])
    marks = plan["landmarks"] or {}

    def direction_of(name):
        m = marks.get(name)
        if not m:
            raise SystemExit(f"floor plan has no landmark called {name!r} - name it first")
        return np.asarray(m["direction"], dtype=np.float64)

    look = camera["look_at_landmark"]
    target_mark = marks.get(look) or {}
    # A 'center' landmark is a position in the room; a 'wall' one is a direction.
    if target_mark.get("kind") == "center":
        base = center.copy()
    else:
        base = center + direction_of(look) * float(target_mark.get("wall_distance", radius))

    # WHERE IT LOOKS. The aim's two axes, beside and above the landmark. Without
    # the sideways one the horizontal bearing of a shot was pinned to whatever
    # direction its landmark sat in, so an angle framed between two named things
    # could not be written down - which is what made taking a flown camera come
    # back about a degree out however many landmarks were named.
    aim_side = aim_side_direction(marks, look, up, facing_of(frame, up))
    target = (base
              + up * (float(camera.get("aim_height_frac", HEAD)) * radius)
              + aim_side * (float(camera.get("aim_side_frac", 0.0)) * radius))

    # Stand back from the target, toward the landmark named in from_landmark, or
    # straight back toward the room's centre when none is given.
    src = camera.get("from_landmark")
    if src and src in marks:
        back = direction_of(src)
    else:
        # From the LANDMARK, never from the aimed point. The sideways aim is a
        # horizontal offset, so measuring the way back from the aimed point
        # would make looking further to one side walk the camera - aiming turns
        # a camera, it does not move it. (The height aim never showed this up
        # because flattening removed it either way.)
        back = center - base
        n = np.linalg.norm(back)
        back = back / n if n > 1e-9 else direction_of(look) * -1.0
    back = back - up * float(np.dot(up, back))
    n = float(np.linalg.norm(back))
    if n < 1e-6:
        # Nothing horizontal left to stand back along. This happens for real:
        # look at a landmark marked as the room's CENTRE with no from_landmark
        # and the stand-back direction is center - target, which is straight
        # down the up axis - so flattening it leaves zero, and dividing by ~zero
        # put the camera on floating-point noise. It still rendered, and it
        # still looked like a camera, which is what made it worth finding.
        #
        # The plan's facing bearing is the room's own zero degrees, so the shot
        # lands somewhere definite and lands there again next time.
        back = np.asarray(frame["facing"], dtype=np.float64)
        back = back - up * float(np.dot(up, back))
        n = float(np.linalg.norm(back))
    if n < 1e-6:
        # Even the facing bearing lies along up, which means a malformed plan.
        # One horizontal direction is as good as another; pick one the same way
        # every time rather than returning a NaN camera.
        axis = np.array([1.0, 0.0, 0.0]) if abs(up[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        back = np.cross(up, axis)
        n = float(np.linalg.norm(back))
    back /= n

    # WHERE IT STANDS. Nothing here reads the aim at all.
    pos = base + back * (float(camera["distance_frac"]) * radius)

    # Lateral offset, pushed toward the side of the line this camera lives on so
    # nobody swaps sides of frame between cuts.
    off = float(camera.get("offset_frac", 0.0))
    if abs(off) > 1e-9:
        side_name = camera.get("line_side_landmark")
        side = None
        if side_name and side_name in marks:
            side = direction_of(side_name)
            side = side - back * float(np.dot(side, back))
            if float(np.linalg.norm(side)) < 1e-6:
                # The named side lies along the direction the camera stands back
                # in - naming the same landmark for both, which is easy to do -
                # so it cannot say which way sideways is. Dropping the offset
                # would shift the camera to somewhere the shot never asked for,
                # so the room's own perpendicular stands in: deterministic, and
                # recoverable when a flown angle is read back in.
                side = None
        if side is None:
            side = np.cross(up, back)
        n = float(np.linalg.norm(side))
        if n > 1e-9:
            pos = pos + (side / n) * (off * radius)

    pos = pos + up * (float(camera.get("eye_height_frac", EYE)) * radius)
    return pos, target, float(camera.get("fov_deg", 45)), up


# ----------------------------------------------------------------------- modes
def mode_survey(a):
    movie = rows("movies", {"select": "id,slug,title", "id": f"eq.{a.movie}"})[0]
    splats = rows("scene_splats", {
        "select": "ply_path,workspace_name",
        "movie_id": f"eq.{a.movie}",
        "act_number": f"eq.{a.act}",
        "scene_number": f"eq.{a.scene}",
    })
    ply = a.ply or (splats[0]["ply_path"] if splats else None)
    if not ply:
        sys.exit(f"A{a.act}S{a.scene} has no splat, and no --ply was given")
    world = a.world or (splats[0].get("workspace_name") if splats else os.path.basename(os.path.dirname(ply)))
    if not os.path.exists(ply):
        sys.exit(f"splat not on disk: {ply}")

    center, up, facing, _ = world_frame(ply)
    s = Splat(ply)
    print(f"{s.count} gaussians in {world}")

    scope = f"A{a.act}S{a.scene}"
    out_rel = f"input/{movie['slug']}/_CameraSurvey/{scope}"
    out_dir = os.path.join(COMFY_ROOT, out_rel)
    bearings = []
    for deg in range(0, 360, SWEEP_STEP):
        d = rotate_about(facing, up, deg)
        d -= up * np.dot(up, d)
        d /= np.linalg.norm(d)
        name = f"b{deg:03d}.png"
        s.render(look_at(center + up * (EYE * 1.0), center + up * (EYE * 1.0) + d, up),
                 SWEEP_FOV, SWEEP_W, SWEEP_H, os.path.join(out_dir, name))
        wall, n = s.wall_distance(center, up, d)
        bearings.append({
            "bearing_deg": deg,
            "image": f"{out_rel}/{name}",
            "direction": [round(float(x), 5) for x in d],
            "wall_distance": None if math.isnan(wall) else round(wall, 4),
            "points": n,
        })
        print(f"  {deg:>3}\u00b0  wall {wall:7.3f}  {n:>6} pts  {name}")

    solid = [b["wall_distance"] for b in bearings if b["wall_distance"]]
    radius = round(float(np.median(solid)), 4) if solid else 1.0

    plan = insert("scene_floor_plans", [{
        "movie_id": a.movie, "act_number": a.act, "scene_number": a.scene,
        "world_name": world, "ply_path": ply,
        "center": [round(float(x), 6) for x in center],
        "up": [round(float(x), 6) for x in up],
        "facing": [round(float(x), 6) for x in facing],
        "room_radius": radius,
        "landmarks": {},
        "survey": {"bearings": bearings, "fov_deg": SWEEP_FOV, "step_deg": SWEEP_STEP,
                   "sweep_dir": out_rel, "gaussians": s.count},
    }])[0]
    print(f"\nroom radius (median wall) {radius}")
    print(f"floor plan {plan['id']} - landmarks are empty; name them next")


def mode_landmarks(a):
    plan = rows("scene_floor_plans", {"select": "*", "id": f"eq.{a.plan}"})[0]
    by_deg = {b["bearing_deg"]: b for b in plan["survey"]["bearings"]}
    marks = dict(plan["landmarks"] or {})
    for pair in a.set:
        name, _, deg_s = pair.partition("=")
        deg = int(round(float(deg_s)))
        # Snap to the nearest surveyed bearing so the direction and the wall
        # distance come from something that was actually measured.
        nearest = min(by_deg, key=lambda d: min(abs(d - deg), 360 - abs(d - deg)))
        b = by_deg[nearest]
        marks[name.strip()] = {
            "kind": "center" if name.strip() in a.center else "wall",
            "bearing_deg": nearest,
            "direction": b["direction"],
            "wall_distance": b["wall_distance"] or plan["room_radius"],
            "image": b["image"],
            "named_by": "operator",
        }
        print(f"  {name.strip():10} -> {nearest}\u00b0  wall {b['wall_distance']}")
    patch("scene_floor_plans", {"id": f"eq.{a.plan}"}, {"landmarks": marks})
    print(f"{len(marks)} landmarks on plan {a.plan}")


def mode_seed(a):
    shots = rows("director_shots", {
        "select": "id,position,shot_type,characters,scene_number",
        "plan_id": f"eq.{a.director_plan}",
        "scene_number": f"eq.{a.scene}",
        "order": "position.asc",
    })
    if not shots:
        sys.exit("no shots in that director plan for that scene")
    made = 0
    for s in shots:
        existing = rows("shot_cameras", {"select": "id", "shot_id": f"eq.{s['id']}"})
        if existing:
            continue
        frac, fov = SHOT_STYLE.get(s["shot_type"], (0.38, 45))
        insert("shot_cameras", [{
            "shot_id": s["id"],
            "label": f"{s['shot_type']} (seeded)",
            "is_chosen": True,
            "from_landmark": a.from_landmark,
            "look_at_landmark": a.look_at,
            "distance_frac": frac,
            "offset_frac": 0.0,
            "eye_height_frac": EYE,
            "aim_height_frac": HEAD,
            "fov_deg": fov,
            "line_side_landmark": a.line_side,
        }])
        made += 1
        print(f"  #{s['position']:>2} {s['shot_type']:<12} {frac:.2f} x radius, {fov}\u00b0")
    print(f"{made} cameras seeded ({len(shots) - made} already had one)")


def mode_plys(a):
    """Every splat on disk for a movie, newest first.

    A world keeps its training history: point_cloud_<step>.ply for each step it
    saved, _backup_<ms>.ply from forced rebuilds, and the renamed final one the
    builder records. Nothing in the browser can see them - ComfyUI's file route
    does not recurse this deep - so the list is built here and returned as JSON
    for a picker to show.
    """
    movie = rows("movies", {"select": "slug", "id": f"eq.{a.movie}"})[0]
    root = os.path.join(COMFY_ROOT, "output", movie["slug"], "hyworld2_worldgen")
    recorded = {}
    for r in rows("scene_splats", {"select": "ply_path,act_number,scene_number", "movie_id": f"eq.{a.movie}"}):
        if r.get("ply_path"):
            recorded[os.path.normcase(os.path.normpath(r["ply_path"]))] = f"A{r['act_number']}S{r['scene_number']}"
    found = []
    if os.path.isdir(root):
        for workspace in sorted(os.listdir(root)):
            ply_dir = os.path.join(root, workspace, "gs_results", "ply")
            if not os.path.isdir(ply_dir):
                continue
            for name in sorted(os.listdir(ply_dir)):
                if not name.lower().endswith(".ply"):
                    continue
                # The viewer's own upright copies and the fused meshes are not
                # splats to choose between; they are derivatives of one.
                if name.lower().endswith("_yup.ply") or name.lower().endswith("_yup_yup.ply"):
                    continue
                if name.startswith("fuse_"):
                    continue
                full = os.path.join(ply_dir, name).replace("\\", "/")
                st = os.stat(full)
                step = None
                m = re.search(r"point_cloud_(\d+)\.ply$", name)
                if m:
                    step = int(m.group(1))
                found.append({
                    "path": full,
                    "workspace": workspace,
                    "name": name,
                    "step": step,
                    "is_backup": "_backup_" in name,
                    "size_mb": round(st.st_size / 1e6, 1),
                    "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime)),
                    "modified_epoch": int(st.st_mtime),
                    "in_use_for": recorded.get(os.path.normcase(os.path.normpath(full))),
                })
    found.sort(key=lambda f: f["modified_epoch"], reverse=True)
    print(json.dumps({"splats": found}))


def mode_render(a):
    plan = rows("scene_floor_plans", {"select": "*", "id": f"eq.{a.plan}"})[0]
    if not plan["landmarks"]:
        sys.exit("that floor plan has no landmarks yet - run `landmarks` first")
    movie = rows("movies", {"select": "slug", "id": f"eq.{plan['movie_id']}"})[0]

    shots = rows("director_shots", {
        "select": "id,position,shot_type",
        "movie_id": f"eq.{plan['movie_id']}",
        "scene_number": f"eq.{plan['scene_number']}",
        "order": "position.asc",
    })
    if a.shot:
        shots = [s for s in shots if s["position"] == a.shot]
    if not shots:
        sys.exit("no shots to render")

    s = Splat(plan["ply_path"])
    scope = f"A{plan['act_number']}S{plan['scene_number']}"
    out_rel = f"input/{movie['slug']}/_SplatPlates/{scope}"
    done = 0
    for shot in shots:
        cams = rows("shot_cameras", {"select": "*", "shot_id": f"eq.{shot['id']}", "is_chosen": "eq.true"})
        if not cams:
            print(f"  #{shot['position']:>2} no chosen camera - skipped")
            continue
        cam = cams[0]
        if cam.get("explicit_pose") and cam.get("explicit_world") and cam["explicit_world"] != plan["world_name"]:
            # A hand-flown angle cannot be re-derived, so it is reported rather
            # than silently reinterpreted in a world it was not taken in.
            print(f"  #{shot['position']:>2} STRANDED: pinned to world {cam['explicit_world']!r}, plan is {plan['world_name']!r}")
            continue
        pos, target, fov, up = resolve(cam, plan)
        w2c = look_at(pos, target, up)
        name = f"shot{shot['position']:02d}.png"
        t0 = time.time()
        s.render(w2c, fov, PLATE_W, PLATE_H, os.path.join(COMFY_ROOT, out_rel, name))
        took = time.time() - t0
        insert("camera_plates", [{
            "shot_camera_id": cam["id"],
            "floor_plan_id": plan["id"],
            "resolved_position": [round(float(x), 5) for x in pos],
            "resolved_target": [round(float(x), 5) for x in target],
            "resolved_fov": fov,
            "resolved_matrix": [[round(float(x), 6) for x in row] for row in w2c],
            "image_path": f"{out_rel}/{name}",
            "width": PLATE_W, "height": PLATE_H,
            "render_seconds": round(took, 3),
        }])
        # Point the shot at its own plate. The plate IS this shot's background,
        # so a render that does not link it leaves the shot composited onto
        # whatever it had before - which for a whole scene meant fifteen shots
        # sharing one panorama and the camera work counting for nothing.
        patch("director_shots", {"id": f"eq.{shot['id']}"},
              {"plate_path": f"{out_rel}/{name}"})
        done += 1
        print(f"  #{shot['position']:>2} {shot['shot_type']:<12} {fov:>4.0f}\u00b0  {took:5.2f}s  {name}")
    print(f"{done} plates rendered into {out_rel}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="mode", required=True)

    s = sub.add_parser("survey", help="sweep a splat, measure its walls, write a floor plan")
    s.add_argument("--movie", required=True)
    s.add_argument("--act", type=int, required=True)
    s.add_argument("--scene", type=int, required=True)
    s.add_argument("--ply", help="override the splat path")
    s.add_argument("--world", help="override the world name")
    s.set_defaults(fn=mode_survey)

    s = sub.add_parser("landmarks", help="name what the sweep is looking at")
    s.add_argument("--plan", required=True)
    s.add_argument("--set", action="append", default=[], metavar="NAME=DEG")
    s.add_argument("--center", action="append", default=[], metavar="NAME",
                   help="this landmark is a position in the room, not a direction")
    s.set_defaults(fn=mode_landmarks)

    s = sub.add_parser("seed", help="give every shot in a scene a starting camera")
    s.add_argument("--director-plan", required=True)
    s.add_argument("--scene", type=int, required=True)
    s.add_argument("--look-at", default="desk")
    s.add_argument("--from-landmark", default=None)
    s.add_argument("--line-side", default=None)
    s.set_defaults(fn=mode_seed)

    s = sub.add_parser("render", help="resolve the chosen cameras and render their plates")
    s.add_argument("--plan", required=True)
    s.add_argument("--shot", type=int, help="one shot only, by position")
    s.set_defaults(fn=mode_render)

    s = sub.add_parser("plys", help="list every splat file on disk for a movie")
    s.add_argument("--movie", required=True)
    s.set_defaults(fn=mode_plys)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
