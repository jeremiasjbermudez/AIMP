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
6. **From a staged shot to a clip. Done.** See [From the set to a clip](#from-the-set-to-a-clip).
   Still to port: Director's Stage (`director_web`) into the Camera tab, writing
   `stageCamera` into the same `stage` action.
7. **Takes: the performance. Done: takes, and drafting them with the model.** See
   [Takes](#takes). **Operated camera passes with VirtuCamera: working, by script.**
   See [Operating a camera](#operating-a-camera). Next: a "Send pass to AIMP" button
   in Blender; a rigged mannequin with walk and turn clips; captured motion.
8. **Next.** Proposed coverage: from a scene's shot list (the Director tab), place
   cameras on the set's marks (wide, singles, overs), reject angles the visibility
   pass says see only bare wall, and lay them out on a scout sheet for approval.
9. **Later.** Align the splat world to the block-out (floor, scale, heading), so a
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

## From the set to a clip

`48-Blender-Sets` action `make_clip` (the **Make clip** button on a staged shot, with a
**For shot** picker of the Director's shots) joins a staged shot to the story and the
video route:

```
beat ─▶ Director shot ─▶ staged Blender shot ─▶ make_clip ─▶ minimax_clips row ─▶ 46-MiniMax-Control-To-Video
                                                  │
     control video  ◀── depth pass (worker job `control`, blender/control_depth.py)
     Picture 1      ◀── the character's reference (Characters tab)
     Pictures 2-3   ◀── look plates: Z-Image over the coverage plates this camera faces,
                        made once per set revision (set_locations.look)
     prompt         ◀── flowise/lib/set_clip.js: camera position relative to the actor,
                        the move, the visibility pass, the Director shot's motion prompt
```

- **The control video** is camera_lab's: inverse depth, one range for the whole clip
  (0.5-99.5 percentile of every frame), near white, lossless, exactly the staged
  frame count. A camera within 0.35 m of the set on more than 2% of a frame is
  refused.
- **The link.** The clip carries the beat (`minimax_clips.beat_id`). The Director shot
  finds its clip through `director_shots.clip_id`, and the staged shot records the
  Director shot, the beat, the control facts and the clip (`set_shots`).
  `minimax_clips.source_shot_id` is not used: it points at the screenplay breakdown's
  `shots` table.
- **The settings, measured.** On Testies (beat A1S1B1, Director shot 2, "TOMAS
  frowns. He looks at the wall calendar", a 50 mm medium close-up), three renders of
  about 4 minutes each:

  | Setting | Result |
  |---|---|
  | camera_lab's strength 0.7, depth released at 0.5 | H3 ignored the depth and framed its own wide shot |
  | strength 1.0 for the whole render | framing followed the depth; the room description in the prompt brought in the window and radio, which this camera cannot see |
  | 1.0 / 1.0, room description left to the look plates | followed the depth and the set: the bare stone wall this camera faces |

  So `make_clip` defaults to strength 1.0 for the whole render (`control_end`, a new
  column that 46-MiniMax-Control-To-Video now honours). camera_lab's 0.7 / 0.5 was for
  a different control node, with frame anchors.
- **Still open.** The character renders a little smaller than the proxy, and copies
  the pose of the reference portrait. A prop named in the action ("he looks at the
  calendar") can appear although it is behind the camera. camera_lab's end-frame
  anchor (the actor inserted into the Blender end frame and used as a guide) is the
  next thing to port for both.

## Takes

A staged shot used to place a proxy standing still on a mark. A camera operator needs
the action to play: follow the actor across the room, find the angle as he turns. So
a set gets **takes**: the scene's performance, as data.

```
take.json (take/v0)                      build_take.py            take.blend
  performers: moves on marks, by time  ───────────────────────▶  the set, performers walking
  cues: what happens when                                         (legs and arms swing, turn on
  length: an H3 length                                            arrival, stand or sit), cues as
                                                                  timeline markers, TAKE_CAM
```

- **One performance, many cameras.** Every shot staged on a take (`stage` with
  `takeId`) films the same action, so a scene's angles cut together, as coverage does
  on a real shoot. The camera from the shot form stays where it is and pans to follow;
  a recorded camera (`shot.cameraPath`, one matrix per frame) is replayed exactly.
- **Operate it.** Blender Sets offers the take's `.blend` to download. Open it, press
  play, and operate against the action (the first use for VirtuCamera). It is plain
  Blender 4.5: checked on the Mac, the performer walks between frames 29 and 82 and the
  cue marker sits at frame 97.
- **The clip.** `make_clip` turns the take into timed sentences ("From 1.2s to 3.4s
  TOMAS walks from the stove to the middle of the room, and turns to face the
  calendar") and describes a following camera as a pan, measured from the camera's
  own frames, not as the locked-off shot the stage would call it.
- **The figure** is the stage's proxy, moved to `blender/_proxy.py` unchanged:
  re-staging a shot after the move gives pixel-identical depth and masks.

Tested on Testies (take TK_A1S1_01, shot LK_TK01_FOLLOW, Director shot 2): Tomas at
the stove with his back to a 28 mm camera, walking toward it and turning to the
calendar. H3 followed the performance: the back of his head, the turn, the approach,
and the profile at the end, frame for frame with the depth. The block-out's window
(a glowing panel) came back looking like a doorway into another room.

### Drafting a take

`draft_take` (the **Draft from shots** box in the take editor) has the language model
block the performance for consecutive Director shots, up to one clip long:

- **It reads** the set's marks with their coordinates and what each is near (walls
  left out: they are near everything), the room's shape, who is in the shots, and each
  shot's action with its start time in the take.
- **The code places the lines.** "At 00:00.800, TOMAS says: You're early." in a shot
  that starts 5.2 s into the take is a cue at 6.0 s. A line's time is a fact of the
  script, as the Director flow already treats it; the model only blocks moves and
  action cues around the lines.
- **The flow checks** that every move is on a standing or sitting mark, that facings
  are marks, that times fit, that nobody walks faster than 1.5 m/s, and that no move
  repeats; a failing draft goes back once with the problems named, then is refused
  with them.
- **The draft fills the editor**, with the model's reading of the scene, to adjust and
  build.

On Testies, Director shots 2 and 3 ("TOMAS frowns. He looks at the wall calendar";
"checks his wristwatch … says: You're early."), 10.8 s:

| Model | Draft |
|---|---|
| gemma4:e4b | first a take whose reading and moves disagreed and whose line was at the wrong time; with the lines placed by code, twice a take standing him on the calendar: refused |
| Claude | he studies the calendar, checks his watch at 5.3 s, turns toward the stairwell at 5.8 s and says the line at 6.0 s: "You're early" is said to someone heard but not seen, "the most plausible arrival point is the stairwell". The same blocking on a second draft |

**Rendering a drafted take.** Claude's take, filmed by a 50 mm camera off Tomas's right
(LK_S1_0203_MED, 260 frames, about 10 minutes to render), took three renders:

1. **Two Tomases**: one where the depth put him, and a second at the window acting out
   the timeline. The line also had two times: the take's 6.0 s and the Director
   shot's own "At 00:00.800".
2. With the Director text dropped on takes (the timeline carries the action and the
   lines) and "no second figure" in the prompt: **still two**. The second now pointed
   at the calendar.
3. The cause was a contradiction: "not in this shot: the calendar" beside "he looks
   at the wall calendar". Timeline sentences naming something the camera never sees
   are now marked "out of frame in this shot: he looks off frame toward it; do not
   draw it". **One Tomas**, holding the staged framing throughout. The calendar is
   still drawn on the wall, but nobody acts it out.

## Operating a camera

A take's `.blend` is operated with [VirtuCamera](https://virtucamera.com): an iPhone or
iPad (ARKit, iOS 16+, the paid app) drives a Blender camera live and records it.
Checked in its plugin code: recording plays Blender's timeline (`animation_play`,
synced), so the take's performer walks on the phone's screen while you operate, and the
camera is keyframed (position, rotation, focal length).

Set up on the Mac (23 September):
- Blender 4.5.9 at `movie-mvp/experiment/.tools/Blender.app`, with the VirtuCamera
  add-on p2.0 (`VirtuCameraBlender_4.5-5.0_py311_mac_v3.5.0_p2.0.zip` from
  [the add-on's releases](https://github.com/theweirdbyte/VirtuCamera-Blender/releases/))
  installed and enabled.
- The take from Blender Sets' **Blender file** button, saved as
  `~/Documents/AIMP Takes/<take>.blend`.

To record: in Blender, **N** > VirtuCamera > **Start Serving**, scan the QR code with
the app, pick **TAKE_CAM**, tap **link** (the camera follows the phone; **unlink** to
reposition), frame 1, **record** (it runs to the take's last frame; tap again to stop
early). Save (**Cmd+S**). Movement is 1:1 in metres: the set is the size of a room.

To stage it (for now, by script; a button in Blender is next):
```
blender -b "<take>.blend" --python blender/export_camera_pass.py -- pass.json
AIMP_URL=http://<render host>:5185 AIMP_FLOW_KEY=... AIMP_SETS_FLOW=<48-Blender-Sets id> \
  python3 blender/send_camera_pass.py pass.json <SHOT_KEY> --take <take id> \
  --set <set location id> --movie <project id> --director-shot <id> --clip
```

**The first operated pass** (take TK_A1S1_01, shot LK_TK01_OPERATED_01): 0.59 m of
handheld travel, from over Tomas's shoulder at the stove to a close-up 0.64 m from his
eyes as he walks up. Staging followed it frame for frame.

The clip's first render held the move for half its length, then pulled back to a wide
shot of a bare, daylit room with a window the camera cannot see. The inputs were at
fault, not the control strength:
- the **look plates** (Z-Image over the Blender coverage plates) carry the block-out's
  bright lighting, so they told H3 "a bare white room by day";
- the prompt no longer said **it is night** (it went with the room description);
- it told an operated camera "no handheld sway".

So a set made from a panorama now gives its clips the **panorama's own views** facing
the camera's way (the scene's real look: night, the stove alight, the dark window) in
place of the look plates, and the prompt states the time of day and the room's lights.
The re-render is night in the panorama's room, Tomas as his reference, and **holds the
move to the final close-up**. Still open: the window and the table appear although
this camera faces away from them; the panorama views bring the room's features in too
readily.
