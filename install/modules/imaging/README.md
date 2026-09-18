# Image generation & editing

Compose or correct a still from references and a description. Also the cleanup pass that
turns a rough render into a usable picture.

## What you get

Two tabs.

### Image Edit

Composes a still from reference images you pick — a character, a location, your own
pictures — and a written instruction. Three renderers sit behind one form.

- Engine tabs: a reference-editing model taking up to four references, a faster distilled
  editing model taking up to three, and a generate-only turbo model that takes no
  references and returns an image in a few seconds.
- *Reference images* — add from a grouped gallery of every picture in the project, or from
  a file. Each reference carries a numbered badge, because the instruction refers to them
  by position, with up/down reordering and **Remove**.
- An instruction box describing what to make.
- A **Size** picker with five presets plus **Custom…**, where width and height are snapped
  to multiples of 16, a **Steps** number, a **Palette** picker that appends a grading note,
  and a **LoRAs** picker.
- **Generate** renders once. **Generate and review** renders, checks the result against its
  own instruction, and re-renders up to twice if something asked for is missing.
- A results grid with timestamp, status, dimensions, LoRA badges, the image, the
  instruction, which references were used and any verdict text.
- Per-result actions: **Load settings**, which restores instruction, size, steps and LoRAs
  into the form; relight; face fix; grade; **Evaluate and redo**; and **Delete**.

### Qwen Cleanup

A two-image edit that corrects a source image against a clean reference. It is the same
graph the pipeline runs as its cleanup step, exposed on its own for any image.

- *Source image* — the angle that needs correcting. Pick any picture in the project,
  upload one, or **Capture from splat** to grab it from a scene's 3D world in an
  interactive viewer.
- *Reference* — a radio pair choosing between a scene panorama and your own image, with
  **Capture from panorama** and a dedicated picker for previously saved panorama snapshots.
- A scene picker, used when the reference is a scene panorama.
- Snapshots taken in either viewer are also saved into the project, so the same angle can
  be reused anywhere.
- An editable instruction box with **Reset to pipeline default**, so a standalone run
  behaves identically to the pipeline step unless deliberately changed.
- **Run Qwen Cleanup** and **Refresh**; the job continues server-side if you navigate away.
- A cleanups list with timestamp, status badge, which reference was used, the result image,
  any error, and a **Delete** behind a confirm that also removes the file.

The splat and panorama capture options only have anything to offer once the locations and
3D worlds module has produced a panorama or a world for a scene.

## What it installs

### Tables

- `image_edits` — an image generation or edit, with its references and which engine ran it.
  All three engines write here, tagged by engine.
- `qwen_cleanups` — a correct-this-render job and its result.

### Flows

- **26-Image-Edit** — the general image renderer: a prompt plus labelled reference images
  chained as reference latents, so a prompt can say "the person from the first image, in
  the location from the second". Reference order is preserved end to end. Several other
  flows call this one rather than building their own graph, and it writes an audit row
  recording exactly what was sent.
- **28-Qwen-Image-Edit** — the same idea rendered by a different model, kept as its own
  flow because the two graphs share nothing but the staging and polling.
- **10-Qwen-Cleanup** — cleans a rendered image, typically a raw camera capture out of a
  splat, into a usable plate, guided by a reference image and a scene panorama. Every
  parameter lives on the job row; the flow executes it.
- **36-Z-Image** — generation only, with LoRAs, deliberately not an editor. The reference
  path on this model needs a checkpoint that has not been released, so the tab hides the
  reference picker for this engine rather than offering something that breaks.
- **44-Image-Check** — asks a vision model whether a rendered picture shows what the prompt
  asked for. It is not a judge of quality. A check that could not run reports "unknown"
  rather than "failed", so a broken check is never read as a broken picture.

### ComfyUI node packs

None. All five flows build graphs from stock nodes.

### Models

- `diffusion_models` — the editing model. The cleanup and distilled-edit paths run on
  Qwen-Image-Edit; the reference-editing engine runs on the FLUX.2 Klein 9B stack; the
  turbo engine runs on Z-Image Turbo.
- `vae` and `text_encoders` — each stack's own encoder and VAE. The Qwen encoder and VAE
  live in nested folders and the loaders will not find them anywhere else.
- `loras` — the four-step distillation adapters that make cleanup and editing fast, plus
  a detail adapter offered in the form.
- A vision model on the Ollama host backs the review pass.

## Before you install

- **core** — the database, the Flowise instance, the render host and the admin shell. That
  is the only hard dependency: this module does not read the script.
- Nothing here reads beats or scenes, so it can be installed and used on its own. The
  Qwen Cleanup tab's splat and panorama captures do need the world module, and the palette
  picker in the edit form only lists anything once the colour module exists.
- This is the heaviest module on disk. The Qwen-Image-Edit stack alone is around 104 GB
  with both bases, the shared encoder and VAE, the all-in-one checkpoint and its adapters;
  Klein adds about 27 GB and Z-Image about 19 GB. If disk is tight, the newer Qwen base
  plus its encoder and VAE covers the cleanup path, and the other two engines can be added
  later.
- On a 32 GB card the image stack and the 3D world stack cannot be resident together;
  switching between them costs a full model reload, so plan them as separate passes.

## Install

```powershell
.\install-module.ps1 -Module imaging
```

Restart the admin dev server afterwards; the Image Edit and Qwen Cleanup tabs appear in
the sidebar.

## How it fits

This module is the still-image engine the rest of the pipeline borrows. Characters calls
it to render reference sheets and dressed costume sheets, Director calls it for every
first frame in a shot list, Camera calls it to clean a plate, and the colour module calls
it to relight a picture. On its own it needs nothing but a reference image and an
instruction; what it produces is a picture in the project's catalogue, which every image
picker in the app then lists, including the first-frame pickers on the video tabs.

## Removing it

```powershell
.\uninstall-module.ps1 -Module imaging
```

The tabs and flow ids go; `image_edits` and `qwen_cleanups` stay, so the renders survive.
Add `-DropTables` to drop them and everything in them — irreversible, and refused while a
module that depends on this one is still installed.
