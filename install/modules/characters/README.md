# Characters & props

Every person and object that has to look the same in every shot: reference sheets,
wardrobe, and the identity references the image and video models are given.

## What you get

Two tabs.

### Characters

The cast list. Each character carries the written descriptions every later render reads,
an optional LoRA, and a versioned gallery of reference images.

- Add form — name, stored upper case, and an optional gender, with duplicate detection.
- **Load characters from bible** — reconciles the cast against the newest uploaded
  character-bible document and reports created, updated and skipped counts.
- *Ask for characters* — a chat agent that reads the screenplay and the current cast and
  proposes a full bible; accepting it writes the document and immediately re-runs the
  import.
- Per character: an **Is a** picker (person, animal, creature, robot, object), a **Drawn
  as** picker (photographic, anime, cartoon, 3D animated) and a *face is covered*
  checkbox that changes how Face QA judges a clip.
- Editable **Look** and **Clothing** descriptions; saving marks them manual so the
  importer will not overwrite them.
- A LoRA picker with model-strength and clip-strength numbers.
- **Generate images** and **Regenerate as version N** — a regeneration lands as a new
  version beside the old one rather than replacing it.
- **Create QA shots** renders the specific angles Face QA needs; **Generate reference
  sheet** renders one tall multi-view sheet for human reference.
- **Add your own** — a multi-file upload; uploads become their own version.
- Version blocks with source and count badges, a thumbnail grid, a full-size lightbox,
  per-image delete and **Delete version**, which also removes the underlying files while
  keeping any file another row still uses.

### Props & Wardrobe

The catalogue of objects and costumes that are neither characters nor locations, each with
a reference sheet so it stops being reinvented shot to shot.

- **Find props in the script** — reads the project's beats and proposes props and costumes
  with a description, a stated physical scale and the alternate names the script uses.
- Proposal review cards with editable *Looks like*, *Scale* and *Also called* fields, a
  **Drop** per item, then save or discard. Matching is on name and aliases, so re-running
  updates rather than duplicates.
- An *Add one* manual form: name, kind (prop or wardrobe), description and scale.
- A project-wide **Style** picker, defaulted from the cast's render style, plus a per-item
  **Drawn as** override.
- Separate **Props** and **Wardrobe** listings with inline-editable description, scale and
  alias fields that save on blur, and a **Worn by** character picker on wardrobe items.
- **Render sheet** / **Redo sheet** — renders a multi-view reference sheet for the item and
  stores it as that item's picture.
- **Describe from the sheet** — a vision pass that proposes a description and scale from
  the picture, for approval before it is kept.
- *Use an existing picture…* and **Upload a picture** as alternatives to rendering; both
  re-read the description from the new picture.
- **Delete** per item.

## What it installs

### Tables

- `characters` — a character: description, wardrobe and identity model settings.
- `character_images` — reference images per character, versioned and tagged by kind.
- `movie_props` — a prop, costume or vehicle, and its reference sheet.

### Flows

- **3-Character-Generator** — turns a name into a character: resolves or creates the row,
  finds the best available description, writes a visual descriptor and renders the
  reference image set. Its source order is bible entry, then uploaded reference photo,
  then the character's introduction beat, then a search over the reference library.
- **12-Character-Bible-Import** — seeds the cast straight from the uploaded character
  bible, accepting either a bracketed-block or a one-paragraph-per-character layout. A
  descriptor that came from a richer source is never overwritten unless forced.
- **23-Character-Bible-Writer** — a conversation that maintains the bible from the
  screenplay and the existing cast. It writes nothing; the result is committed through the
  importer, which is the one path that knows how to reconcile a rewritten bible with
  characters that have already rendered.
- **25-Character-QA-Shots** — renders the head-and-shoulders framings the face recogniser
  needs, from one existing photo, and can render a human-facing multi-view sheet instead.
- **40-Character-Wardrobe** — puts a costume on a character once, producing another
  reference sheet tagged with that costume, so a shot needs one picture for that person
  instead of two and the garment cannot drift. It calls the image-edit flow rather than
  building its own graph.

### ComfyUI node packs

- `comfyui_segment_anything` — subject masking, used when a reference sheet has to be cut
  out rather than rendered clean.

### Models

- `diffusion_models` — the image generator. The character and reference-sheet renders run
  on the FLUX.2 Klein 9B stack, with its own text encoder in `text_encoders` and its VAE
  in `vae`.
- `loras` — per-character identity LoRAs, optional. These are trained locally against the
  project's own subjects and cannot be downloaded; without them the character flows still
  run but produce generic subjects. The node reads the filename from the character record.
- The masking pack expects GroundingDINO and SAM-HQ weights in `grounding-dino` and
  `sams`; they are small, and the flows that use them hard-fail without them.

## Before you install

- **core** — the database, the Flowise instance, the render host and the admin shell.
- **screenplay** — the proposal path reads `beats` to find who is in the film and what
  they are described as, and the bible writer reads the uploaded screenplay document. With
  no beats there is nothing to propose from.
- Have `comfyui_segment_anything` installed in ComfyUI and restart it first; custom nodes
  register only at startup.
- The Klein image stack is roughly 27 GB on disk. It is the same stack the imaging module
  uses, so installing both does not double the download.

## Install

```powershell
.\install-module.ps1 -Module characters
```

Restart the admin dev server afterwards; the Characters and Props & Wardrobe tabs appear
in the sidebar.

## How it fits

Screenplay supplies the beats this module reads to work out who and what is in the film.
What it produces — descriptors, reference images and costume sheets — is the identity
layer everything visual reads afterwards. Director hands those references to every first
frame it renders and pushes wardrobe choices back into the beats; the video tabs use them
as reference conditioning; Face QA scores a rendered clip against exactly these images,
so a weak reference set shows up later as a bad score rather than a bad picture.

## Removing it

```powershell
.\uninstall-module.ps1 -Module characters
```

The tabs and flow ids go; `characters`, `character_images` and `movie_props` stay, so the
cast and its renders survive. Add `-DropTables` to drop them and everything in them —
irreversible, and refused while an installed module that depends on this one is still
present.
