# Pipeline Admin — Tab Reference

The pipeline admin is a single-page React (Vite + TypeScript) application that acts as the operator console for an AI film-production pipeline. Everything is scoped to one **movie** at a time, chosen from a picker in the header; the selected movie is marked active in the database, and the backend flows resolve their work from that flag. The app itself does almost no heavy lifting — it reads and writes rows through the InsForge SDK (`insforge.database`, `insforge.storage`) and triggers **Flowise flows** by id, which in turn drive ComfyUI, local model servers and external tools. Rendered images and videos are served from ComfyUI's `/view` endpoint rather than object storage, so most previews in the app point there.

The open tab lives in the URL hash, so refresh and browser back/forward move between tabs. The sidebar can be collapsed to an icon rail. The header also carries a global ComfyUI job/queue indicator, a light/dark theme toggle, and buttons to create, copy or permanently delete the selected movie (deletion is a two-step survey-then-confirm flow that also removes rendered files).

## Contents

| # | Tab | Id |
|---|-----|----|
| 1 | [Screenplay](#screenplay) | `screenplay` |
| 2 | [Documents](#documents) | `documents` |
| 3 | [Beats](#beats) | `beats` |
| 4 | [Characters](#characters) | `characters` |
| 5 | [Props & Wardrobe](#props--wardrobe) | `props` |
| 6 | [Director](#director) | `director` |
| 7 | [Camera](#camera) | `camera` |
| 8 | [Panoramas & Worlds](#panoramas--worlds) | `world` |
| 9 | [HY-World](#hy-world) | `hyworld` |
| 10 | [Qwen Cleanup](#qwen-cleanup) | `qwen` |
| 11 | [Image Edit](#image-edit) | `imageedit` |
| 12 | [Color Palette](#color-palette) | `palette` |
| 13 | [Relight](#relight) | `lighting` |
| 14 | [Image to Video](#image-to-video) | `i2v` |
| 15 | [Text to Video](#text-to-video) | `t2v` |
| 16 | [Ref to Video](#ref-to-video) | `shots` |
| 17 | [Video to Video](#video-to-video) | `v2v` |
| 18 | [Control to Video](#control-to-video) | `control` |
| 19 | [Post Voice](#post-voice) | `postvoice` |
| 20 | [Score](#score) | `score` |
| 21 | [Face QA](#face-qa) | `faceqa` |
| 22 | [DaVinci Resolve](#davinci-resolve) | `resolve` |
| 23 | [Context Loop](#context-loop) | `contextloop` |
| 24 | [Tools](#tools) | `tools` |

---

## Screenplay

`screenplay` — the writing surface. A screenplay is held as a tree of acts → scenes → beats, and every number (act, scene, beat) is derived from position, so inserting or moving an item renumbers the rest automatically.

**Features**

- *Have it written for you* — a chat panel that turns a one-line idea into a full screenplay and keeps taking revision notes; an accepted draft is dropped into the breakdown box below.
- *Write it out and let it be broken down* — paste prose, an outline or a chapter and press **Break it down** to get acts, scenes and beats back.
- **Choose a breakdown…** — imports a shot breakdown produced on the Tools tab (its `shots.json`) as beats plus a director plan carrying that film's coverage.
- Buttons to load a screenplay document already uploaded on the Documents tab straight into the editor.
- *Book to screenplay* — pick any uploaded document, see it split into chapters (with the call count shown up front), then **Convert** them one at a time with live progress and a **Stop** that keeps whatever has converted.
- Tree editor: per-act, per-scene and per-beat move up/down, add and delete buttons; scene heading fields (location, time of day); per-beat action text, one-line summary and a dialogue table (character / parenthetical / line) with add and remove.
- **Enhance** on a beat — rewrites that beat's action text through the assist flow.
- **Save** / dirty indicator; nothing is persisted until saved.
- *Finish* — four ordered buttons: **1. Write screenplay file**, **2. Build scenes**, **3. Characters, locations & props**, **4. Start orchestration**.
- Step 3 returns an editable proposal (character look descriptions, per-scene location descriptions, props with a scale note and alias list) that must be reviewed and explicitly saved, or discarded.

**Flows:** `VITE_SCREENPLAY_WRITER_ID` (22-Screenplay-Writer), `VITE_SCREENPLAY_ASSIST_ID` (breakdown / beat enhance / bible proposal), `VITE_SCENE_IMPORT_ID` (roll beats up into scenes), `VITE_TRIGGER_ORCHESTRATOR_ID` (2-Trigger-Orchestration), `VITE_SHOT_BREAKDOWN_ID` and `VITE_IMPORT_BREAKDOWN_ID` (import a breakdown).

**Tables:** reads/writes `beats`, `scenes`, `characters`, `movie_props`, `documents`; updates `movies.status`.

---

## Documents

`documents` — file storage for the movie: screenplays, character bibles, source books and manually supplied reference images.

**Features**

- Upload form with a **kind** picker: screenplay, character_bible, book, trailer_script, character_reference_image, other.
- When the kind is a character reference image, two extra pickers appear: which character it belongs to, and an optional shot kind (turnaround, closeup, portrait, uppertorso, fbody) so the upload can stand in for that generated angle.
- File input plus **Upload** — the file goes to the movie's storage bucket and a row is recorded.
- Table of every document: kind badge, character and shot-kind badges, filename, size, upload time.
- **View** per row — downloads the object and previews it inline (images as images, text rendered as text, other binaries in a frame), with a **Close** button.
- **Delete** per row — removes the storage object and the row, behind a confirm.

**Flows:** none.

**Tables:** reads/writes `documents`; reads `characters`. Uses the movie's storage bucket directly.

---

## Beats

`beats` — a read-only browser of the beat rows that every downstream stage is built from, with a per-beat trigger for the orchestration pipeline.

**Features**

- One card per beat in sequence order, showing the beat code, INT/EXT, location, time of day and the script line range it covers.
- Beat summary and a badge per character in the beat (hovering shows that character's blocking).
- Click a card to expand it: objects, characters with blocking, the dialogue list, and the raw script excerpt.
- **Run** on a beat — sends that beat code to the orchestrator, with an inline running/ok/error status line.
- Empty state when the movie has no beats yet.

**Flows:** `VITE_TRIGGER_ORCHESTRATOR_ID` (2-Trigger-Orchestration).

**Tables:** reads `beats`.

---

## Characters

`characters` — the cast list. Each character carries the written descriptions every later render reads, an optional LoRA, and a versioned gallery of reference images.

**Features**

- Add form: name (stored upper case) and optional gender, with duplicate detection.
- **Load characters from bible** — reconciles the cast against the newest uploaded character-bible document and reports created/updated/skipped counts.
- *Ask for characters* — a chat agent that reads the screenplay and current cast and proposes a full bible; accepting it writes the document and immediately re-runs the import.
- Per character: **Is a** (person / animal / creature / robot / object), **Drawn as** (photographic / anime / cartoon / 3D animated), and a *face is covered* checkbox that changes how Face QA judges the clip.
- Editable **Look** and **Clothing** descriptions; saving marks them manual so the importer will not overwrite them.
- LoRA picker with model-strength and clip-strength numbers, and **Save**.
- **Generate images** and **Regenerate as version N** — run the character generator; a regeneration lands as a new version beside the old one rather than replacing it.
- **Create QA shots** — renders the specific angles Face QA needs; **Generate reference sheet** renders one tall multi-view sheet for human reference.
- **Add your own** — multi-file upload; uploads become their own version.
- Version blocks with source and count badges, a thumbnail grid, a full-size lightbox, per-image delete and **Delete version** (which also removes the underlying files, keeping any file another row still uses).

**Flows:** `VITE_CHARACTER_GENERATOR_ID` (3-Character-Generator), `VITE_CHARACTER_BIBLE_IMPORT_ID`, `VITE_CHARACTER_QA_SHOTS_ID` (25-Character-QA-Shots), `VITE_CHARACTER_BIBLE_WRITER_ID` (23-Character-Bible-Writer).

**Tables:** reads/writes `characters`, `character_images`; writes `documents`.

---

## Props & Wardrobe

`props` — the catalogue of objects and costumes that are neither characters nor locations, each with a reference sheet so it stops being reinvented shot to shot.

**Features**

- **Find props in the script** — reads the movie's beats and proposes props and costumes with a description, a stated physical scale and the alternate names the script uses.
- Proposal review cards: editable *Looks like*, *Scale* and *Also called* fields, a **Drop** per item, then **Save props and wardrobe (N)** or **Discard**. Matching is on name and aliases, so re-running updates rather than duplicates.
- *Add one* manual form: name, **Kind** (prop / wardrobe), description, scale.
- A movie-wide **Style** picker (anime / cartoon / 3D animated / photographic), defaulted from the cast's render style.
- Separate **Props** and **Wardrobe** listings. Each item has inline-editable description, scale and alias fields that save on blur, a per-item **Drawn as** style picker, and — for wardrobe — a **Worn by** character picker.
- **Render sheet** / **Redo sheet** — renders a multi-view reference sheet for the item and stores it as the item's picture.
- **Describe from the sheet** — a vision pass that proposes a description and scale from the picture, for approval before it is kept.
- *Use an existing picture…* picker and an **Upload a picture** input as alternatives to rendering; both re-read the description from the new picture.
- **Delete** per item.

**Flows:** `VITE_IMAGE_EDIT_ID` (26-Image-Edit) to render sheets, `VITE_PANO_PROMPT_ID` (27-Pano-Prompt-From-Image, in prop mode) to describe them; the script proposal reuses the screenplay assist flow.

**Tables:** reads/writes `movie_props`; reads `characters`.

---

## Director

`director` — turns beats, scenes and cast into an ordered shot list and then produces that list stage by stage: first frames, an automated review, clips, and a stitched cut. This is the busiest tab in the app.

**Features**

- *Scene look* — per scene, editable key light, screen direction and staging fields plus a **Panorama drawn as** style picker; all four are read by the prompts built for that scene's shots.
- *Plan* — a runtime-wanted number, **New plan**, a plan picker, **Check what it would plan from** (a dry run reporting beats, scenes, cast and a projected runtime breakdown without writing), **Draft shot list**, and a **Reset** for a stuck call.
- *Shot list* — one table row per shot: thumbnail, clip player, scene, type, size, characters, length, continuity (continues / fresh), description and status. Rows are separated at each scene change.
- Per-row actions: re-render this frame, insert a shot before this one, apply a stored correction to a flagged frame, **Render clip**, **Replace Image** (swap in any existing project picture as the first frame), and **Export frame** (scrub the clip and save a still into the project).
- Per-row collapsible **Image prompt** and **Motion prompt** editors, plus a read-only summary of where that shot's camera stands.
- Bulk bar (appears when rows are ticked): **redo these N**, a *Place them on…* picker that assigns a background plate to every ticked shot, and a **Wearing** group with one costume dropdown per character that also pushes the choice back into the beats and re-renders the dressed character reference.
- Insert-shot form: what happens, who is in it, what it is for, how close, a foreground note, and optional first/last frame pickers.
- Repair actions: **Redo N flagged frame(s)**, **Redo until clean** (repair/re-check loop with progress and stop conditions) and **Add N missing shot(s)** from the review's gap findings.
- *Produce* — a shot range limiter, a Spectrum-acceleration checkbox, and five stage buttons with live progress counters: **First frames**, **Review frames**, **Clips**, **Speech & frame checks** (not wired), **Assemble**. Frame batches run three at a time and resume where they stopped. **Stop now** clears and interrupts the render queue; **Stop after this one** only sets the loop flag.
- **Render via Context Loop** — an alternative chain that carries the previous scene's picture and sound forward.

**Flows:** `VITE_DIRECTOR_ID` (plan, dry run, prompt rebind, review, insert, chained render, assemble), `VITE_IMAGE_EDIT_ID` (26-Image-Edit) for every still, `VITE_CHARACTER_WARDROBE_ID` (40-Character-Wardrobe) for dressed character sheets, `VITE_MINIMAX_I2V_ID` and `VITE_MINIMAX_EXTEND_ID` for clips. It also calls the ComfyUI queue/interrupt endpoints directly for **Stop now**.

**Tables:** reads/writes `director_plans`, `director_shots`, `minimax_clips`; reads/writes `scenes` and `beats`; reads `characters`, `character_images`, `movie_props`.

---

## Camera

`camera` — the tech recce. Where every camera in one scene stands inside that scene's 3D world, shown as a grid of plates so coverage can be judged side by side rather than down a list.

**Features**

- **Shot list** picker (each plan labelled with its date, shot count in this scene and status) and a **Scene** picker.
- **Survey the room** / **Re-survey** — sweeps the scene's gaussian splat, measures wall distances at every bearing and computes a room radius, so camera distances can be stored as fractions of the room and survive a rebuild.
- A grid of survey views; click one to name what it looks at, from suggested names or free text. Those landmark names are what every camera in the scene points at.
- **Seed cameras for every shot** — gives each shot in the plan a starting camera from the named landmarks.
- **Render every plate** — renders the background plate for all cameras in the plan.
- Per-shot card in the coverage grid: shot number, type, who is on screen, and a camera widget.
- Camera widget sliders: orbit, dolly, elevation, pedestal, tilt, pan and zoom, with a **Bigger** / **Done framing** full-window mode; every change re-renders that shot's plate.
- A collapsible *Numbers* section: looking-at landmark, standing-toward landmark, side of the line, distance and sideways offset as fractions of the room radius, camera height, aim height, aim sideways and lens angle in degrees.
- **Clean up** — repairs the plate with either the splat cleanup engine or the freer image-edit engine, with a short instruction field and a **Back to raw plate** undo.
- **Sharpen this angle** — retrains the scene's world around this camera (behind a confirm, since it takes roughly half an hour and every shot in the scene then renders from the new build).
- Rendering a plate points the shot at it as its background, so the next frame redo composites the cast onto that angle.

**Flows:** `VITE_SPLAT_CAMERA_ID` (45-Splat-Camera) for survey, seed, plate rendering and camera moves; `VITE_WORLD_BUILDER_ID` for sharpening; `VITE_QWEN_CLEANUP_ID` or `VITE_IMAGE_EDIT_ID` for plate cleanup.

**Tables:** reads `scenes`, `director_plans`, `director_shots`; reads/writes `shot_cameras`, `camera_plates`, `scene_floor_plans`, `qwen_cleanups`, `movie_frames`; writes `director_shots.plate_path`.

---

## Panoramas & Worlds

`world` — per scene, a 360° panorama and the 3D gaussian-splat world trained from it. The panorama is the prerequisite for the world; the world is what the Camera tab places cameras in.

**Features**

- One card per scene with its current panorama preview and badges showing the panorama source and whether a splat is ready.
- *Describe from an image…* — a vision pass that looks at any picture in the movie and writes a panorama description into the box below.
- A per-scene description box (optional; leaving it empty derives the description from the scene prose), pre-seeded with the required framing on first focus.
- **Generate panorama** / **Regenerate**, **Delete panorama**, and **Use my own image** to upload a panorama instead of generating one.
- **View panorama** and **View splat** open interactive viewers; a snapshot taken in either is saved back into the movie as a picture usable in every image picker.
- **Build world** / **Rebuild world** / **Continue training**, with a *Continue from checkpoint* checkbox that keeps the coordinate frame (so floor plans and shot cameras still hold) and backs up the current file first. **Delete splat** removes the world and its file.
- **World detail** preset picker — fast, standard, detailed or exhaustive — with a plain-language note on what each trades and roughly how long it takes.
- An *Advanced* section overriding the preset's individual numbers: anchor scans, max trajectories (0 = uncapped) and training steps.
- A *Splat version* section listing every `.ply` on disk for the scene with its date, size, workspace and whether it is in use, plus **Use this one** to repoint the scene and its floor plan, and **Rescan**.

**Flows:** `VITE_PANORAMIC_GENERATOR_ID` (generate or accept an uploaded panorama), `VITE_WORLD_BUILDER_ID` (train the splat), `VITE_PANO_PROMPT_ID` (27-Pano-Prompt-From-Image), `VITE_SPLAT_CAMERA_ID` (45-Splat-Camera, to list the `.ply` files on disk).

**Tables:** reads/writes `scene_panos`, `scene_splats`, `scene_floor_plans`; reads `scenes`, `characters`, `character_images`, `qwen_cleanups`, `image_edits`, `movie_frames`.

---

## HY-World

`hyworld` — a separate world-generation pipeline that takes text, one image, several photos or a video and produces a navigable 3D world. It generates its own panorama internally and is wired to nothing else in the app.

**Features**

- **Build from** picker with four input modes: text, an image, several photos, or a video.
- A **Name** field, required for every mode.
- Text and single-image modes show a description box (optional for the image mode).
- Image mode: pick any picture already in the movie, or upload one directly.
- Several-photos mode: add pictures from the movie one at a time, or upload several at once; the chosen views are shown as an ordered grid with a **Remove** per view. At least two photos of the same place are required.
- Video mode: a thumbnail picker over the movie's finished clips, with a note that a moving shot reconstructs far better than a locked-off one.
- **Build the world**, with a blocked-reason line naming whatever is still missing and a status line describing the stage in progress.
- Worlds list: name, input-mode and status badges, the generated panorama preview, the output file path and any error message.
- Per world: **View splat**, **View panorama** (both with snapshot-to-project) and **Remove** (which drops the row but leaves the large files on disk).

**Flows:** `VITE_HYWORLD_ID` (38-HY-World).

**Tables:** reads/writes `hyworlds`; reads `minimax_clips` and the shared image catalogue.

---

## Qwen Cleanup

`qwen` — a two-image edit that corrects a source image against a clean reference. It is the same graph the pipeline runs as its cleanup step, exposed on its own for any image.

**Features**

- *Source image* — the angle that needs correcting. Pick any picture in the movie, upload one, or **Capture from splat** to grab it from the scene's 3D world in an interactive viewer.
- *Reference* — radio pair choosing between using a scene panorama or supplying your own. **Capture from panorama** grabs a frame from the panorama viewer, and there is a dedicated picker for previously saved panorama snapshots.
- A scene picker, used when the reference is a scene panorama.
- Both viewer snapshots are also saved into the movie so the same angle can be reused anywhere.
- An editable instruction box with a **Reset to pipeline default** button, so a standalone run behaves identically to the pipeline step unless deliberately changed.
- **Run Qwen Cleanup** and **Refresh**; the job continues server-side if you navigate away.
- Cleanups list: timestamp, status badge, which scene panorama or uploaded reference was used, the result image, any error, and a **Delete** behind a confirm that also removes the file.

**Flows:** `VITE_QWEN_CLEANUP_ID`; `VITE_DELETE_ASSET_ID` (29-Delete-Asset) when a cleanup is deleted.

**Tables:** reads/writes `qwen_cleanups`; reads `scenes`, `scene_panos`, `scene_splats`. Uploads both inputs to the movie's storage bucket.

---

## Image Edit

`imageedit` — composes a still from reference images you pick (a character, a location, your own pictures) and a written instruction. Three renderers are available behind one form.

**Features**

- Engine tabs: a reference-editing model (up to 4 references), a faster distilled editing model (up to 3 references), and a generate-only turbo model (no references, a few seconds per image).
- *Reference images* — add from a grouped gallery of every picture in the movie, or from a file. Each reference shows a numbered badge (the instruction refers to them by position), with ↑ / ↓ to reorder and **Remove**.
- An instruction box describing what to make.
- **Size** picker with five presets plus **Custom…** (width and height snapped to multiples of 16), a **Steps** number, a **Palette** picker that appends a grading note, and a **LoRAs** picker.
- **Generate** — renders once. **Generate and review** — renders, checks the result against its own instruction, and re-renders up to twice if something asked for is missing.
- Results grid: timestamp, status, dimensions, LoRA badges, the image, the instruction, which references were used, and any verdict text.
- Per-result actions: **Load settings** (restores instruction, size, steps and LoRAs into the form), relight, face fix, grade, **Evaluate and redo**, and **Delete**.

**Flows:** `VITE_IMAGE_EDIT_ID` (26-Image-Edit), `VITE_QWEN_IMAGE_EDIT_ID` (28-Qwen-Image-Edit), `VITE_Z_IMAGE_ID` (36-Z-Image), `VITE_IMAGE_CHECK_ID` (the review pass). Derived actions on a card reach the relight, face-fix and LUT flows.

**Tables:** reads/writes `image_edits`; reads `characters`, `character_images`, `scene_panos`, `qwen_cleanups`, `movie_frames`, `color_palettes`.

---

## Color Palette

`palette` — a library of looks. A palette is swatches measured off a picture in the browser plus a grading note written by a vision model; the note is the half that steers a render.

**Features**

- *Pull a palette from a picture* — choose any picture in the movie or upload one; the browser quantises it into six swatches and the model proposes a name and grading note.
- Draft card showing the source image and swatch strip, with editable name and note, **Save palette** and **Discard**.
- *Apply a palette* — target picker (an image or a clip), the image or clip to grade, the palette, and a **Strength** slider shown as a percentage.
- **Apply** — images are graded in the browser instantly; clips go through ffmpeg with a LUT built from the same maths, so a graded still and a graded clip agree. Both write a copy and never touch the original.
- Graded results grid with inline image or video preview.
- *Palette library* — cards showing the source picture or a swatch gradient, the swatch strip, the name, a "built in" badge on shared palettes and a delete button on your own. Clicking a card selects it for grading.

**Flows:** `VITE_PALETTE_NAMER_ID` (31-Palette-Namer) to name a palette; `VITE_APPLY_LUT_ID` (32-Apply-LUT) to grade a clip.

**Tables:** reads/writes `color_palettes`; reads `minimax_clips` (graded clips are excluded as sources) and the shared image catalogue; a graded clip is inserted back into `minimax_clips`.

---

## Relight

`lighting` — relighting a still before it moves. A relit first frame handed to image-to-video keeps its lighting through the clip, which is why only stills are relit here.

**Features**

- Picture picker over every image in the movie, and **Relight** using the selected setup; it relights a copy and leaves the original untouched.
- **Render previews for the library** — relights the chosen picture with every setup that has no preview yet, small and one at a time, so the gallery becomes a comparable grid. Setups that already have a preview are skipped, making it resumable.
- Results grid with a **Use as preview** button that promotes a result to the library thumbnail.
- *Lighting library* — a card grid of setups with thumbnails; click to select, click again to clear. Built-in setups are badged; your own have a delete button.
- *Write your own* — a name field, a one-sentence description of the light, and **Save setup**.
- A scope fence (same subjects, poses, clothing and framing) is appended automatically and cannot be edited away; the panel shows the full instruction a selected setup will send.

**Flows:** `VITE_IMAGE_EDIT_ID` (26-Image-Edit) performs the relight.

**Tables:** reads/writes `lighting_presets`, `lighting_preset_previews`; writes results into `image_edits`.

---

## Image to Video

`i2v` — animates from a supplied first frame, optionally interpolating toward a last frame. One of five tabs served by the same video panel; the differences are listed under each tab below, and the shared controls are described here once.

**Shared video-panel features (all five video tabs)**

- *Beat* — a scene picker and a beat picker, with the beat summary shown below.
- *Prompt* — **Fill from beat** composes a description from the beat and scene fields; **Enhance prompt** rewrites the box through the prompt-enhancer flow.
- *LLM system prompt* — a per-tab instruction stored in the browser; when set, every Generate is rewritten through it first and the rewrite appears in the prompt box. **Clear system prompt** removes it.
- *Camera* — a dropdown per camera axis (move, shot, angle, lens, look) drawn from the movie's camera presets, with a live preview of the composed camera line, a **Clear** button and a free-text motion request that is passed to the enhancer.
- *Output* — a resolution picker with four presets plus **Custom…** (width/height snapped to multiples of 16), a duration in seconds, and a badge showing the resulting frame count at 24 fps. The duration is re-derived from the selected beat's dialogue or action, and typing over it wins until the beat changes.
- **Generate** (with a "Generate needs: …" line naming whatever input is missing) and **Refresh**. Renders continue server-side if you navigate away.
- *Generations* — cards showing mode, status, dimensions, frame count and the prompt, with inline playback. Per card: **Extend this clip** (a frame scrubber that anchors the continuation, plus **Save frame to references** and **Use last frame**), **Grade** (palette chips and a strength slider, writing a graded copy), **Load settings into form**, and **Delete clip** behind a confirm that reports what else the deletion affects.

**Specific to this tab**

- Radio pair: first image only, or first and last image.
- File input plus an "or pick from this movie…" gallery picker for each of the first and last frame, with a thumbnail preview and **Clear**.
- Offers the Spectrum acceleration checkbox; camera axes are limited to movement and look, because the supplied frame has already fixed the framing, angle and lens.

**Flows:** `VITE_MINIMAX_I2V_ID`; `VITE_MINIMAX_EXTEND_ID` for extensions; `VITE_PROMPT_ENHANCER_ID` for rewrites; `VITE_APPLY_LUT_ID` (32-Apply-LUT) for grading; `VITE_DELETE_ASSET_ID` (29-Delete-Asset) for deletions.

**Tables:** reads/writes `minimax_clips`; reads `scenes`, `beats`, `characters`, `character_images`, `scene_panos`, `qwen_cleanups`, `image_edits`, `movie_frames`, `camera_presets`, `color_palettes`, `voice_replacements`; reads/writes `movie_reference_images`.

---

## Text to Video

`t2v` — generates a clip from the prompt alone, with no picture input.

**Features**

- No image, reference or clip inputs; the prompt and camera settings are the whole brief.
- The only tab that offers all five camera axes (move, shot, angle, lens, look), because nothing else has fixed the framing.
- Offers the Spectrum acceleration checkbox.
- All the shared controls listed under [Image to Video](#image-to-video): beat picker, fill-from-beat, enhance, per-tab system prompt, resolution and duration, generations list with extend, grade, load-settings and delete.

**Flows:** `VITE_MINIMAX_T2V_ID`, plus the shared enhancer, extend, LUT and delete-asset flows.

**Tables:** as for [Image to Video](#image-to-video).

---

## Ref to Video

`shots` — generates a clip from reference images you pick, so a character or a look carries into the shot.

**Features**

- *Reference images* — a pool of pictures for the movie. Clicking thumbnails picks them in order, and the order is what the model receives; clicking again drops one. Only the first nine are used.
- Add to the pool from a file, or from the grouped gallery of every picture in the movie. Each pooled thumbnail has a zoom badge and a remove badge (which deletes the row and the stored object).
- A count line stating how many are picked, or that at least one is needed.
- Spectrum acceleration is not offered on this tab; camera axes are limited to movement and look.
- All the shared controls listed under [Image to Video](#image-to-video).

**Flows:** `VITE_MINIMAX_REF_ID`, plus the shared enhancer, extend, LUT and delete-asset flows.

**Tables:** as for [Image to Video](#image-to-video); this tab is the main writer of `movie_reference_images`.

---

## Video to Video

`v2v` — restyles or re-casts a clip you already have, keeping the original performance.

**Features**

- *Clip to transform* — a thumbnail picker over the movie's finished clips; selecting one auto-matches its resolution and duration.
- The same reference-image pool as [Ref to Video](#ref-to-video), used here to decide what the clip becomes.
- Only the "look" camera axis is offered: the source clip already fixes framing, angle, lens and the camera move.
- Spectrum acceleration is not offered. The generations list shows only transformed clips.
- All the shared controls listed under [Image to Video](#image-to-video).

**Flows:** `VITE_MINIMAX_V2V_ID` (35-MiniMax-Video-to-Video), plus the shared enhancer, LUT and delete-asset flows.

**Tables:** as for [Image to Video](#image-to-video).

---

## Control to Video

`control` — drives a shot with a depth, pose or edge video (typically rendered in a 3D package over the scene's splat or mesh), so layout and motion come from the control pass while the model decides the look.

**Features**

- *Control video* — a file input accepting common video formats. The browser probes the file and reports its frame count at 24 fps and the longest shot it can drive.
- **Pass** picker: depth, pose (skeleton), canny edges, HED soft edges, or MLSD lines.
- **Strength** slider (0–1.5) governing how tightly the control pass is followed.
- A length rule: the render refuses if the control video is shorter than the minimum shot length, and the duration is clamped to what the video can cover.
- The reference-image pool is available but optional — character sheets keep an identity across frames, and a plate can stand in as the location.
- Only the "look" camera axis is offered; Spectrum acceleration is not.
- All the shared controls listed under [Image to Video](#image-to-video).

**Flows:** `VITE_MINIMAX_CONTROL_ID` (46-MiniMax-Control-To-Video), plus the shared enhancer, LUT and delete-asset flows.

**Tables:** as for [Image to Video](#image-to-video).

---

## Post Voice

`postvoice` — replaces the voice in a clip that has already rendered, keeping its music and effects and preserving lip-sync. Nothing is re-generated, so it costs no GPU time.

**Features**

- Source radio pair: a clip from this project, or a video file from your computer. Either way a preview player is shown before a job is spent.
- Clip picker over the movie's finished clips, labelled with mode, frame count and resolution.
- Voice picker populated from the provider through the flow (the API key stays server-side), with a **Reload voices** button.
- **Voice level** number — conversions come back quieter than the original, so this lifts the new voice back over the music bed.
- **Replace voice** — uploads the file if needed, records a queued job and starts the conversion; separation loads a large model, so the first run takes several minutes.
- **Refresh** to poll for results.
- Replacements list: voice name, status, a timing-match score (1.00 means every syllable lands where the original did), the source, any error, and the finished video inline.

**Flows:** `VITE_POST_VOICE_ID` (both the voice listing and the conversion).

**Tables:** reads/writes `voice_replacements`; reads `minimax_clips`.

---

## Score

`score` — generates music once for a whole scene or sequence, to lay under the edit. Clips are told not to score themselves, because per-clip audio cannot match across a cut.

**Features**

- *How* — four generators: two local ACE-Step variants (full quality and a distilled turbo), a local long-form music model, and a cloud to-picture generator. Each shows a one-line note on what it trades.
- For the to-picture generator: a radio pair choosing a file from your computer or a clip from the project, with a preview; the video's length sets the length of the piece.
- **Enhance caption** — expands a couple of words into a full structured brief.
- Preset buttons that load complete worked example briefs into the box as starting points.
- *Ask the composer* — pick a beat and press **Suggest cues**; the agent proposes several contrasting cues (function, mood, arc, instrumentation, era, tempo, key, time signature) and each has a **Use this cue** button that loads it into the form. Proposals only; nothing renders.
- *Write the cue* — an optional title, a length in seconds, and the caption box.
- For the ACE-Step generators: BPM, key, time signature and lyrics-language pickers, plus an optional reference track upload that lends the cue its timbre (and switches off the planning pass).
- A lyrics box with section tags; leaving it empty yields an instrumental of exactly the requested length, while lyrics let the model decide the length.
- **Generate score**, a **Takes** number (1–6, same brief with different seeds) and **Refresh**.
- Scores list: title, status, length, a **3 more takes** button, **Delete**, the brief, any error, and an inline audio player.

**Flows:** `VITE_SCORE_ID` (generation and caption enhancement), `VITE_SCORE_AGENT_ID` (30-Score-Agent, cue proposals).

**Tables:** reads/writes `scores`; reads `beats` and `minimax_clips`.

---

## Face QA

`faceqa` — scores a rendered clip against a character's reference images to find face drift, and offers the repairs that follow from the result.

**Features**

- Clip thumbnail picker with inline playback, and a character picker ("who should be in it") whose reference images are the yardstick.
- *Sampling* — **Every Nth frame** and **Max frames** numbers, then **Score this clip**.
- A verdict banded against calibrated thresholds, with worst / mean / best similarity, how many frames were scanned and rejected, which references were used and which were skipped and why.
- A gallery of the worst frames beside the reference images, so the number can be checked against the evidence.
- For a character marked as never seen unmasked, likeness is not scored at all; the check becomes whether the covering stayed on.
- A *What next* section that works out the action from where the clean frames are: nothing to do, **Retake from frame N** (continues from the last frame with enough clean frames behind it), or fix the first frame and render again when there is no anchor.
- **Save the first frame** / **Save the anchor frame** — files the frame into the project so it can be relit or edited and used as a first frame on Image to Video.
- **Fix the face on that frame** — repaints only the detected face to match the character; everything outside the mask keeps its original pixels, and no detected face is a deliberate no-op.
- *Fix a face on any picture* — the same repaint applied to any picture in the movie, without scoring anything first.

**Flows:** `VITE_FACE_QA_ID` (24-Face-QA), `VITE_FACE_FIX_ID` (34-Face-Fix), `VITE_MINIMAX_EXTEND_ID` (queueing a retake).

**Tables:** reads `minimax_clips`, `characters`, `character_images`; writes `minimax_clips` (the retake row).

---

## DaVinci Resolve

`resolve` — sends the movie's finished clips to DaVinci Resolve as a new project, laid on a timeline in screenplay order rather than render order.

**Features**

- **Check Resolve** — reports the product, the currently open project and whether scripting is reachable, with a reminder that external scripting must be enabled in Resolve's preferences.
- A summary of what will be sent: how many finished clips, and how many of those have a post-voice version (the re-voiced file is used instead of the original).
- A project-name field and a *Build a timeline as well as importing* checkbox. An existing project of the same name is never overwritten — a number is appended.
- **Send to Resolve**, with a result card reporting the project name, whether it was renamed, how many clips imported, whether a timeline was built, whether beat order was used, and any files missing on disk.
- *What can it do?* — a searchable index of Resolve's scripting methods and this project's live settings with their current values.
- *Ask Resolve* — a plain-English chat scoped to Resolve's scripting API. Anything that deletes, closes or overwrites is refused until approved in words, and each step it takes is listed under the reply as a pass/fail badge. **Send** and **Clear**.

**Flows:** `VITE_RESOLVE_ID` (status, capabilities, deliver) and `VITE_RESOLVE_CHAT_ID` (the agent).

**Tables:** reads `minimax_clips` and `voice_replacements`.

---

## Context Loop

`contextloop` — an embedded ComfyUI, for evaluating a third-party video workflow pack on its own terms. It is deliberately wired to nothing: it reads no movie, writes no row and triggers no flow, and the pack's runs land in their own output folder.

**Features**

- A pack-status check that calls ComfyUI for one of the pack's node types and reports one of four states: checking, loaded, installed but not loaded (custom nodes register only at startup, so a restart is needed), or ComfyUI not answering.
- **Re-check**, **Reload the view** and **Open in its own window**.
- A collapsible list of the pack's usable entry-point workflows with a one-line note on each, and where to find them in ComfyUI's own Workflows sidebar.
- Notes on what to expect: the model loaders must be re-pointed at this machine's variants, and each run needs a unique run name because reusing one resumes that run.
- The ComfyUI web interface itself, embedded full-width — the pack's controls are ComfyUI nodes, so the graph editor is the interface.

**Flows:** none. It talks to the ComfyUI URL directly.

**Tables:** none.

---

## Tools

`tools` — utilities that sit beside the pipeline rather than in it: they read something you already have and hand back text. Nothing here writes to a movie unless you explicitly send it.

**Features**

- *Shot breakdown* — a path field for a video file on the machine Flowise runs on, plus a **Choose file** button that opens that machine's real file dialog (a browser file input cannot supply a path).
- **From** / **to** fields to limit the breakdown to part of the film, in seconds or mm:ss or hh:mm:ss.
- **Cut sensitivity** number deciding how different two frames must be to count as a cut.
- *Describe each shot* checkbox (one vision call per shot) and *Transcribe* checkbox with a model-size picker trading speed against accuracy on overlapping speech.
- **Break it down** — finds every cut, pulls the first frame of each shot and describes it, then reports the shot count, the runtime, the output folder, and a table of shots with timecode, held duration, size, who is in frame, the composition and the words spoken over it. **Open the folder** reveals the output in the file explorer.
- *Screenplay* — **Choose breakdown…** (or the one just produced), an optional cast-hints field mapping names to visual descriptions, and **Build screenplay**, which groups shots into scenes by place and into beats by where the talking starts and stops. The last-used breakdown path and cast hints are remembered in the browser.
- **Download screenplay** saves the returned text locally; **Send to _movie_** imports its beats plus a director plan carrying that film's coverage, cut for cut, into the selected movie.
- A table of the resulting scenes with headings, beat counts and line counts.

**Flows:** `VITE_SHOT_BREAKDOWN_ID` (breakdown, file dialog, folder reveal and screenplay build) and `VITE_IMPORT_BREAKDOWN_ID` (importing into a movie).

**Tables:** none directly — the breakdown writes only files. The import flow writes beats and a director plan server-side.
