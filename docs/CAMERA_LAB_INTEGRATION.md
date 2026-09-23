# Integrating camera_lab: Blender sets and multi-angle coverage

`movie-mvp/camera_lab` proved a way to shoot one location from several cameras and
keep it the same room in every shot. This is how it came into AIMP, and what is
left. Most of it is built; see [Pieces, in order](#pieces-in-order).

## What it adds

AIMP places cameras by intent ("wide from the doorway") inside a 360 panorama or a
Gaussian-splat world, and renders a plate per shot. camera_lab adds:

- **A metric, editable set.** A versioned Blender block-out of the location
  (`locations/<id>/<rev>/location.blend` plus `location.json`: dimensions, named
  anchors, set pieces, room prompt). It gives real occlusion and repeatable geometry.
- **Per-camera control passes** from Blender: 16-bit metric depth, actor masks,
  edges, and coverage plates. These drive MiniMax H3 through the same Fun ControlNet
  route AIMP's 46-MiniMax-Control-To-Video already uses.
- **Visibility facts.** An object-index pass records which set pieces each camera
  sees always, sometimes or never. That becomes prompt sentences and negatives.
- **Tech scout.** A contact sheet of what every camera sees, before anything renders.
- **Camera moves.** Start and end positions with easing, tracked aim, lens shift and
  f-stop. Browser and Blender cameras agree to within 5e-7 over 1,106 frames.
- **Recorded H3 recipes.** Guided at cfg 4 for static cameras, turbo for moving ones,
  depth released at 50–80% of steps.

It does not replace the splat and panorama worlds. It is a second kind of set for
locations that recur and need exact continuity.

## Where it runs

Everything runs on the render host, beside ComfyUI:

- **Blender 4.5.9, portable.** Unzipped into `C:\ComfyUI-server\blender-4.5.9`; no
  installer. camera_lab forced Metal; `blender/_sets.py` picks OptiX, then CUDA,
  then whatever else there is.
- **GPU sharing.** A Blender render asks the main ComfyUI to unload its models first,
  the same way the world ComfyUI does.
- **Replacing the macOS-only tools.** `measure_faces.swift` and `person_matte.swift`
  use Apple Vision. Their replacements are InsightFace, which faceqa already uses, and
  RMBG or SAM in ComfyUI.
- **Reproducibility.** camera_lab's own notes say output differs across GPU and
  Blender version, so its frozen reference renders are re-baselined once on the new
  GPU and Blender version.

## Data model

| camera_lab | AIMP |
|---|---|
| `location.json` + `.blend`, per revision | a new `locations` table: id, revision, blend path, sha, `set_pieces`, `anchors`, `room_prompt`, lighting states. `scenes` get an optional `location_id` / `location_rev`. |
| Stage camera: explicit start/end pose, lens, aim, shift, f-stop, move frames | `shot_cameras.stage_camera jsonb`, beside the existing intent-based placement |
| per-camera depth / mask / edge / plates, `camera_manifest.json` | `camera_plates`: add `mask_path`, `edge_path`, `visibility jsonb`, `manifest jsonb` |
| take `record.json` | the clip row, with `control_video_path` and the recipe used |

Revisions stay immutable and hash-pinned, as in camera_lab. A shot records the exact
location revision it was shot against.

## Pieces, in order

A Blender set is the world module's third kind of set, beside the panorama and the
splat world: the same step (Sets), with exact geometry instead of a generated
picture. Cameras, control passes and visibility then belong to the camera module.

1. **Tables. Done.** `set_locations` (a project's copy of one location revision,
   with its `location.json` as `facts`) and `set_shots` (a shot/v0, its status, the
   stage and visibility results, the scout sheet), in `install/modules/world/schema.sql`.
2. **Worker. Done.** `pc-worker/aimp_worker.py` runs Blender jobs one at a time,
   after freeing ComfyUI's models: `POST /blender/jobs` with kind `stage`,
   `visibility`, `scout` or `assets`, polled at `GET /blender/jobs/<id>`, and
   `GET /blender/locations`. The scripts are in `blender/`, with camera_lab's
   folders and Metal-only GPU choice replaced by `blender/_sets.py`. Everything is
   under the sets root, `<ComfyUI>/input/sets`, so ComfyUI's `/view` serves it.
3. **Flow. Done.** `48-Blender-Sets`: `locations`, `add_location`, `stage` (stage, then
   visibility) and `scout`.
4. **Admin. Done, first version.** The Blender Sets tab: add a set, a plan of the room
   with its marks and every staged camera, a shot form with a live preview, shot cards
   with the first frame, visibility and plates, and the tech-scout sheet.
5. **Block-outs written by a model. Done.** See [How a set is made](#how-a-set-is-made).
6. **Next.** Bring Director's Stage (`director_web`) into the Camera tab, writing
   `stageCamera` into the same `stage` action. Port `compile_shot.py` and
   `prepare_take.py`'s depth and Canny binding into `flowise/lib`, and feed a staged
   shot's depth into 46-MiniMax-Control-To-Video.
7. **Next.** Proposed coverage: from a scene's shot list (the Director tab), place
   cameras on the set's marks (wide, singles, overs), reject angles the visibility
   pass says see only bare wall, and lay them out on a scout sheet for approval.
8. **Later.** Align the splat world to the block-out (floor, scale, heading), so a
   staged camera can also render a photographic plate from the splat.

## How a set is made

camera_lab's locations were never built by hand. A model wrote a Python script per
location from three reference pictures, and revised it when the tech scout found a
bare wall behind a camera (v007's own comments say so). AIMP keeps that process and
makes it repeatable, with one change: **the model writes data, not code.** One
builder, `blender/build_blockout.py`, turns that data into the `.blend`, so nothing
a model writes is executed on the render host, and a revision is a readable diff.

In the app it is one step of four per scene, shown on each scene in
Panoramas & Worlds: **panorama → splat world → block-out → cameras.** Each can be
skipped; a block-out needs only the panorama.

```
panorama ──pano_views──▶ four views N E S W (90°, level, from the panorama's camera)
                               │
                  model writes the location (JSON)          ◀─┐
                               │ checked: objects, marks,     │
                               │ marks inside the walls       │
                  build_blockout ──▶ location.blend           │ revise: the model sees
                               │     previews N E S W + plan  │ the panorama views, the
                               │     build_report             │ block-out's views from the
                               └──────────────────────────────┘ same spot, the build's
                                                                warnings, the staged shots'
                                                                visibility faults, and notes
```

Each pass is a new revision (`v001`, `v002`...), kept, never rebuilt in place, and
recorded in `set_locations` with the model that wrote it, what it changed, its
previews and its build report. Staging and the tech scout work on a generated set
exactly as on a hand-made one.

**Where it runs.** `48-Blender-Sets` actions `generate_location` (from a scene's
panorama, with 0-3 checking passes) and `revise_location` (any set, with notes).
A set built by a script before this, like warming_hut v007, is first described as
data by `blender/export_blockout.py`, then revised the same way. Rebuilding v007
from its export matches the original: all 153 meshes, bounds and vertex counts.

**The format** is documented at the top of `blender/build_blockout.py`, and the
model's instructions are in `flowise/lib/blockout_ai.js`: rect or round rooms,
openings (windows, doors) cut into the walls, boxes, cylinders, cones, tori, spheres
and polygons, `repeat` for rows, lights, marks (`ANCHOR_stand_*`, `ANCHOR_sit_*`,
one per thing to face) and `set_pieces`, which name the object prefixes the
visibility pass reports on. `view_from` records where the panorama was taken, so the
block-out is rendered from the same spot when it is compared.

**Which model.** The one chosen in the app. It has to read four pictures and write
a long, exact JSON answer, which a small model cannot do:

| Model | Testies A1S1, the lighthouse kitchen |
|---|---|
| Claude (Opus, through the Claude bridge) | Round room, 3.6 m, with the window, stove and flue, table, radio, soldering irons, calendar and stair arch; 85-92 objects, no build errors. Its checking passes found that the panorama was not taken from the middle of the room, and made the stove, window and calendar the right size. |
| gemma4:e4b (Ollama on the PC) | A rectangular "modern kitchen" with an empty block-out, twice. The flow now refuses it in about 30 seconds and says why. |

So set the app's model to Claude for this step (log Claude in on the render host).

## Tested end to end

Testies, scene A1S1, through the app's own flow on the render host (23 September):

1. **Block-out.** `generate_location` from the scene's panorama with two checking
   passes: v001, v002, v003 in 2½ minutes, Blender builds included.
2. **Cameras.** Three shots staged on the set's marks ("the keeper by the stove"): a
   24 mm wide, a 50 mm single and a 35 mm three-quarter, about two minutes each
   (124 frames of depth and mask, eight plates, visibility). Tech scout in 49 s.
3. **The loop closes.** The visibility check flagged the two singles: "PLAIN
   BACKGROUND … dress the wall behind the actor". `revise_location` passed that to the
   model, which added stone courses round the wall (v004, 62 s). The same two shots
   re-staged on v004 came back clean, with the stone walls in frame.

What this does not do yet: propose the cameras itself (step 7 above), or check the
block-out against the splat world rather than the panorama alone.

## Not coming across

- **Experiment files.** The 33 GB of renders and shots. Only the code,
  `locations/*/location.json` and the `.blend` files (about 1 GB) move.
- **The web app's hosting.** `@openai/sites-vite-plugin` and the Wrangler deploy.
  Director's Stage becomes part of the admin app instead.
- **The per-experiment submission budget.**
- **Local configuration.** `experiment/config.local.json`, which holds hosts, and
  the `.openai/` project IDs.
