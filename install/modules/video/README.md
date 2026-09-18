# Video generation

Every route from a still or a description to a moving clip with sound: from a frame, from text,
from references, from an existing clip, or driven by a depth or pose video.

## What you get

Five tabs, all served by the same video panel. The controls below are shared by all five; the
inputs and a few options differ, and those differences are listed per tab afterwards.

**Shared controls (all five tabs)**

- *Beat* — a scene picker and a beat picker, with the beat summary shown underneath.
- *Prompt* — **Fill from beat** composes a description from the beat and scene fields;
  **Enhance prompt** rewrites the box through the prompt-enhancer flow.
- *LLM system prompt* — a per-tab instruction kept in the browser. When set, every Generate is
  rewritten through it first and the rewrite appears in the prompt box; **Clear system prompt**
  removes it.
- *Camera* — one dropdown per camera axis (move, shot, angle, lens, look) drawn from the movie's
  camera presets, a live preview of the composed camera line, a **Clear** button, and a
  free-text motion request passed to the enhancer.
- *Output* — a resolution picker with four presets plus **Custom…** (snapped to multiples of
  16), a duration in seconds, and a badge showing the frame count at 24 fps. The duration is
  re-derived from the beat's dialogue or action; typing over it wins until the beat changes.
- **Generate**, with a "Generate needs: …" line naming whatever input is still missing, and
  **Refresh**. Renders continue server-side if you navigate away.
- *Generations* — cards showing mode, status, dimensions, frame count and the prompt, with
  inline playback. Each offers **Extend this clip** (a frame scrubber that anchors the
  continuation, plus **Save frame to references** and **Use last frame**), **Grade** (palette
  chips and a strength slider, writing a graded copy), **Load settings into form**, and **Delete
  clip** behind a confirm that reports what else the deletion affects.

**Image to Video** (`i2v`) — animates from a first frame, optionally interpolating to a last one.

- A radio pair: first image only, or first and last image.
- A file input plus an "or pick from this movie…" gallery picker for each of the first and last
  frame, with a thumbnail preview and **Clear**.
- Offers the acceleration checkbox. Camera axes are limited to movement and look, because the
  supplied frame has already fixed the framing, angle and lens.

**Text to Video** (`t2v`) — generates from the prompt alone.

- No image, reference or clip inputs; the prompt and camera settings are the whole brief.
- The only tab offering all five camera axes, because nothing else has fixed the framing. It
  also offers the acceleration checkbox.

**Ref to Video** (`shots`) — generates from reference images you pick, so a character or a look
carries in.

- A pool of reference pictures for the movie. Clicking thumbnails picks them in order, and that
  order is what the model receives; clicking again drops one. Only the first nine are used.
- Add to the pool from a file, or from the grouped gallery of every picture in the movie. Each
  pooled thumbnail has a zoom badge and a remove badge that deletes the row and the object.
- A count line stating how many are picked, or that at least one is needed. No acceleration
  checkbox; camera axes are limited to movement and look.

**Video to Video** (`v2v`) — restyles or re-casts an existing clip, keeping its performance.

- *Clip to transform* — a thumbnail picker over the movie's finished clips; selecting one
  auto-matches its resolution and duration.
- The same reference-image pool as Ref to Video, used here to decide what the clip becomes.
- Only the "look" camera axis is offered, and no acceleration checkbox. The generations list
  shows transformed clips only.

**Control to Video** (`control`) — drives a shot with a depth, pose or edge video: layout and
motion come from the control pass, the look from the model.

- *Control video* — a file input accepting common video formats. The browser probes the file and
  reports its frame count at 24 fps and the longest shot it can drive.
- A **Pass** picker: depth, pose (skeleton), canny edges, HED soft edges or MLSD lines, and a
  **Strength** slider (0–1.5) governing how tightly the pass is followed.
- A length rule: the render refuses if the control video is shorter than the minimum shot
  length, and the duration is clamped to what the video can cover.
- The reference-image pool is available but optional. Only the "look" axis, no acceleration.

## What it installs

**Tables**

- `minimax_clips` — a video generation: mode, references, size, length, status and output path.

**Flows**

- `9-MiniMax-Text-To-Video` (`_minimax_av_node.js`) — renders from a first and optional last
  frame, or from the prompt alone; one node body serves both routes.
- `17-MiniMax-Ref-To-Video` (`_minimax_ref_node.js`) — renders from the picked reference images.
- `35-MiniMax-Video-to-Video` (`_minimax_v2v_node.js`) — restyles or re-casts an existing clip.
- `46-MiniMax-Control-To-Video` (`_minimax_control_node.js`) — renders against a control video,
  with a control-net union checkpoint patched into the model.
- `16-MiniMax-Extend` (`_minimax_extend_node.js`) — extends a clip, carrying both picture and
  soundtrack forward so there is no audio seam at the join.
- `11-MiniMax-Prompt-Enhancer` (`_prompt_enhancer_node.js`) — turns a motion request, a draft
  prompt and/or a first frame into a finished prompt, failing rather than dropping dialogue.

**ComfyUI node packs**

`comfyui-videohelpersuite`, `comfyui-kjnodes`, `ComfyUI-Spectrum-MiniMax-H3`,
`ComfyUI-H3-FunControl`, `ComfyUI-H3-Motion-Context-MultiRef`.

**Models**

Both video base checkpoints — one for frame- and text-driven generation, one for
reference-driven, video-to-video and control work, separate checkpoints rather than adapters on
one another — plus the shared text encoder, the video VAE, the audio VAE (which must stay fp32),
the step-reduction LoRA, and the control-net union checkpoint for Control to Video.

## Before you install

- **core** — supplies the database, the Flowise instance, the render host and the admin shell
  that this module's panel is mounted into.

Install the five node packs and restart ComfyUI before the first render: custom nodes register
only at startup, so a pack dropped into a running instance still reports as missing. The
control-net checkpoint is only needed for Control to Video, and the pack that loads it rejects
the original full-width release, so use the re-derived pruned one.

This is by far the heaviest module in the system: about 64 GB of models, with the two base
checkpoints roughly 20 GB each. Expect a full model reload when switching between video and
image work — the two stacks will not sit in VRAM together on a 32 GB card.

## Install

```powershell
.\install-module.ps1 -Module video
```

Restart the dev server afterwards; all five video tabs appear together.

## How it fits

This is the output stage. Stills arrive from image generation and editing, relighting, panoramas
or rendered camera plates and become clips; beats and camera presets supply the prompt and the
framing, and character reference images supply the identity. What it produces feeds face QA for
drift checking, colour for grading, audio for voice replacement, and delivery for the hand-off.

## Removing it

```powershell
.\uninstall-module.ps1 -Module video
```

The tabs go and the tables stay, so the clip records survive. Pass `-DropTables` to drop
`minimax_clips` as well. The faceqa and delivery modules depend on this one and must go first.
