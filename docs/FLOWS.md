# Flowise Flows

Every step of this pipeline that touches the database, ComfyUI or a language model is a
Flowise flow, and almost every one of them has the same shape: a **Start** node wired to a
single **Custom Function** node. The JavaScript body of that Custom Function *is* the flow.
The handful of exceptions are noted per flow (a couple use two Custom Functions in series, one
uses an LLM node between two of them, and one uses Iteration + ExecuteFlow to fan out to other
flows).

A flow is invoked by POSTing to Flowise's prediction endpoint:

```
POST <flowise>/api/v1/prediction/<chatflow-id>
{ "question": "<the input>" }
```

Whatever is sent as `question` arrives inside the node as `$flow.input`. Most flows
`JSON.parse` it; a few take a plain flag string (an act/scene scope plus `--flags`). A flow
that is handed a file — only `4-Panoramic-Generator` does this — reads it from `$flow.uploads`.

Four input variables are configured on the Start node of essentially every flow, and are set
per install:

| Variable | What it is |
| --- | --- |
| `$insforgeUrl` | Base URL of the InsForge instance (database + object storage) |
| `$insforgeApiKey` | Bearer token for InsForge |
| `$comfyUrl` | Base URL of the ComfyUI server |
| `$comfyRoot` | Filesystem path to the ComfyUI installation, for flows that read/write files directly |

Some flows carry two or three more: `$ollamaUrl` and `$ollamaModel` (the local language/vision
model host) for anything that reasons about text or looks at a picture, `$systemPrompt` for the
three conversational flows, and `$kind` for the pair of flows built from one shared node body.

Database access is PostgREST-style throughout: `GET/POST/PATCH/DELETE
{insforgeUrl}/api/database/records/<table>` with `eq.`/`in.` filters. Storage is
`{insforgeUrl}/api/storage/buckets/<bucket>/objects/<key>`, one bucket per movie.

Flows that render submit a graph to `{comfyUrl}/prompt` and then poll
`{comfyUrl}/history/<prompt_id>` until the job appears; staging an input image means uploading
it to ComfyUI's `input/` folder first.

Nearly every flow returns a plain object. A failure is either `{ error: "..." }` (bad input,
nothing was attempted) or `{ action: "error", reason: "..." }` (the work started and failed).
Success is usually `{ action: "complete" | "<verb>", ... }`.

Flow names are numbered in roughly the order they were built, not the order they run. There are
**45** flows; there is no flow 33.

---

## Index

| Flow | Area | Triggered by |
| --- | --- | --- |
| 1-Beat-Generator | Story & structure | orchestration |
| 2-Trigger-Orchestration | Story & structure | orchestration |
| 13-Scene-Import | Story & structure | Screenplay |
| 14-Screenplay-Assist | Story & structure | Screenplay |
| 22-Screenplay-Writer | Story & structure | Screenplay |
| 39-Director | Story & structure | Director |
| 42-Shot-Breakdown | Story & structure | Tools |
| 43-Import-Breakdown | Story & structure | Tools / Screenplay |
| 3-Character-Generator | Characters & props | Characters |
| 12-Character-Bible-Import | Characters & props | Characters |
| 23-Character-Bible-Writer | Characters & props | Characters |
| 25-Character-QA-Shots | Characters & props | Characters |
| 40-Character-Wardrobe | Characters & props | Director |
| 24-Face-QA | Characters & props | Face QA |
| 34-Face-Fix | Characters & props | Face QA |
| 4-Panoramic-Generator | Locations & 3D worlds | Panoramas & Worlds |
| 5-3DGS-World-Builder | Locations & 3D worlds | Panoramas & Worlds / Camera |
| 27-Pano-Prompt-From-Image | Locations & 3D worlds | Panoramas & Worlds / Props & Wardrobe |
| 37-Prompt-World | Locations & 3D worlds | internal |
| 38-HY-World | Locations & 3D worlds | HY-World |
| 45-Splat-Camera | Cameras & plates | Camera / Panoramas & Worlds |
| 10-Qwen-Cleanup | Cameras & plates | Qwen Cleanup / Camera |
| 6-GS-Cleaner | Cameras & plates | internal (superseded) |
| 26-Image-Edit | Images & editing | Image Edit (also Props, Director, Relight) |
| 28-Qwen-Image-Edit | Images & editing | Image Edit |
| 36-Z-Image | Images & editing | Image Edit |
| 44-Image-Check | Images & editing | Image Edit |
| 8-MiniMax-Image-To-Video | Video | Image to Video |
| 9-MiniMax-Text-To-Video | Video | Text to Video |
| 17-MiniMax-Ref-To-Video | Video | Ref to Video |
| 35-MiniMax-Video-to-Video | Video | Video to Video |
| 46-MiniMax-Control-To-Video | Video | Control to Video |
| 16-MiniMax-Extend | Video | every video tab, Director, Face QA |
| 11-MiniMax-Prompt-Enhancer | Video | the video tabs |
| 7-MiniMax-Clip-Generator | Video | internal (superseded) |
| 18-Post-Voice | Audio & score | Post Voice |
| 19-Score-Generator | Audio & score | Score |
| 30-Score-Agent | Audio & score | Score |
| 31-Palette-Namer | Colour & finishing | Color Palette |
| 32-Apply-LUT | Colour & finishing | Color Palette |
| 20-Resolve-Deliver | Colour & finishing | DaVinci Resolve |
| 21-Resolve-Chat | Colour & finishing | DaVinci Resolve |
| 15-Delete-Movie | Utilities & housekeeping | movie menu |
| 29-Delete-Asset | Utilities & housekeeping | internal (asset deletion helper) |
| 41-Copy-Movie | Utilities & housekeeping | movie menu |

---

# Story & structure

## 1-Beat-Generator

**Source file:** not in `flowise/nodes/` — the three Custom Function bodies are inline in
`flowise/scripts/_create_beat_generator.js`.

**Purpose:** Reads the active movie's uploaded screenplay, slices out the requested act/scene,
has a language model segment it into beats, and writes those beats to the database.

**Structure:** four nodes — *Fetch Screenplay Scope* (Custom Function) → *Extract Scope Text*
(Custom Function) → *Segment Into Beats* (LLM node with a JSON schema) → *Write Beats to
InsForge* (Custom Function).

**Input:** a bare scope string: `A<act>`, `A<act>S<scene>` or `A<act>S<scene>B<beat>` (e.g.
`A1`, `A1S2`, `A1S2B4`). The movie is whichever row in `movies` has `is_active = true`.

**Output:** `{ scope, results: [{ scene, action: "inserted"|"regenerated"|"skipped", beatCount }] }`.

