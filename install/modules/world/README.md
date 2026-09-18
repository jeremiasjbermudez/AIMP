# Locations & 3D worlds

A 360-degree panorama of a location, and the navigable Gaussian-splat world built from it,
which is what cameras are later placed inside.

## What you get

Two tabs.

### Panoramas & Worlds

Per scene, a 360° panorama and the 3D Gaussian-splat world trained from it. The panorama
is the prerequisite for the world; the world is what the Camera tab places cameras in.

- One card per scene with its current panorama preview and badges showing where the
  panorama came from and whether a splat is ready.
- *Describe from an image…* — a vision pass that looks at any picture in the project and
  writes a panorama description into the box below.
- A per-scene description box. Leaving it empty derives the description from the scene
  prose; on first focus it is pre-seeded with the framing the generator requires.
- **Generate panorama** / **Regenerate**, **Delete panorama**, and **Use my own image** to
  upload a panorama instead of generating one.
- **View panorama** and **View splat** open interactive viewers, and a snapshot taken in
  either is saved back into the project as a picture usable in every image picker.
- **Build world**, **Rebuild world** and **Continue training**, with a *Continue from
  checkpoint* box that keeps the coordinate frame — so floor plans and shot cameras still
  hold — and backs the current file up first. **Delete splat** removes the world and its
  file.
- A **World detail** preset picker (fast, standard, detailed, exhaustive) noting what each
  trades and roughly how long it takes, plus an *Advanced* section overriding anchor scans,
  maximum trajectories and training steps individually.
- A *Splat version* section listing every `.ply` on disk for the scene with its date, size,
  workspace and whether it is in use, plus **Use this one** to repoint the scene and its
  floor plan, and **Rescan**.

### HY-World

A separate world-generation pipeline that takes text, one image, several photos or a video
and produces a navigable 3D world. It generates its own panorama internally and is wired
to nothing else in the app.

- A **Build from** picker with four input modes: text, an image, several photos, or a
  video.
- A **Name** field, required in every mode, and a description box for the text and
  single-image modes.
- Image mode: pick any picture already in the project, or upload one.
- Several-photos mode: add pictures one at a time or upload several at once, shown as an
  ordered grid with a **Remove** per view; at least two photos of the same place are
  required.
- Video mode: a thumbnail picker over the project's finished clips, with a note that a
  moving shot reconstructs far better than a locked-off one.
- **Build the world**, with a blocked-reason line naming whatever is still missing and a
  status line describing the stage in progress.
- A worlds list showing name, input-mode and status badges, the generated panorama
  preview, the output file path and any error.
- Per world: **View splat**, **View panorama** — both with snapshot-to-project — and
  **Remove**, which drops the row but leaves the large files on disk.

## What it installs

### Tables

- `scene_panos` — the 360° panorama for a scene.
- `scene_splats` — the trained 3D world for a scene: workspace name, splat file and backup.
- `hyworlds` — a standalone 3D world not tied to a scene.
- `prompt_worlds` — a world generated from a description alone.

### Flows

- **4-Panoramic-Generator** — renders a 360° equirectangular panorama for a scene,
  composed from that scene's own heading, location description, atmosphere and set
  dressing. It also accepts a panorama uploaded by hand instead of generating one.
- **5-3DGS-World-Builder** — builds the navigable splat for a scene from its panorama,
  running the trajectory, memory-bank, expansion, reconstruction and training chain. A
  forced rebuild backs the existing file up first and aborts if the backup does not
  complete.
- **6-GS-Cleaner** — the per-shot plate cleanup that writes a cleaned image back onto a
  shot row. Superseded: the panel that drove it is no longer mounted, and the plate step
  now runs through the Camera tab.
- **38-HY-World** — a navigable world from text, an image, several photos or a video. Text
  and image run the full five-stage pipeline; video and multi-view go straight into
  reconstruction, which predicts its own cameras, so that path has no panorama and no
  training run.
- **37-Prompt-World** — a world from a prompt alone, with no scene behind it. It is
  invoked directly rather than from a tab, and writes to its own table because the
  scene-splat table's uniqueness constraint leaves a scene-less world nowhere to sit.
- **27-Pano-Prompt-From-Image** — looks at a picture and writes text from it: a panorama
  prompt describing the location, or, in its other mode, a prop description with a scale
  note. It writes nothing; the operator edits the result before it drives anything.

### ComfyUI node packs

- `ComfyUI_HYWorld2` — the world-generation nodes and their model loaders.
- `panorama-stickers` — panorama handling.
- `comfyui-gsplat-room-viewer` — splat viewing.
- `comfyui-rename-file` and `comfyui-various` — the file handling the build chain uses
  between stages.

### Models

- The panorama generator — the FLUX.2 Klein stack with a 360° equirectangular outpaint
  adapter, plus a Qwen-Image-Edit base and panorama adapter for the HY-World panorama
  stage.
- **WorldStereo Light**, in its int4-quantised form, is the world-expansion model. Its
  loader selects by dropdown label rather than filename, so the file must sit at the exact
  path the pack expects.
- **WorldMirror** produces depth, normals, camera poses, point cloud and splats in one
  pass, with the same path requirement.
- A vision-language model for scene understanding, referenced by model id from the builder
  node, plus the text encoder and VAE the expansion stage loads implicitly.

## Before you install

- **core** — the database, the Flowise instance, the render host and the admin shell.
- **screenplay** — the panorama is generated per scene, from that scene's prose. With no
  scene rows there is nothing to generate a panorama for.
- **library** is optional. With it installed, a thin location description can fall back on
  the searchable source text instead of on the scene heading alone.
- Install the node packs above and restart ComfyUI before the first build; custom nodes
  register only at startup, and a missing pack fails the graph rather than degrading it.
- The world models are around 28 GB, or 37 GB with the alternative expansion variant. The
  full-size, unquantised expansion weights need more than 40 GB of VRAM; on a 32 GB card
  the Light models are the realistic ceiling, and the image stack and the world stack
  cannot be resident together. A world build is measured in tens of minutes, not seconds.

## Install

```powershell
.\install-module.ps1 -Module world
```

Restart the admin dev server afterwards; the Panoramas & Worlds and HY-World tabs appear
in the sidebar.

## How it fits

Screenplay supplies the scene rows and the prose each panorama is composed from. A
panorama is generated per scene, the splat is trained from that panorama, and the result
is what Camera places every shot's camera inside and renders plates from. Those plates
become the backgrounds Director composites the cast onto, so a rebuilt world changes every
plate in that scene. The HY-World tab sits beside all of this rather than in it: it is a
second world pipeline, wired to nothing downstream.

## Removing it

```powershell
.\uninstall-module.ps1 -Module world
```

The tabs and flow ids go; `scene_panos`, `scene_splats`, `hyworlds` and `prompt_worlds`
stay, so the panoramas and the references to the trained worlds survive. Add `-DropTables`
to drop them and everything in them — irreversible, and refused while the camera module is
still installed. Dropping the rows does not delete the `.ply` files on disk.
