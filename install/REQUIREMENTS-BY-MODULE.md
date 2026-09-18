# Requirements, module by module

GENERATED from `modules.json` by `lib/write-requirements.js` - do not edit by hand.

What each module needs before it will work, and what it adds. The global requirements -
hardware, runtimes, service versions - are in [../requirements.md](../requirements.md);
this is only what varies per module.

## At a glance

| Module | Needs | Tabs | Tables | Flows | Node packs |
|---|---|---|---|---|---|
| `core` | - | - | 5 | 3 | 0 |
| `screenplay` | core | Screenplay, Documents, Beats | 4 | 6 | 0 |
| `characters` | core, screenplay | Characters, Props & Wardrobe | 3 | 5 | 1 |
| `imaging` | core | Image Edit, Qwen Cleanup | 2 | 5 | 0 |
| `world` | core, screenplay | Panoramas & Worlds, HY-World | 4 | 6 | 5 |
| `camera` | core, world, director | Camera | 4 | 1 | 1 |
| `director` | core, screenplay, characters | Director, Context Loop | 3 | 1 | 1 |
| `video` | core | Image to Video, Text to Video, Ref to Video, Video to Video, Control to Video | 1 | 7 | 5 |
| `faceqa` | core, characters, video | Face QA | 0 | 2 | 2 |
| `colour` | core, imaging | Color Palette, Relight | 3 | 2 | 0 |
| `audio` | core | Score, Post Voice | 3 | 3 | 0 |
| `delivery` | core, video | DaVinci Resolve | 0 | 2 | 0 |
| `tools` | core, screenplay | Tools | 0 | 0 | 0 |
| `orchestration` | core, screenplay, characters, world | - | 0 | 1 | 0 |
| `library` | core | - | 1 | 0 | 0 |

## What each one needs in place

### `core` — Core

The database, the Flowise instance, the render host and the admin shell. Installs no feature tabs: it is what every module is installed into.

- **Modules first:** none
- **ComfyUI node packs:** none
- **Models:** none
- **Creates tables:** `movies`, `prompt_log`, `movie_frames`, `movie_reference_images`, `installed_modules`
- **Full page:** [modules/core/README.md](modules/core/README.md)

### `screenplay` — Screenplay & structure

Write or import a script, break it into acts, scenes and beats, and keep that structure editable. Everything downstream hangs off these rows.

- **Modules first:** `core`
- **ComfyUI node packs:** none
- **Models:**
  - ollama: a text model for parsing and drafting
- **Adds tabs:** Screenplay, Documents, Beats
- **Creates tables:** `scenes`, `beats`, `screenplay_chunks`, `documents`
- **Full page:** [modules/screenplay/README.md](modules/screenplay/README.md)

### `characters` — Characters & props

Every person and object that has to look the same in every shot: reference sheets, wardrobe, and the identity references the image and video models are given.

- **Modules first:** `core`, `screenplay`
- **ComfyUI node packs:** `comfyui_segment_anything`
- **Models:**
  - diffusion_models: the image generator
  - loras: per-character identity LoRAs (trained, optional)
- **Adds tabs:** Characters, Props & Wardrobe
- **Creates tables:** `characters`, `character_images`, `movie_props`
- **Full page:** [modules/characters/README.md](modules/characters/README.md)

### `imaging` — Image generation & editing

Compose or correct a still from references and a description. Also the cleanup pass that turns a rough render into a usable picture.

- **Modules first:** `core`
- **ComfyUI node packs:** none
- **Models:**
  - diffusion_models: the editing model
  - vae, text_encoders: its encoders
  - loras: acceleration
- **Adds tabs:** Image Edit, Qwen Cleanup
- **Creates tables:** `image_edits`, `qwen_cleanups`
- **Full page:** [modules/imaging/README.md](modules/imaging/README.md)

### `world` — Locations & 3D worlds

A 360-degree panorama of a location, and the navigable Gaussian-splat world built from it, which is what cameras are later placed inside.

- **Modules first:** `core`, `screenplay`
- **Optional:** `library` — used if present, skipped if not
- **ComfyUI node packs:** `ComfyUI_HYWorld2`, `panorama-stickers`, `comfyui-gsplat-room-viewer`, `comfyui-rename-file`, `comfyui-various`
- **Models:**
  - the panorama generator
  - WorldStereo Light
  - WorldMirror
  - a vision-language model for scene parsing
- **Adds tabs:** Panoramas & Worlds, HY-World
- **Creates tables:** `scene_panos`, `scene_splats`, `hyworlds`, `prompt_worlds`
- **Full page:** [modules/world/README.md](modules/world/README.md)

### `camera` — Cameras & plates

Place a camera inside a built world by intent rather than coordinates, render the plate it sees, and sharpen the world at that angle.

- **Modules first:** `core`, `world`, `director`
- **ComfyUI node packs:** `ComfyUI_HYWorld2`
- **Models:**
  - none of its own; it renders from a trained splat
- **Adds tabs:** Camera
- **Creates tables:** `scene_floor_plans`, `shot_cameras`, `camera_plates`, `camera_presets`
- **Full page:** [modules/camera/README.md](modules/camera/README.md)

