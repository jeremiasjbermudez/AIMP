# Screenplay & structure

Write or import a script, break it into acts, scenes and beats, and keep that structure
editable. Everything downstream hangs off these rows.

> **Note.** This module also registers `42-Shot-Breakdown`, which the Screenplay tab and the
> Tools tab both call.


## What you get

Three tabs.

### Screenplay

The writing surface. A screenplay is held as a tree of acts, scenes and beats, and every
number is derived from position, so inserting or moving an item renumbers the rest.

- *Have it written for you* — a chat panel that turns a one-line idea into a full
  screenplay and keeps taking revision notes; an accepted draft drops into the breakdown
  box below.
- **Break it down** — paste prose, an outline or a chapter and get acts, scenes and beats
  back.
- **Choose a breakdown…** — imports a shot breakdown produced on the Tools tab as beats
  plus a director plan carrying that film's coverage.
- Buttons to load a screenplay document already uploaded on the Documents tab straight
  into the editor.
- *Book to screenplay* — pick an uploaded document, see it split into chapters with the
  call count shown up front, then **Convert** them one at a time with live progress and a
  **Stop** that keeps whatever has converted.
- Tree editor — per-act, per-scene and per-beat move up/down, add and delete; scene
  heading fields for location and time of day; per-beat action text, one-line summary and
  a dialogue table (character, parenthetical, line).
- **Enhance** on a beat — rewrites that beat's action text through the assist flow.
- **Save** with a dirty indicator; nothing is persisted until saved.
- *Finish* — four ordered buttons: write the screenplay file, build scenes, propose
  characters, locations and props, and start orchestration. The third returns an editable
  proposal that must be reviewed and explicitly saved, or discarded.

### Documents

File storage for the project: screenplays, character bibles, source books and manually
supplied reference images.

- Upload form with a **kind** picker: screenplay, character bible, book, trailer script,
  character reference image, or other.
- When the kind is a character reference image, two extra pickers appear — which character
  it belongs to, and an optional shot kind so the upload can stand in for that generated
  angle.
- File input plus **Upload**; the file goes to the project's storage bucket and a row is
  recorded.
- A table of every document with kind, character and shot-kind badges, filename, size and
  upload time.
- **View** per row — downloads the object and previews it inline, images as images and
  text as text.
- **Delete** per row — removes the storage object and the row, behind a confirm.

### Beats

A read-only browser of the beat rows every downstream stage is built from.

- One card per beat in sequence order showing the beat code, INT/EXT, location, time of
  day and the script line range it covers.
- The beat summary, plus a badge per character in the beat; hovering shows that
  character's blocking.
- Click a card to expand it for objects, characters with blocking, the dialogue list and
  the raw script excerpt.
- **Run** on a beat — sends that beat code to the orchestrator, with an inline
  running/ok/error status line.
- An empty state when the project has no beats yet.

## What it installs

### Tables

- `scenes` — a scene, its location prose, atmosphere, set dressing and ambience.
- `beats` — a story beat: summary, characters present, dialogue, verbatim text, line range
  and ordering index. `beat_code` is a generated column and must never be written.
- `screenplay_chunks` — a long input split for incremental parsing, with each chunk's
  proposal and status.
- `documents` — uploaded source documents such as a screenplay or a character bible.

### Flows

- **1-Beat-Generator** — reads the project's uploaded screenplay, slices out the requested
  act or scene, has a language model segment it into beats and writes them.
- **13-Scene-Import** — rolls the `scenes` table up from the beats already stored, then
  has a language model write the prose fields a scene heading is too thin to supply.
- **14-Screenplay-Assist** — three jobs behind one flow: structure free prose into
  acts/scenes/beats, sharpen one beat, or propose a character bible with location and prop
  descriptions. It writes nothing; every mode returns a proposal for review.
- **22-Screenplay-Writer** — a conversation that produces a whole screenplay, returning the
  full document each turn rather than a patch.
- **43-Import-Breakdown** — imports a breakdown produced by the shot-breakdown tool as
  both beats and a director plan carrying the real coverage, cut for cut.

### ComfyUI node packs

None. Nothing in this module touches the render host.

### Models

- A text model served by Ollama, used for parsing and drafting. The generated flows
  default to a Qwen 3.8 chat model from the Ollama registry; the breakdown and
  screenplay-from-shots paths use the non-abliterated model of the same family.
- No ComfyUI weights and no VRAM of its own.

## Before you install

- **core** — supplies the database, the Flowise instance and the admin shell every module
  is installed into, including the `movies` row this module's rows hang off.
- Have an Ollama server reachable and the text model pulled before you use the tab; the
  install itself will succeed without one, but every flow here is a model call.
- Disk and VRAM are not a consideration: this module stores text and calls a remote text
  model.

## Install

```powershell
.\install-module.ps1 -Module screenplay
```

Restart the admin dev server afterwards; the Screenplay, Documents and Beats tabs appear
in the sidebar.

## How it fits

This is the head of the pipeline. A screenplay is written or pasted in, broken into acts,
scenes and beats, and rolled up into scene rows. Characters reads those beats to propose
a cast, World reads each scene's prose to build a panorama, and Director reads beats,
scenes and cast to plan a shot list. Nothing downstream has anything to work on until
beats exist, which is why almost every other module lists this one as a dependency.

## Removing it

```powershell
.\uninstall-module.ps1 -Module screenplay
```

The tabs and flow ids go; the tables stay, so the script survives. Add `-DropTables` to
drop `scenes`, `beats`, `screenplay_chunks` and `documents` and everything in them — that
is irreversible, and the uninstaller will refuse while another installed module still
depends on this one.