**Side effects:** reads `movies` and `documents` (kind `screenplay`) plus the screenplay file
from storage; deletes and re-inserts `beats` per scene. Skips a scene whose source text hash is
unchanged. Calls a language model through the LLM node.

## 2-Trigger-Orchestration

**Source file:** not in `flowise/nodes/` — the four Custom Function bodies are inline in
`flowise/scripts/_create_trigger_orchestrator.js`.

**Purpose:** Fan-out driver. Resolves a scope to its characters and scenes, then iterates and
calls `3-Character-Generator`, `4-Panoramic-Generator` and `5-3DGS-World-Builder` once per item.

**Structure:** Start → *Resolve Scope & Characters* → three (Custom Function → Iteration →
ExecuteFlow) chains, one per downstream flow.

**Input:** a scope string with optional force flags: `A1S2 --force`, or the per-stage
`--force-characters`, `--force-pano`, `--force-world`. Force flags are appended to each item
handed to the downstream flow.

**Output:** the resolver returns `{ scope, movieId, movieTitle, beatCount, beatCodes,
characterNames, sceneScopes, force: { characters, pano, world } }`; the three unwrap nodes each
return a plain array for their Iteration node.

**Side effects:** reads `movies` and `beats` only. Writes nothing itself — every write happens
inside the flows it calls. No ComfyUI, no language model.

## 13-Scene-Import

**Source file:** `flowise/nodes/_scene_import_node.js`

**Purpose:** Rolls the `scenes` table up from the beats already stored for the active movie —
`4-Panoramic-Generator` needs a scene row and nothing else ever wrote one — and then has a
language model write the prose fields (location description, atmosphere, set dressing, sound
ambience) that a scene heading alone is too thin to supply.

**Input:** a flag string. `--force` rewrites prose that already exists; `--no-prose` does the
deterministic roll-up only and never calls the model. Empty input is valid.

**Output:** `{ action: "scenes-rolled-up", movie, beatsRead, scenesFound, created, updated,
skipped, skippedPreSceneBeats, proseWritten, proseFailed, model }`.

**Side effects:** reads `movies` and `beats`; inserts and patches `scenes`. Calls a language
model unless `--no-prose`. No ComfyUI.

## 14-Screenplay-Assist

**Source file:** `flowise/nodes/_screenplay_assist_node.js`

**Purpose:** Three assistant jobs behind one flow — structure free prose into acts/scenes/beats,
sharpen one beat, or propose a character bible plus location and prop descriptions from a
movie's beats.

**Input:** `{ "mode": "breakdown" | "enhance" | "bible", ... }`. `breakdown` takes `text`;
`enhance` takes `beat` (the existing beat object), `instruction` and `sceneHeading`; `bible`
takes `movieId`.

**Output:** mode-dependent and never wrapped in an `action`: `breakdown` → `{ proposal: { acts },
scenes, beats }`; `enhance` → `{ beat: { action_text, summary, characters, objects, dialogue } }`;
`bible` → `{ characters, locations, props }`.

**Side effects:** reads `beats` in `bible` mode. **Writes nothing** — every mode returns a
proposal the UI shows for review, and the commit happens through the normal write paths. Calls
a language model. No ComfyUI.

## 22-Screenplay-Writer

**Source file:** `flowise/nodes/_screenplay_writer_node.js`

**Purpose:** A conversation that produces a whole screenplay. Each turn returns the full
document again rather than a patch, because the next thing that happens to it is being pasted
into the breakdown.

**Input:** `{ "messages": [{ "role": "user"|"assistant", "content": "..." }] }`. The first turn
is kept plus a recent window (9 turns total) so the premise stays in view as drafts grow.

**Output:** `{ reply, isScreenplay, scenes, acts }`. Scene numbering is renumbered in document
order by the node rather than trusted to the model, and an `END OF ACT` marker is appended if
the model wrote none.

**Side effects:** none. No database, no storage, no ComfyUI. Calls a language model with a
system prompt supplied through `$systemPrompt`.

## 39-Director

**Source file:** `flowise/nodes/_director_node.js` (by far the largest node in the pipeline;
the rules it enforces are documented separately in `DIRECTOR.md`)

**Purpose:** Plans a movie's shot list from its beats and characters, then drives the stages
that produce it. The split is deliberate: the model decides what is creative (shot type, who is
on screen, what happens, which line a shot carries), and the node computes everything with an
exact format — clip lengths on the generator's frame grid, line timestamps, prompt wording, the
style prefix, and the validity checks.

**Input:** `{ "movieId": "...", "planId": "...", "targetSeconds": 120, "mode": "..." }` where
mode is one of:

- `check` (default) — dry run; reports what a plan would be built from, writes nothing
- `plan` — draft the shot list and write it
- `chainplan` — translate an existing shot list into a chained render plan; writes nothing
- `render` — queue one scene of that chain into ComfyUI (`scene` selects which)
- `assemble` — join the rendered segments into a cut
- `review` — read neighbouring shots (text and frames) and report continuity findings
- `insert` — build and insert one shot at `position`, shifting the rest
- `rebind` — rewrite existing shot prompts from the current script, cast and wardrobe

Additional fields by mode: `scene`, `position`, `positions`, `fromPos`, `toPos`, `beat`,
`characters`, `size`, `type`, `frame`, `foreground`, `continuity`, `action`,
`firstFramePath`, `lastFramePath`.

**Output:** per mode — `{ action: "dry_run", movie, planId, targetSeconds, beats, scenes,
characters, lines, shots, runtime, seconds, breakdown }`, `{ action: "planned", planId, style,
shots, seconds, runtime, cutSeconds, cutRuntime, coverageShots, breakdown }`,
`{ action: "chainplan", planId, shots, plan, tags }`, `{ action: "rendered", scene, of, runName,
promptId, segment, tags }`, `{ action: "assembled", runName, cut, clips }`,
`{ action: "reviewed", checked, pairs, framesRead, findings, clean }`,
`{ action: "inserted", position, scene, shifted, frame_prompt, motion_prompt, length_frames }`,
`{ action: "rebound", checked, changed, positions, dressed, upstream }`.

**Side effects:** reads `movies`, `beats`, `scenes`, `characters`, `character_images`,
`movie_props`, `director_plans`, `director_shots`; writes `director_shots` (replaced wholesale
on `plan`), `director_plans`, `beats` (on `rebind`, when the prompt change implies a script
change) and `movie_props`. Submits graphs to ComfyUI in `render`/`assemble`. Calls a language
model in `plan`, `chainplan`, `review`, `insert` and `rebind`.

## 42-Shot-Breakdown

**Source file:** `flowise/nodes/_shot_breakdown_node.js`

**Purpose:** The Tools tab's way into the standalone breakdown script: detect cuts in an
existing video, extract a frame per shot, and describe each one. The node shells out rather
than reimplementing, so the terminal tool and the tab stay one copy.

