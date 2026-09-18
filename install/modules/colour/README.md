# Colour & lighting

Pull a look off a picture and grade toward it, and light a still before it moves so the clip
inherits the lighting.

## What you get

**Color Palette** (`palette`) — a library of looks. A palette is a set of swatches measured off
a picture in the browser plus a grading note written by a vision model; the note is the half
that steers a render.

- *Pull a palette from a picture* — choose any picture in the movie or upload one; the browser
  quantises it into six swatches and the model proposes a name and a grading note.
- A draft card showing the source image and the swatch strip, with an editable name and note,
  **Save palette** and **Discard**.
- *Apply a palette* — a target picker (an image or a clip), the image or clip to grade, the
  palette, and a **Strength** slider shown as a percentage.
- **Apply** — images are graded in the browser instantly; clips go through ffmpeg with a LUT
  built from the same maths, so a graded still and a graded clip agree. Both write a copy and
  never touch the original.
- A graded-results grid with inline image or video preview.
- *Palette library* — cards showing the source picture or a swatch gradient, the swatch strip,
  the name, a "built in" badge on shared palettes and a delete button on your own. Clicking a
  card selects it for grading.

**Relight** (`lighting`) — relighting a still before it moves. A relit first frame handed to
image-to-video keeps its lighting through the clip, which is why only stills are relit here.

- A picture picker over every image in the movie, and **Relight** using the selected setup; it
  relights a copy and leaves the original untouched.
- **Render previews for the library** — relights the chosen picture with every setup that has no
  preview yet, small and one at a time, so the gallery becomes a comparable grid. Setups that
  already have a preview are skipped, which makes the run resumable.
- A results grid with a **Use as preview** button that promotes a result to the library
  thumbnail.
- *Lighting library* — a card grid of setups with thumbnails; click to select, click again to
  clear. Built-in setups are badged and your own have a delete button.
- *Write your own* — a name field, a one-sentence description of the light, and **Save setup**.
- A scope fence (same subjects, poses, clothing and framing) is appended automatically and
  cannot be edited away; the panel shows the full instruction a selected setup will send.

## What it installs

**Tables**

- `color_palettes` — a palette pulled off an image, and the grade derived from it.
- `lighting_presets` — a saved lighting setup.
- `lighting_preset_previews` — rendered previews of those setups.

**Flows**

- `31-Palette-Namer` (`_palette_namer_node.js`) — names a palette and writes its grading note.
  The swatches are measured in the browser and passed in; the model is deliberately not asked
  for hex values, because a vision model reading colours off a picture returns plausible numbers
  that are quietly wrong.
- `32-Apply-LUT` (`_apply_lut_node.js`) — grades a rendered clip with a palette. It builds a 33³
  `.cube` file from the palette's swatches using the same luminance-gradient map the browser
  uses on stills, then runs ffmpeg's `lut3d`: exact, CPU-only, seconds rather than a GPU queue
  slot, and it copies the audio stream untouched.

**ComfyUI node packs**

None.

**Models**

No models of its own. The relight pass runs through the image editing flow, so it uses the image
editing stack — the base model, its text encoder and VAE, and its acceleration LoRA — that the
imaging module already installs. Grading needs no model at all: ffmpeg does the clip, and the
browser does the still.

## Before you install

- **core** — the database, the render host and the admin shell the two panels mount into.
- **imaging** — relighting is performed by the image editing flow that module registers, and
  relit results are written back into its edit table. Without it the Relight tab has nothing to
  call.

Nothing else needs installing first. Grading a clip needs ffmpeg available to the flow host, and
the panel expects the clip table to exist if you want to grade video rather than stills — that
table belongs to the video module, so install that too if you want clip grading. Disk and VRAM
are not a concern here: this module downloads nothing and the only GPU work is the relight,
which borrows a model that is already on disk.

## Install

```powershell
.\install-module.ps1 -Module colour
```

Restart the dev server afterwards; the Color Palette and Relight tabs appear.

## How it fits

This module sits on both sides of video generation. Relight is upstream: it treats a still
before it moves, so the clip inherits the lighting rather than having it applied afterwards.
Grading is downstream: palettes pulled from reference pictures are applied to finished clips and
stills, always as a copy, and the graded clip is what goes on to delivery. The two halves share
one colour function so the preview in the browser and the rendered grade do not drift apart.

## Removing it

```powershell
.\uninstall-module.ps1 -Module colour
```

The tabs go and the tables stay by default, so saved palettes and lighting setups survive and
the tabs are easy to put back. Pass `-DropTables` to remove `color_palettes`,
`lighting_presets` and `lighting_preset_previews` as well.