### `director` — Director & shot lists

Turn beats into a shot list, decide what each shot is for and who is in it, and generate the opening frame of each.

- **Modules first:** `core`, `screenplay`, `characters`
- **ComfyUI node packs:** `ComfyUI-MiniMaxH3-Context-Loop`
- **Models:**
  - the video model's reference conditioning
  - a text model for planning
- **Adds tabs:** Director, Context Loop
- **Creates tables:** `director_plans`, `director_shots`, `shots`
- **Full page:** [modules/director/README.md](modules/director/README.md)

### `video` — Video generation

Every route from a still or a description to a moving clip with sound: from a frame, from text, from references, from an existing clip, or driven by a depth or pose video.

- **Modules first:** `core`
- **ComfyUI node packs:** `comfyui-videohelpersuite`, `comfyui-kjnodes`, `ComfyUI-Spectrum-MiniMax-H3`, `ComfyUI-H3-FunControl`, `ComfyUI-H3-Motion-Context-MultiRef`
- **Models:**
  - the video model, both its bases
  - its video and audio VAEs
  - its text encoder
  - the control adapter (for the control tab)
- **Adds tabs:** Image to Video, Text to Video, Ref to Video, Video to Video, Control to Video
- **Creates tables:** `minimax_clips`
- **Full page:** [modules/video/README.md](modules/video/README.md)

### `faceqa` — Face QA & repair

Score a rendered clip against a character's references to find identity drift, and repaint a face in place when it has drifted.

- **Modules first:** `core`, `characters`, `video`
- **ComfyUI node packs:** `comfyui_segment_anything`, `comfyui-videohelpersuite`
- **Models:**
  - a face embedding model
  - a detector and a segmenter
  - an inpainting model
- **Adds tabs:** Face QA
- **Full page:** [modules/faceqa/README.md](modules/faceqa/README.md)

### `colour` — Colour & lighting

Pull a look off a picture and grade toward it, and light a still before it moves so the clip inherits the lighting.

- **Modules first:** `core`, `imaging`
- **ComfyUI node packs:** none
- **Models:**
  - the image editing model, for relighting
- **Adds tabs:** Color Palette, Relight
- **Creates tables:** `color_palettes`, `lighting_presets`, `lighting_preset_previews`
- **Full page:** [modules/colour/README.md](modules/colour/README.md)

### `audio` — Score & voice

Generate a music cue for a scene, and replace a voice on a finished clip while keeping the music and the sync.

- **Modules first:** `core`
- **ComfyUI node packs:** none
- **Models:**
  - a music model and its audio VAE
  - a speech model
- **Adds tabs:** Score, Post Voice
- **Creates tables:** `scores`, `score_styles`, `voice_replacements`
- **Full page:** [modules/audio/README.md](modules/audio/README.md)

### `delivery` — Editorial hand-off

Send the finished clips to an editor as a project in screenplay order, rather than as a folder of files.

- **Modules first:** `core`, `video`
- **ComfyUI node packs:** none
- **Models:** none
- **Adds tabs:** DaVinci Resolve
- **Full page:** [modules/delivery/README.md](modules/delivery/README.md)

### `tools` — Housekeeping

Copy a project, delete a project or a single asset, and watch what the render host is doing.

- **Modules first:** `core`, `screenplay`
- **ComfyUI node packs:** none
- **Models:** none
- **Adds tabs:** Tools
- **Full page:** [modules/tools/README.md](modules/tools/README.md)

### `orchestration` — Run it end to end

One trigger that walks a scope of the script and runs each stage in order, instead of pressing the buttons by hand.

- **Modules first:** `core`, `screenplay`, `characters`, `world`
- **ComfyUI node packs:** none
- **Models:** none
- **Full page:** [modules/orchestration/README.md](modules/orchestration/README.md)

### `library` — Reference library (optional)

A searchable store of source text - a novel, a treatment, research - that location and character descriptions can fall back on when the script itself is thin.

- **Modules first:** `core`
- **ComfyUI node packs:** none
- **Models:**
  - an embedding model, served by the text host
- **Postgres extensions:** `vector`
- **Creates tables:** `book_chunks`
- **Full page:** [modules/library/README.md](modules/library/README.md)

## Install order

Dependencies first. One order that satisfies every module:

```powershell
.\core\03-core.ps1
.\install-module.ps1 -Module screenplay
.\install-module.ps1 -Module characters
.\install-module.ps1 -Module imaging
.\install-module.ps1 -Module world
.\install-module.ps1 -Module director
.\install-module.ps1 -Module video
.\install-module.ps1 -Module faceqa
.\install-module.ps1 -Module colour
.\install-module.ps1 -Module audio
.\install-module.ps1 -Module delivery
.\install-module.ps1 -Module tools
.\install-module.ps1 -Module orchestration
.\install-module.ps1 -Module library
.\install-module.ps1 -Module camera
```

You do not need all of them. Install the modules whose features you want; the installer
refuses anything whose dependencies are missing and tells you what to install first.
