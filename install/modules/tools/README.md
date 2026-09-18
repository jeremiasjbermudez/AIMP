# Housekeeping

Copy a project, delete a project or a single asset, and watch what the render host is doing.

> **Note.** This module registers no flows of its own. The Tools tab drives
> `42-Shot-Breakdown` and `43-Import-Breakdown`, both installed by the `screenplay` module,
> which is why `screenplay` is a dependency.


## What you get

**Tools** (`tools`) — utilities that sit beside the pipeline rather than in it. They read
something you already have and hand back text; nothing here writes to a movie unless you
explicitly send it.

- *Shot breakdown* — a path field for a video file on the machine the flows run on, plus a
  **Choose file** button that opens that machine's real file dialog, because a browser file
  input cannot supply a path.
- **From** and **to** fields to limit the breakdown to part of a film, given in seconds, mm:ss
  or hh:mm:ss.
- A **Cut sensitivity** number deciding how different two frames must be to count as a cut.
- A *Describe each shot* checkbox (one vision call per shot) and a *Transcribe* checkbox with a
  model-size picker that trades speed against accuracy on overlapping speech.
- **Break it down** — finds every cut, pulls the first frame of each shot and describes it, then
  reports the shot count, the runtime, the output folder, and a table of shots with timecode,
  held duration, size, who is in frame, the composition and the words spoken over it. **Open the
  folder** reveals the output in the file explorer.
- *Screenplay* — **Choose breakdown…** (or the one just produced), an optional cast-hints field
  mapping names to visual descriptions, and **Build screenplay**, which groups shots into scenes
  by place and into beats by where the talking starts and stops. The last-used breakdown path
  and cast hints are remembered in the browser.
- **Download screenplay** saves the returned text locally; **Send to _movie_** imports its beats
  plus a director plan carrying that film's coverage, cut for cut, into the selected movie.
- A table of the resulting scenes with their headings, beat counts and line counts.

The breakdown and screenplay features call flows registered by the director and screenplay
modules, so install those too if you want that half of the tab to work. The flows this module
registers are the ones behind the project buttons in the app header and the delete buttons
throughout the rest of the app.

## What it installs

**Tables**

None. The breakdown writes files, not rows, and the flows below either delete or copy rows that
other modules own.

**Flows**

- `41-Copy-Movie` (`_copy_movie_node.js`) — the same film again in a different medium. It copies
  the words — story, scenes, cast, props, wardrobe, shot list, staging — and deliberately leaves
  the pictures behind, because the render style is what every prompt is built on top of and a
  sheet in the old style would be the wrong reference in the new one. Prompts are not copied
  either: they are derived, so copying what they are built from brings them back by themselves.
  The copy is never made active, so it cannot silently redirect work away from what is being
  made.
- `15-Delete-Movie` (`_delete_movie_node.js`) — deletes a project and everything belonging to
  it: the database rows, the storage bucket, and the render host's input and output folders
  named after its slug. It runs as a dry-run survey by default and only deletes when the exact
  title is typed back, because there is no undo. Folder removal is guarded so the path must
  resolve inside the render root and its basename must equal the slug.
- `29-Delete-Asset` (`_delete_asset_node.js`) — deletes rendered files from the render host's
  folders, which the browser cannot do itself. Two rules are non-negotiable: a path must resolve
  inside the host's own output or input folder, and a file still referenced by another row is
  kept and reported with the reason. A table that cannot be read counts as a reference — keeping
  a file is recoverable, deleting a live one is not. Capped at 50 paths per request.

**ComfyUI node packs**

None.

**Models**

None of its own. Describing and transcribing shots in the breakdown uses the local language and
vision models the core install already provides; nothing here is downloaded per module.

## Before you install

- **core** — the database, the Flowise instance, the render host whose folders these flows clean
  up, and the admin shell the panel mounts into.

No node packs and no model downloads, so disk and VRAM are not a concern. Two things to have in
place first if you want everything on the tab: the director and screenplay modules, whose flows
the breakdown and the import into a movie call, and filesystem access for the flow host — the
deletion flows probe for it rather than assuming it, and degrade to database-and-storage-only
when Node's filesystem builtins are not allowlisted in the sandbox.

## Install

```powershell
.\install-module.ps1 -Module tools
```

Restart the dev server afterwards; the Tools tab appears.

## How it fits

This module sits beside the pipeline rather than in it. The breakdown half runs backwards — it
takes a finished film and produces beats and a shot list, which is an alternative way to fill
the tables the screenplay and director modules own. The housekeeping half runs across
everything: copying a project seeds a new one from an existing script, and the two deletion
flows are what the rest of the app calls whenever a project or a rendered file has to actually
leave the disk.

## Removing it

```powershell
.\uninstall-module.ps1 -Module tools
```

The tab goes. This module creates no tables of its own, so `-DropTables` has nothing to drop.
Removing it does not delete anything the flows produced; it only takes away the means of doing
so from the interface.
