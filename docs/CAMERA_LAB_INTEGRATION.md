# Integrating camera_lab: Blender sets and multi-angle coverage

`movie-mvp/camera_lab` proved a way to shoot one location from several cameras and
keep it the same room in every shot. This is the plan for bringing it into AIMP. It
is a plan, not yet code.

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
  installer. `pipeline/blender_stage.py` forces Metal and needs changing to
  CUDA/OptiX.
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

1. **Tables.** Add `locations` and the new columns above, in a new `sets` module
   (`install/modules/sets/`), guarded like every other schema.
2. **Worker endpoints.** On `pc-worker/aimp_worker.py`:
   - `/blender/stage`: depth, masks, edges, plates for one shot;
   - `/blender/visibility`: the object-index pass;
   - `/blender/scout`: the tech-scout sheet.
   Each takes a shot built from database rows. They wrap `blender_stage.py`,
   `visibility.py`, `tech_scout.py` and `stage_assets.py`, with camera_lab's hardcoded
   folders replaced by arguments. Outputs go under ComfyUI's `input/<project>/sets/`,
   where the control-to-video graph reads them.
3. **Flows.** A "Blender Stage" flow calls the worker and writes `camera_plates`.
   Port `compile_shot.py` (look plates and prompt facts) and `prepare_take.py`'s depth
   plus Canny binding into `flowise/lib` as JS graph builders. Merge the recipe
   settings into 46-MiniMax-Control-To-Video instead of reusing the patched `C_T02`
   base graph.
4. **Admin.** Bring Director's Stage (`director_web/app/page.tsx`, `viewfinder.tsx`,
   `lib/scene.ts`) into the Camera tab as a "Blender set" mode, driven by the
   location's GLB and floor plan. `validateScene`'s single-location lock goes; a
   location comes from the `locations` row. Add a tech-scout sheet and visibility
   badges on each shot row.
5. **Later.** Build a Blender block-out from AIMP's panorama or splat. Neither project
   does this yet; ai-filmmaker's pano-depth-mesh approach is the nearest start.

## Not coming across

- **Experiment files.** The 33 GB of renders and shots. Only the code,
  `locations/*/location.json` and the `.blend` files (about 1 GB) move.
- **The web app's hosting.** `@openai/sites-vite-plugin` and the Wrangler deploy.
  Director's Stage becomes part of the admin app instead.
- **The per-experiment submission budget.**
- **Local configuration.** `experiment/config.local.json`, which holds hosts, and
  the `.openai/` project IDs.