**Input:** `{ "mode": "...", ... }` where mode is `choose` (pick a file), `reveal` (open a
folder, takes `dir`), `screenplay` (build a screenplay from a saved breakdown — takes `dir`,
`shotsJson`, `cast`, `title`, `movieId`, `want`) or omitted for the default breakdown run
(`videoPath`, `start`, `end`, `outDir`, `threshold`, `describe`, `transcribe`, `model`).

**Output:** `{ action: "chose", videoPath }`, `{ action: "revealed", dir }`,
`{ action: "screenplay", dir, textPath, jsonPath, title, cast, scenes }` or
`{ action: "broken_down", video, outDir, jsonPath, markdownPath, duration, start, end,
threshold, count, transcript, shots, log }`.

**Side effects:** reads `characters` (to offer the movie's cast). Writes files to disk via the
spawned script; writes no tables. No ComfyUI graph, no direct model call — the script it spawns
does its own describing.

## 43-Import-Breakdown

**Source file:** `flowise/nodes/_import_breakdown_node.js`

**Purpose:** Imports a breakdown produced by `42-Shot-Breakdown` into a movie as both a script
(beats) and a director plan carrying the real coverage, cut for cut. Sizes, foregrounds and
durations come across; prompts do not — they are rebuilt from your own cast, props and wardrobe
when the plan is rendered.

**Input:** `{ "movieId": "...", "screenplayJson": "<path to the breakdown's screenplay.json>",
"what": "both" | "beats" | "shots", "act": 1 }`.

**Output:** `{ action: "imported", movie, counts: { beats, shots }, notes, note }`.

**Side effects:** reads `movies`, `characters`, `scenes`; deletes existing `beats` and
`director_shots` for the scope before inserting; inserts `beats`, `director_plans` and
`director_shots` in batches of 100 with every write status-checked. No ComfyUI, no language
model.

---

# Characters & props

## 3-Character-Generator

**Source files:** `flowise/nodes/_chargen_resolver_node.js` (node 0). Nodes 1–3 are inline in
the flow definition rather than in `flowise/nodes/`; the creator script is
`flowise/scripts/_create_character_generator_flow.js`.

**Purpose:** Turns a character name into a character: resolves or creates the row, finds the
best available description of them, writes a visual descriptor, and renders their reference
image set.

**Structure:** Start → *Resolve Movie & Character* → *Gather Descriptor Sources* → LLM
(*Extract Character Descriptor*) → *Write Character Descriptor* → *Generate Reference Images*.

**Input:** a plain character name plus optional flags: `NAME`, `NAME --type <kind>`,
`NAME --version <n>`, `NAME --force`. The movie is the active one.

**Output:** the resolver returns `{ movieId, movieTitle, movieSlug, bucketName, characterId,
characterName, isNewCharacter, existingCharacter, requestedType, targetVersion }`; the descriptor
node returns `{ action: "descriptor_written" | "skipped" | "no_source_found", sourceType,
characterId, characterName, visual_anchor, clothing, gender }`; the render node returns
`{ action: "generated", characterId, characterName, lora, results: [{ KIND, source, imagePath,
seed, width, height }], reconcile }`.

**Side effects:** reads/creates `characters`; reads `documents` (character bible and uploaded
reference images) and the files behind them from storage; reads `beats`; falls back to a RAG
search function on the InsForge instance. Patches `characters` with the descriptor, and inserts
`character_images`. Submits graphs to ComfyUI for the renders. Calls a vision model when the
source is an uploaded reference photo, and a language model to extract the descriptor.

**Descriptor source order:** character bible entry → whole bible if unstructured → uploaded
reference image (described by the vision model) → the character's introduction beat → RAG search
over the movie's source book.

## 12-Character-Bible-Import

**Source file:** `flowise/nodes/_character_bible_import_node.js`

**Purpose:** Seeds the `characters` table for the active movie straight from its uploaded
character bible, so a new movie has a cast with descriptions before anything else runs.

**Input:** a flag string; `--force` is the only flag. Everything else comes from the active
movie and its newest `character_bible` document.

**Output:** `{ action: "imported", movie, bible, layout: "blocks"|"prose", charactersInBible,
created, updated, skipped, missingVisualAnchor }`.

**Side effects:** reads `movies`, `documents` and the bible file from storage; inserts and
patches `characters`. Two bible layouts are accepted — bracketed `[NAME]` blocks with a
`Visual_Anchor:` line, or one `Name (age): description` paragraph per character. A descriptor
that came from a richer source is never overwritten unless `--force`. No ComfyUI, no model.

## 23-Character-Bible-Writer

**Source file:** `flowise/nodes/_character_bible_writer_node.js`

**Purpose:** A conversation that maintains the character bible. It reads the movie's screenplay
and its existing cast, then rewrites the whole bible on request.

**Input:** `{ "movieId": "...", "messages": [{ "role": "user"|"assistant", "content": "..." }] }`.

**Output:** `{ reply, bible, characters: ["NAME", ...], hadScreenplay }` — `bible` is the reply
from the first `[NAME]` marker onward, split out so the UI can commit exactly the text the
importer will parse.

**Side effects:** reads `movies`, `characters` and the screenplay document from storage.
**Writes nothing** — the result is committed through `12-Character-Bible-Import`, which is the
one path that knows how to reconcile a rewritten bible with characters that have already
rendered. Calls a language model with `$systemPrompt`.

## 25-Character-QA-Shots

**Source file:** `flowise/nodes/_character_qa_shots_node.js`

**Purpose:** Renders the reference shots the face recogniser actually needs — head-and-shoulders
framings at several angles, from one existing photo — because the original human-facing
reference set produced faces too small or too cropped to identify. Can also render a
human-facing multi-view sheet instead.

**Input:** `{ "characterId": "...", "sourceImageId": "...", "mode": "sheet"|"qa", "steps": n,
"seed": n }`. `sourceImageId` is optional; the node picks a source from the character's images
when it is absent.

**Output:** `{ action: "complete"|"error", character, version, sourceImage, created: [kind, ...],
failed, faceCovered, renderStyle, lora, mode, note }`.

**Side effects:** reads `characters`, `movies`, `character_images`; inserts `character_images`.
Stages the source image into ComfyUI's `input/` and submits a graph per shot. No language model.

## 40-Character-Wardrobe

**Source file:** `flowise/nodes/_character_wardrobe_node.js`

**Purpose:** Puts a costume on a character **once**, producing another reference sheet for that
character tagged with the costume — so a shot where they wear it needs one picture for that
person instead of two, and the garment cannot drift shot to shot.

**Input:** `{ "movieId": "...", "characterId": "...", "propId": "...", "imageEditFlowId": "..." }`
(the last is optional and defaults to the installed `26-Image-Edit` id).

**Output:** `{ action: "dressed", character, costume, imagePath, version, basedOn, note }`.

**Side effects:** reads `characters`, `movie_props`, `character_images`; inserts a
`character_images` row of kind `sheet` with `wardrobe_prop_id` set, retrying on the unique
`(character_id, kind, version)` constraint rather than pre-computing a version number. Does not
talk to ComfyUI itself — it calls `26-Image-Edit` through the prediction endpoint, so the
staging, reference wiring and polling live in one place. Builds a prompt from the film's render
style, the character's descriptor and the costume's own description; no model call.

## 24-Face-QA

**Source file:** `flowise/nodes/_face_qa_node.js`

**Purpose:** Scores a rendered clip's face against a character's reference images. Measurement
only — it never edits a clip.

**Input:** `{ "clipId": "...", "characterId": "...", "everyNth": 8, "maxFrames": 40 }`, or
`{ "action": "probe" }` to check the worker's environment.

**Output:** `{ action: "complete", character, clipId, worst, worstAtSeconds, worstAtFrame, mean,
best, sampled, framesScanned, framesRejected, fps, referencesUsed, referenceKinds,
referencesSkipped, frames }`. The headline is the **worst** sampled frame, not the mean, because
drift is usually a short stretch. For a character marked `face_covered` the test inverts and the
output is `{ action: "complete", mode: "covered", uncoveredFrames, coveredFrames, sampled,
firstUncoveredAt, verdict, note }`.

**Side effects:** reads `minimax_clips`, `characters`, `character_images`. Writes no tables.
Shells out to a local Python worker (insightface / buffalo_l) via a temp JSON job file. No
ComfyUI, no language model.

**Reference selection:** prefers the purpose-built `qa_front`, `qa_threequarter_left`,
`qa_threequarter_right`, `qa_low_angle` set when two or more exist; otherwise falls back to the
legacy `closeup`/`portrait`/`uppertorso` kinds. The worker averages every reference into one
centroid, so a weak reference actively pulls the measurement away from the character.

## 34-Face-Fix

**Source file:** `flowise/nodes/_face_fix_node.js`

**Purpose:** Repaints one face in a still to match a character's references — the repair step
Face QA sends you to. It is a still operation on purpose: independently corrected frames do not
agree with each other, so the face is fixed once, on the frame the clip will be re-rendered from.

**Input:** `{ "imagePath": "output/...", "characterId": "...", "maskPrompt": "...", "steps": n }`.

**Output:** `{ action: "complete", character, imagePath, referencesUsed, lora, seed, recorded,
note }`.

**Side effects:** reads `characters`, `movies`, `character_images`; inserts an `image_edits` row.
Submits an inpaint graph to ComfyUI. The mask is detected, never blurred, and an empty mask is
never inverted — an inverted empty mask is a full-frame mask, which would silently regenerate
the whole picture. No language model.

---

# Locations & 3D worlds

## 4-Panoramic-Generator

**Source files:** `flowise/nodes/_pano_resolver_node.js` (node 0) and
`flowise/nodes/_panoramic_generator_node.js` (node 1).

**Purpose:** Renders a 360° equirectangular panorama for a scene, composed from that scene's own
prose fields. Also accepts a panorama uploaded by hand instead of generating one.

**Input:** a scope string with flags: `A1S2`, or a bare scene number (the act is then resolved
from the `scenes` table). Flags: `--force` (regenerate over an existing pano), `--seed <n>`,
`--preset <WxH>` (default `2048 x 1024`). If an image is attached via `$flow.uploads` it is
staged into ComfyUI's `input/` and nothing is generated.

**Output (resolver):** `{ movieId, movieTitle, movieSlug, bucketName, act, sceneNumber, seed,
force, preset }`, passed to node 1 as `$resolveOutput`.
**Output (generator):** `{ action: "generated", sceneNumber, act, imagePath, outputPath, seed,
locationDerivation, roomProse, promptId }`, or `{ action: "manual_upload", ... }`, or
`{ action: "skipped", reason, imagePath }`.

**Side effects:** reads `movies` and `scenes`; upserts `scene_panos`; logs to `prompt_log`.
Submits a graph to ComfyUI. Builds its prompt from the scene's heading, location description,
atmosphere and set dressing; no language model.

## 5-3DGS-World-Builder

**Source files:** node 0 (*Resolve Movie & Scope*) is inline in the flow definition — the
deploy script names it `_world_builder_resolver.js` but it is not in `flowise/nodes/`. Node 1 is
`flowise/nodes/_world_builder_node.js`.

**Purpose:** Builds a navigable 3D Gaussian-splat world for a scene from that scene's panorama,
running the panorama → trajectories → memory bank → world expansion → reconstruction →
`Train3DGS` chain inside ComfyUI.

**Input:** a scope string with a large flag set: `A1S2` plus `--force`, `--resume`,
`--quality fast|standard|detailed|exhaustive`, `--anchors <n>`, `--max-traj <n>`, `--steps <n>`,
`--detail-objects <n>`, `--seed <n>`, `--nav` / `--no-nav`, `--detail` / `--no-detail`,
`--workspace <name>` (build into an existing workspace folder), `--panorama <path under the
ComfyUI root>` (build from that image rather than the newest pano record).

**Output (resolver):** `{ movieId, movieTitle, movieSlug, bucketName, act, sceneNumber, force,
panoImagePath, locationSlug, build: { quality, resume, navTraj, detailTraj, anchors, maxTraj,
steps, detailObjects, seed, workspace, panorama } }`.
**Output (builder):** `{ action: "generated"|"rebuilt"|"resumed"|"skipped"|"error", sceneNumber,
act, workspaceName, plyPath, backupPath, promptId }`.

**Side effects:** reads `movies`, `scenes`, `scene_panos`; upserts `scene_splats`; patches
`scene_floor_plans`. A forced rebuild backs up the existing `.ply` through ComfyUI before
overwriting and aborts if the backup does not complete. Submits several graphs to ComfyUI in
sequence. No language model.

## 27-Pano-Prompt-From-Image

**Source file:** `flowise/nodes/_pano_prompt_node.js`

**Purpose:** Looks at a picture and writes text from it — either a panorama prompt describing
the location (default), or a prop/costume description with a scale note (`mode: "prop"`).

**Input:** `{ "imagePath": "output/..." }` or `{ "storageKey": "...", "movieId": "..." }`, plus
optional `mode: "prop"`, `notes` (operator guidance that overrides the image) and `name` (the
prop's name, so the right object is described on a sheet showing more than one).

**Output:** location mode → `{ action: "complete", prompt, words, sourceBytes }`; prop mode →
`{ action: "described", description, scale_note, sourceBytes }`.

**Side effects:** reads `movies` and fetches the image bytes from ComfyUI's `/view` or from
storage. **Writes nothing** — the operator reads and edits the result before it drives anything.
Calls a vision model. In location mode the required panorama opening is enforced on the reply
rather than hoped for.

## 37-Prompt-World

**Source file:** `flowise/nodes/_prompt_world_node.js`

**Purpose:** A 3D world from a prompt alone, with no scene behind it. Both halves already
existed but only ran scene-first; this runs the same internal stages end to end from text.

**Input:** `{ "worldId": "..." }` — the row is created elsewhere and this flow executes it.

**Output:** `{ action: "complete", worldId, name, workspaceName, panoPath, plyPath }`.

**Side effects:** reads and patches `prompt_worlds` (deliberately not `scene_splats`, whose
`UNIQUE(movie, act, scene)` constraint leaves a scene-less world nowhere to sit); reads `movies`.
Submits the panorama and world-building graphs to ComfyUI. No language model. No admin tab
references this flow — it is invoked directly.

## 38-HY-World

**Source file:** `flowise/nodes/_hyworld_node.js`

**Purpose:** A navigable 3D world from text, a single image, or a video. Two entry points: text
and image run the full five-stage pipeline (panorama → trajectory planning → keyframes →
reconstruction → splat training); video and multi-view go straight into reconstruction, which
predicts its own cameras, so that path has no panorama, no trajectories and no training run.

**Input:** `{ "worldId": "..." }` — the row carries the mode and the source.

**Output:** `{ action: "complete", mode, worldId, name, workspaceName, panoPath, plyPath }` (the
video path omits `panoPath`).

**Side effects:** reads and patches `hyworlds`; reads `movies`. Submits graphs to ComfyUI. The
panorama it makes is an internal stage and never touches `scene_panos`. No language model.

---

# Cameras & plates

## 45-Splat-Camera

**Source file:** `flowise/nodes/_splat_camera_node.js` — a thin wrapper around two Python
scripts (`_splat_camera.py`, `_shot_trajectories.py`), because the work needs torch and gsplat,
which the Flowise sandbox does not have.

**Purpose:** Surveys a scene's splat, names what is in it, places each shot's camera, and
renders its plate.

**Input:** `{ "mode": "...", ... }` with one of six modes:

- `survey` — `movieId`, `act`, `scene`, optional `ply`, `world`
- `landmarks` — `planId`, `set: { "<name>": <bearing>, ... }`, `center: ["<name>", ...]`
- `seed` — `directorPlanId`, `scene`, optional `lookAt`, `from`, `lineSide`
- `render` — `planId`, optional `shot`
- `plys` — `movieId` (lists the movie's splats)
- `sharpen` — `planId` and `directorPlanId`, optional `shot` (writes a camera path through a
  shot and renders it, so the world builder has something new to expand from)

**Output:** `{ action: "<mode>", planId, log }`; `plys` returns parsed JSON instead of a log; a
failure returns `{ action: "error", mode, reason, detail, exitCode }` where `reason` is the
tool's own last line rather than an exit code.

**Side effects:** via the Python tool — reads `scene_splats`, inserts and patches
`scene_floor_plans` (the floor plan and its named landmarks), reads and patches
`director_shots` (the placed camera per shot). Renders plates to disk. No ComfyUI graph, no
language model. Runs with no timeout, deliberately: a survey loads a large splat and renders
many views.

## 10-Qwen-Cleanup

**Source file:** `flowise/nodes/_qwen_cleanup_node.js`

**Purpose:** Cleans up a rendered image — typically a raw camera capture out of a splat — into
a usable plate, guided by a reference image and the scene's panorama.

**Input:** `{ "cleanupId": "<uuid>" }`. Every parameter (source image, reference image,
reference panorama, prompt) lives on the `qwen_cleanups` row; the flow executes it.

**Output:** `{ action: "complete", cleanupId, cleanedImagePath, promptId }`, or
`{ action: "pending", reason, promptId, cleanupId }` when the render is still running past the
check window, or `{ action: "error", reason }`.

**Side effects:** reads and patches `qwen_cleanups` (status, output path, error message); reads
`movies` and `scene_panos`. Stages source and reference images into ComfyUI's `input/` and
submits a graph. No language model.

## 6-GS-Cleaner

**Source files:** both Custom Function bodies are inline in the flow definition; the creator
script is `flowise/scripts/_create_gs_cleaner.js`.

**Purpose:** The per-shot version of the cleanup above — takes a shot's raw camera-angle capture
plus its scene panorama and writes a cleaned plate back onto the shot row.

**Structure:** Start → *Resolve Shot* → *Run Qwen Cleanup*.

**Input:** `{ "shotId": "<uuid>" }`.

**Output (resolver):** `{ shotId, movieId, bucketName, movieSlug, rawCapturePath, panoImagePath }`.
**Output (cleaner):** `{ action: "cleaned", shotId, cleanedImagePath, promptId }`, or `pending`,
or `error`.

**Side effects:** reads `shots`, `scene_panos`, `movies`; patches `shots` (status, cleaned image
path, error message). Uploads the capture to ComfyUI and submits a graph. No language model.

**Status:** superseded. The admin panel that drove this flow is no longer mounted; the plate
step now runs through the Camera tab and `10-Qwen-Cleanup`.

---

# Images & editing

## 26-Image-Edit

**Source file:** `flowise/nodes/_image_edit_node.js`

**Purpose:** The general image renderer: a prompt plus one or more labelled reference images,
chained as reference-latent nodes so a prompt can say "the person from the first image, in the
location from the second". Reference order matters and is preserved end to end. Several other
flows call this one rather than building their own graph.

**Input:** `{ "movieId": "...", "prompt": "...", "references": [{ "path": "output/...",
"label": "..." }], "width": n, "height": n, "steps": n, "seed": n, "loras": [{ "name": "...",
"strength": n }], "useHighDetail": bool, "highDetailStrength": n }`, plus optional provenance
fields for the prompt log: `logKind`, `subjectTable`, `subjectId`, `position`, `sceneNumber`.

**Output:** `{ action: "complete", editId, outputPath, seed, lora, references, width, height }`,
or `{ action: "error", reason, editId }`.

**Side effects:** reads `movies`; inserts an `image_edits` row up front and patches it with the
result; inserts a `prompt_log` row recording exactly what was sent. Stages every reference into
ComfyUI's `input/` and submits a graph. No language model.

## 28-Qwen-Image-Edit

**Source file:** `flowise/nodes/_qwen_image_edit_node.js`

**Purpose:** The same idea as `26-Image-Edit` — prompt plus references — rendered by a different
model. Kept as its own flow because the two graphs share nothing but the staging and polling:
different loader, conditioning, sampler settings and reference limit.

**Input:** identical to `26-Image-Edit` minus the prompt-log fields: `movieId`, `prompt`,
`references`, `width`, `height`, `steps`, `seed`, `loras`, `useHighDetail`, `highDetailStrength`.

**Output:** `{ action: "complete", editId, outputPath, seed, lora, references, width, height }`.

**Side effects:** reads `movies`; inserts and patches `image_edits`, tagged with its own engine
name so results from both editors live in one table. Submits a graph to ComfyUI. No language
model.

## 36-Z-Image

**Source file:** `flowise/nodes/_z_image_node.js`

**Purpose:** Generation only, with LoRAs — deliberately not an editor. The reference-image path
on this model needs a checkpoint that has not been released, so the reference slots are simply
never wired and the tab hides the reference picker for this engine rather than offering
something that breaks.

**Input:** `{ "movieId": "...", "prompt": "...", "width": n, "height": n, "steps": n,
"loras": [{ "name": "...", "strength": n }] }`. Both edges are snapped to a multiple of 16 or
the sampler reshape fails; steps default to 8 at cfg 1 because the model is distilled.

**Output:** `{ action: "complete", editId, outputPath, width, height, steps, seed, loras }`.

**Side effects:** reads `movies`; inserts an `image_edits` row tagged with the engine. Submits a
graph to ComfyUI. No language model.

## 44-Image-Check

**Source file:** `flowise/nodes/_image_check_node.js`

**Purpose:** Asks a vision model whether a rendered picture shows what the prompt asked for.
Explicitly *not* a judge of quality — it answers one narrow question and the caller decides what
to do about it.

**Input:** `{ "imagePath": "output/...", "prompt": "...", "strict": false }`.

**Output:** `{ action: "checked", ok, why, missing: [...] }`. A check that could not run returns
`{ error, ok: null }` rather than `ok: false`, so a failed check is never read as a failed
picture.

**Side effects:** none. Reads the file from ComfyUI's own output folder rather than over HTTP
(the file is on the same machine). Calls a vision model at low temperature with a JSON response
format. No database writes, no ComfyUI graph.

---

# Video

## 8-MiniMax-Image-To-Video

**Source file:** `flowise/nodes/_minimax_av_node.js` (shared with `9-MiniMax-Text-To-Video`; the
two flows differ only in the `$kind` flow variable, `i2v` vs `t2v`).

**Purpose:** Renders a clip from a first frame and an optional last frame, with the model
generating picture and soundtrack together.

**Input:** `{ "clipId": "<uuid>" }`. Prompt, frames, length and dimensions all live on the
`minimax_clips` row; the flow executes it.

**Output:** `{ action: "complete", clipId, mode, videoPath, promptId }`, or
`{ action: "pending", reason, promptId, clipId }`, or `{ action: "error", reason }`.

**Side effects:** reads and patches `minimax_clips` (status, video path, error message); reads
`movies`; inserts a `prompt_log` row. Stages frames into ComfyUI's `input/` and submits a graph.
No language model.

## 9-MiniMax-Text-To-Video

**Source file:** `flowise/nodes/_minimax_av_node.js` (same body as `8-MiniMax-Image-To-Video`,
with `$kind = "t2v"`).

**Purpose:** Renders a clip from the prompt alone — no first or last frame.

**Input / Output / Side effects:** identical to `8-MiniMax-Image-To-Video`; the shared node
branches on `$kind` when building the graph.

## 17-MiniMax-Ref-To-Video

**Source file:** `flowise/nodes/_minimax_ref_node.js`

**Purpose:** Renders a clip from reference images the operator picks, rather than from a first
frame. The graph is a node-for-node copy of the proven reference-to-video template; only where
the inputs come from changed.

**Input:** `{ "clipId": "<uuid>" }`.

**Output:** `{ action: "complete", clipId, references, length, videoPath, promptId }`.

**Side effects:** reads and patches `minimax_clips`; reads `movies`. Stages each reference into
ComfyUI's `input/` and submits a graph. No language model.

## 35-MiniMax-Video-to-Video

**Source file:** `flowise/nodes/_minimax_v2v_node.js`

**Purpose:** Restyles or re-casts an existing clip. The same conditioning node as
reference-to-video, which also accepts reference *videos*: feeding the source clip into one of
those turns generation into transformation — the performance is carried by the video while the
reference images decide the look or the identity. The output is a fresh render, not an edit of
pixels, so Face QA applies to the result.

**Input:** `{ "clipId": "<uuid>" }`.

**Output:** `{ action: "complete", clipId, references, length, videoPath, promptId }`.

**Side effects:** reads and patches `minimax_clips`; reads `movies`. Loads the source video as a
frame batch (forced to 24 fps with a frame cap) and submits a graph to ComfyUI. No new video
model is loaded. No language model.

## 46-MiniMax-Control-To-Video

**Source file:** `flowise/nodes/_minimax_control_node.js`

**Purpose:** Drives a shot with a depth, pose or edge video: the control video decides layout
and motion frame by frame, while the prompt and reference images decide the look and who is in
it. This is the route in from a 3D package — a depth pass rendered over the scene's splat with a
real camera move becomes a photoreal clip that follows that camera exactly.

**Input:** `{ "clipId": "<uuid>" }`. The control video path and strength live on the row. The
control video must match the shot's length, width and height; the panel picks a length the video
can cover.

**Output:** `{ action: "complete", clipId, references, length, strength, videoPath, promptId }`.

**Side effects:** reads and patches `minimax_clips`; reads `movies`. Submits a graph to ComfyUI
with a control-net union checkpoint patched into the model between the loader and the guider.
One checkpoint covers depth, pose, canny, HED and MLSD, so the control type is not a switch — it
is whatever the video shows. No language model.

## 16-MiniMax-Extend

**Source file:** `flowise/nodes/_minimax_extend_node.js`

**Purpose:** Extends an existing clip with a continuation that carries **both** the picture and
the soundtrack forward, so there is no audio seam. The mechanism anchors an image *and* an audio
guide at frame 0 of the new clip, taking the tail of the previous one; the older
last-frame-as-first-frame approach kept the picture continuous but restarted the sound.

**Input:** `{ "clipId": "<uuid>" }` — the new clip row records what it extends.

**Output:** `{ action: "complete", clipId, extendedFrom, extendedFromKind, guideFrames,
guideStartFrame, guideEndFrame, newLength, videoPath, promptId }`.

**Side effects:** reads and patches `minimax_clips`; reads `shots` and `movies`; inserts a
`prompt_log` row. Submits a graph to ComfyUI. No language model.

## 11-MiniMax-Prompt-Enhancer

**Source file:** `flowise/nodes/_prompt_enhancer_node.js`

**Purpose:** Turns a rough motion request, a draft prompt and/or the first frame into a finished
video prompt. Its one hard guarantee is that dialogue survives the rewrite: lines are counted
before and after, a shortfall triggers a retry, and a second shortfall is returned as an error
with the original prompt left unchanged rather than as a success.

**Input:** `{ "draft": "...", "motion": "...", "imageBase64": "...", "systemPrompt": "..." }`.
At least one of `draft`, `motion` or `imageBase64` is required. A non-blank `systemPrompt`
overrides the one configured on the node, so each video tab can be told what to do with its
clips without editing the flow; a blank one means "no opinion" and the flow default applies.

**Output:** `{ prompt, motionWords, dialogueLines, retried, model, systemFrom }`, where
`systemFrom` is `"caller"` or `"flow"` so the UI can say which instructions actually ran. On a
dropped-dialogue failure: `{ error, droppedDialogue: true, expectedLines, gotLines }`.

**Side effects:** none — no database, no storage, no ComfyUI. Calls a multimodal language model.

## 7-MiniMax-Clip-Generator

**Source files:** both Custom Function bodies are inline in the flow definition; the creator
script is `flowise/scripts/_create_minimax_generator.js`.

**Purpose:** The original shot-driven clip renderer: takes a shot's cleaned plate, its saved
prompt and its bound character reference images, and renders the clip.

**Structure:** Start → *Resolve Shot & References* → *Generate MiniMax Clip*.

**Input:** `{ "shotId": "<uuid>" }`. The shot must already have a `cleaned_image_path` (from
`6-GS-Cleaner`) and a saved `prompt_text`.

**Output (resolver):** `{ shotId, movieSlug, cleanedImagePath, referenceImagePaths, promptText,
lengthFrames, extraReferencePaths, bucketName }`.
**Output (generator):** `{ action: "complete", shotId, videoPath, promptId }`, or `pending`, or
`error`.

**Side effects:** reads `shots`, `movies`, `character_images`; patches `shots` (status, video
path, error message). Stages the plate and every reference into ComfyUI and submits a graph. No
language model.

**Status:** superseded. Its panel is no longer mounted; clip rendering now runs through the
`minimax_clips` table and the per-mode video flows above.

---

# Audio & score

## 18-Post-Voice

**Source file:** `flowise/nodes/_post_voice_node.js`

**Purpose:** Replaces the voice in a rendered clip without re-rendering it: the audio is split,
the vocal converted, and the result remixed under the original bed. Two actions on one flow so
the tab needs only one endpoint.

**Input:** `{ "action": "voices" }` to list the available voices, or
`{ "action": "convert", "replacementId": "<uuid>" }` to run one queued job. Source clip, target
voice and gain live on the `voice_replacements` row.

**Output:** `{ voices: [{ id, name, gender, accent }] }`, or `{ action: "complete",
replacementId, outputPath, timingMatch, seconds }`, or `{ action: "error", reason }`.

**Side effects:** reads `voice_replacements`, `minimax_clips`, `movies`; patches
`voice_replacements` through `running` → `complete`/`failed`. Downloads an uploaded source video
from storage when the job has one. Shells out to a local Python job (separation model, ffmpeg,
voice conversion) which reads its own API key server-side — the key never reaches the browser.
Writes its output under ComfyUI's `output/` so the tab can preview it through the same endpoint
as everything else. No ComfyUI graph, no language model.

## 19-Score-Generator

**Source file:** `flowise/nodes/_score_node.js`

**Purpose:** Generates one continuous piece of music to lay under the assembled edit. Kept
deliberately out of clip rendering: the video model writes each clip's audio independently, so
music generated inside clips can never match across a cut.

**Input:** `{ "scoreId": "<uuid>" }` to render a queued score, or
`{ "action": "enhance", "draft": "...", "hasLyrics": bool }` to turn a rough brief into a
finished caption for the music model.

**Output:** enhance → `{ caption, model, hadLyrics }`; render → `{ action: "complete", scoreId,
audioPath, generator, promptId }`, or `{ action: "pending", reason, promptId, scoreId }`, or
`{ action: "error", reason }`.

**Side effects:** reads and patches `scores`; reads `movies` and `minimax_clips`. Branches on
the row's `generator` field across several music backends, staging a source or reference audio
file into ComfyUI when the chosen one takes one, then submits a graph. Calls a language model in
`enhance` mode.

## 30-Score-Agent

**Source file:** `flowise/nodes/_score_agent_node.js`

**Purpose:** Reads a beat and proposes several contrasting cues for it. Not a randomiser — the
story-bound axes (function, mood, arc) are chosen from the taxonomy to fit the scene, and only
instrumentation and era are varied freely between takes. The last take is deliberately a reading
*against* the scene.

**Input:** `{ "beatId": "...", "takes": 4 }` or `{ "movieId": "...", "brief": "...",
"takes": 4 }`. `takes` is clamped to 1–6.

**Output:** `{ action: "complete", beatCode, beatId, count, proposals: [{ title, function, mood,
arc, instrumentation, era, bpm, keyscale, timesignature, caption, note }] }`.

**Side effects:** reads `score_styles` (the taxonomy), `beats` and `scenes`. **Writes nothing
and renders nothing** — the operator picks one and sends it to the Score tab. Calls a language
model, then validates every proposal against the taxonomy: axis labels must be copied exactly,
BPM is clamped into the mood's range, a mood the taxonomy calls minor cannot be given a major
key, and a tempo named in the caption prose is rewritten to agree with the structured value.

---

# Colour & finishing

## 31-Palette-Namer

**Source file:** `flowise/nodes/_palette_namer_node.js`

**Purpose:** Names a colour palette and writes the grading note for it. The swatches are
measured in the browser and passed in; the model is deliberately **not** asked for hex values,
because a vision model reading colours off a picture returns plausible numbers that are quietly
wrong.

**Input:** `{ "imagePath": "output/...", "swatches": ["#......", ...] }`, or
`{ "storageKey": "...", "movieId": "...", "swatches": [...] }`. The image is optional — the
swatches alone are enough to name something reasonable.

**Output:** `{ action: "complete", name, description, sawImage, swatches }`.

**Side effects:** reads `movies` only when fetching from storage. Writes no tables. Calls a
vision model. No ComfyUI graph.

## 32-Apply-LUT

**Source file:** `flowise/nodes/_apply_lut_node.js`

**Purpose:** Grades a rendered clip with a colour palette. The LUT is built from the palette's
swatches with the same luminance-gradient map the browser uses on stills, so a graded frame and
a graded clip agree.

**Input:** `{ "clipId": "...", "paletteId": "...", "strength": 0.6 }` (strength clamped 0–1).

**Output:** `{ action: "complete", clipId, palette, strength, videoPath, lutPath, bytes }`, or
`{ action: "error", reason, lut }`.

**Side effects:** reads `minimax_clips`, `color_palettes`, `movies`. Writes a 33³ `.cube` file
and the graded `.mp4` into `output/<slug>/_graded/` but writes **no database rows** — the caller
records the result. Runs ffmpeg's `lut3d` rather than a ComfyUI graph: it is exact, runs on CPU
in seconds, copies the audio stream untouched, and needs no GPU queue. No language model.

The grade is a neutral-preserving tint, not a colour replacement, with saturation measured from
the palette and applied separately. The colour function is kept identical to the browser's copy;
if one changes the other must, or the preview and the render drift apart.

## 20-Resolve-Deliver

**Source file:** `flowise/nodes/_resolve_node.js`

**Purpose:** Sends the movie's finished clips to DaVinci Resolve as a project with a timeline in
screenplay order — the one thing an editor cannot work out for themselves.

**Input:** `{ "action": "deliver", "movieId": "...", "projectName": "...", "timeline": true }`,
or `{ "action": "status" }`, or `{ "action": "capabilities", "query": "..." }` (a searchable
index of what Resolve can be asked to do).

**Output:** `{ action: "complete", ...worker result, revoicedUsed, orderedByBeat }`, or
`{ action: "error", reason }`.

**Side effects:** reads `movies`, `minimax_clips` (complete only), `beats` and
`voice_replacements`. Writes no tables. Clips are sorted by their beat's sequence index, and a
re-voiced output supersedes the raw clip wherever one exists. Shells out to a Python worker
pinned to the interpreter Resolve ships with — its scripting library crashes the process on any
other. The clip list goes via a temp JSON file because it is far too long for a shell argument.
No ComfyUI, no language model.

## 21-Resolve-Chat

**Source file:** `flowise/nodes/_resolve_chat_node.js`

**Purpose:** A chat that drives DaVinci Resolve through a fixed set of verbs. Two deliberate
constraints: the model never sees or invents a file path — it works in **beat codes** and the
node resolves those to files — and every tool returns the real resulting state (what is in the
pool, what is on the timeline) so the model corrects itself instead of drifting.

**Input:** `{ "action": "chat", "movieId": "...", "messages": [{ "role": "...", "content": "..." }] }`.

**Output:** `{ reply, trace, steps, model }`, or a stopped-early reply with the trace when the
step limit is hit.

**Side effects:** reads `movies`, `minimax_clips`, `beats`, `voice_replacements`. Writes no
tables. Runs an agent loop against a local language model with tool calls, each of which shells
out to the Resolve worker. No ComfyUI.

---

# Utilities & housekeeping

## 15-Delete-Movie

**Source file:** `flowise/nodes/_delete_movie_node.js`

**Purpose:** Deletes a movie and everything belonging to it — database rows, the storage bucket,
and the ComfyUI `input/` and `output/` folders named after its slug.

**Input:** `{ "movieId": "<uuid>" }` for a dry run (the default), or
`{ "movieId": "<uuid>", "confirm": "<exact title>" }` to actually delete. The title has to be
typed back because there is no undo.

**Output:** `{ action: "dry-run", willDelete: { movie, slug, isActive, rows, storageObjects,
bucket, comfyFolders }, note }`, or `{ action: "deleted", movie, slug, deleted, cascaded }`, or
`{ action: "error", stage, reason, partial }`.

**Side effects:** surveys `beats`, `characters`, `documents`, `scenes`, `scene_panos`,
`scene_splats`, `screenplay_chunks`, `shots`, `minimax_clips`, `qwen_cleanups`. On confirm it
deletes `shots`, `minimax_clips` and `qwen_cleanups` explicitly first (the first blocks the movie
delete, the other two have no foreign key and would be silently orphaned), then every storage
object and the bucket, then the ComfyUI folders, then the `movies` row last so the rest cascades.
Folder removal is guarded: the path must resolve inside the ComfyUI root and its basename must
equal the slug. Filesystem access is probed rather than assumed — the sandbox blocks Node
builtins unless they are allowlisted — and degrades to database-and-storage-only if unavailable.
No ComfyUI graph, no language model.

## 29-Delete-Asset

**Source file:** `flowise/nodes/_delete_asset_node.js`

**Purpose:** Deletes rendered files from ComfyUI's folders. The admin app can delete a row but
not a file — ComfyUI exposes no delete endpoint and a browser cannot touch the disk — so every
deletion in the UI used to leave the `.png` or `.mp4` behind.

**Input:** `{ "paths": ["output/...", ...], "force": false }`. Capped at 50 paths per request.

**Output:** `{ action: "complete", deleted: [...], kept: [{ path, reason }], missing: [...],
summary }`.

**Side effects:** deletes files from disk. Two non-negotiable safety rules: a path must resolve
inside ComfyUI's own `output/` or `input/` folder (the caller sends strings that came out of a
database), and a file still referenced by another row is kept and reported with the reason.
References are checked across the scalar path columns of `character_images`, `image_edits`,
`minimax_clips`, `qwen_cleanups`, `scene_panos`, `scene_splats`, `shots`, `voice_replacements`
and `scores`, plus the array/JSON columns `image_edits.reference_paths`,
`minimax_clips.reference_image_paths` and `shots.extra_reference_paths`. A table that cannot be
read counts as a reference — keeping a file is recoverable, deleting a live one is not. Writes no
rows. No ComfyUI graph, no language model.

## 41-Copy-Movie

**Source file:** `flowise/nodes/_copy_movie_node.js`

**Purpose:** The same film again in a different medium. Copies the **words** — story, scenes,
cast, props, wardrobe, shot list, staging — and leaves the **pictures** behind, because the
render style is what every prompt is built on top of and a sheet in the old style would be the
wrong reference in the new one. Prompts are not copied either: they are derived, so copying what
they are built from brings them back by themselves in the new style.

**Input:** `{ "movieId": "...", "title": "...", "slug": "...", "renderStyle":
"photographic"|"anime"|"cartoon"|"animated", "includeShots": true }`.

**Output:** `{ action: "copied", movieId, title, slug, renderStyle, counts, note }`.

**Side effects:** inserts `movies` (never active, so a copy cannot silently redirect work away
from what is being made), creates the storage bucket the generated `bucket_name` column names,
then inserts `characters`, `beats`, `scenes`, `movie_props`, and optionally `director_plans` and
`director_shots`. Every media path comes across as null, deliberately. Inserts run in batches of
100 and every write is status-checked — a copy that silently loses its props is worse than one
that fails. No ComfyUI, no language model.
