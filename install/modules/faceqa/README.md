# Face QA & repair

Score a rendered clip against a character's references to find identity drift, and repaint a
face in place when it has drifted.

## What you get

**Face QA** (`faceqa`) — measurement first, then the repair that follows from the measurement.

- A clip thumbnail picker with inline playback, and a character picker ("who should be in it")
  whose reference images are the yardstick.
- *Sampling* — **Every Nth frame** and **Max frames** numbers, then **Score this clip**.
- A verdict banded against calibrated thresholds, reporting worst, mean and best similarity, how
  many frames were scanned and how many were rejected, which references were used, and which
  were skipped and why.
- A gallery of the worst frames shown beside the reference images, so the number can be checked
  against the evidence rather than taken on trust.
- For a character marked as never seen unmasked, likeness is not scored at all; the check
  becomes whether the covering stayed on.
- A *What next* section that works out the action from where the clean frames are: nothing to
  do, **Retake from frame N** (continuing from the last frame with enough clean frames behind
  it), or fix the first frame and render again when there is no anchor to continue from.
- **Save the first frame** / **Save the anchor frame** — files the frame into the project so it
  can be relit or edited and then used as a first frame on Image to Video.
- **Fix the face on that frame** — repaints only the detected face to match the character.
  Everything outside the mask keeps its original pixels, and no detected face is a deliberate
  no-op rather than a full-frame repaint.
- *Fix a face on any picture* — the same repaint applied to any picture in the movie, without
  scoring anything first.

## What it installs

**Tables**

None. The module reads clips and character references and writes its retake back into the clip
table, so it owns no storage of its own.

**Flows**

- `24-Face-QA` (`_face_qa_node.js`) — scores a clip's face against a character's references.
  Measurement only: it never edits a clip. The headline figure is the worst sampled frame rather
  than the mean, because drift is usually a short stretch. It prefers the purpose-built QA
  reference set when two or more of those exist and falls back to the older close-up and
  portrait kinds otherwise.
- `34-Face-Fix` (`_face_fix_node.js`) — repaints one face in a still to match a character's
  references. Deliberately a still operation: independently corrected frames do not agree with
  each other, so the face is fixed once, on the frame the clip will be re-rendered from.

**ComfyUI node packs**

`comfyui_segment_anything`, `comfyui-videohelpersuite`.

**Models**

A face embedding model (with its detection and recognition set), a detector and a segmenter for
building the mask, and an image editing model to do the inpainting. The face and masking models
are small — a couple of gigabytes between them — but they are loaded by display name rather than
by filename, so each file has to sit at the exact path and name the node pack expects. The
inpainting model is the image editing stack the imaging module also uses.

## Before you install

- **core** — the database, the render host and the admin shell the panel mounts into.
- **characters** — the reference images are the yardstick the score is measured against; without
  a character bible there is nothing to compare a clip to.
- **video** — there is nothing to score until clips exist, and the retake this module queues is
  a row on the clip table that the video module owns.

Have both node packs installed and ComfyUI restarted first. The masking models must be present
before the first repair, because the inpaint graph hard-fails without them; scoring itself runs
in a local worker process rather than through ComfyUI, so it does not compete for the GPU queue.

One caveat worth knowing before you trust a number: the worker averages every reference into a
single centroid, so a weak or off-character reference actively pulls the measurement away from
the character. Check the worst-frame gallery against the references before acting on a score.

## Install

```powershell
.\install-module.ps1 -Module faceqa
```

Restart the dev server afterwards; the Face QA tab appears.

## How it fits

This sits between video generation and everything downstream of it. Clips come in from the video
module and character references from the characters module; what comes out is either a verdict
that the clip is fine, a repaired still to re-render from, or a retake queued straight back into
the clip table. Nothing is graded, voiced or delivered on a clip that has failed here, so it is
the last gate before finishing.

## Removing it

```powershell
.\uninstall-module.ps1 -Module faceqa
```

The tab goes. This module creates no tables of its own, so `-DropTables` has nothing to drop —
scores were never stored, and any repaired stills or retakes it produced stay where they are, on
the tables their own modules own.
