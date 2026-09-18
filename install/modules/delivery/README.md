# Editorial hand-off

Send the finished clips to an editor as a project in screenplay order, rather than as a folder
of files.

## What you get

**DaVinci Resolve** (`resolve`) — sends the movie's finished clips to the editor as a new
project, laid on a timeline in screenplay order rather than render order.

- **Check Resolve** — reports the product, the currently open project and whether scripting is
  reachable, with a reminder that external scripting must be enabled in the editor's own
  preferences before anything here will work.
- A summary of what will be sent: how many finished clips there are, and how many of those have
  a post-voice version, since the re-voiced file is used in place of the original.
- A project-name field and a *Build a timeline as well as importing* checkbox. An existing
  project of the same name is never overwritten — a number is appended instead.
- **Send to Resolve**, with a result card reporting the project name, whether it was renamed,
  how many clips imported, whether a timeline was built, whether beat order was used, and any
  files that were missing on disk.
- *What can it do?* — a searchable index of the editor's scripting methods, and this project's
  live settings with their current values.
- *Ask Resolve* — a plain-English chat scoped to that scripting API. Anything that deletes,
  closes or overwrites is refused until approved in words, and each step it takes is listed
  under the reply as a pass/fail badge. **Send** and **Clear**.

## What it installs

**Tables**

None. This module only reads: the clips, the beats they belong to and any voice replacements. It
produces a project in the editor, not rows in the database.

**Flows**

- `20-Resolve-Deliver` (`_resolve_node.js`) — three actions on one flow: report status, search
  the capabilities index, or deliver. Delivery sorts clips by their beat's sequence index and
  substitutes a re-voiced output wherever one exists, then shells out to a worker pinned to the
  Python interpreter the editor ships with — its scripting library crashes the process on any
  other. The clip list travels via a temporary JSON file because it is far too long for a shell
  argument.
- `21-Resolve-Chat` (`_resolve_chat_node.js`) — an agent loop that drives the editor through a
  fixed set of verbs. Two deliberate constraints: the model never sees or invents a file path,
  working in beat codes that the node resolves to files, and every tool returns the real
  resulting state — what is in the pool, what is on the timeline — so the model corrects itself
  instead of drifting.

**ComfyUI node packs**

None.

**Models**

None of its own. The chat runs against a local language model that the core install already
provides; there is nothing to download for this module.

## Before you install

- **core** — the database, the Flowise instance and the admin shell the panel mounts into.
- **video** — there is nothing to deliver until clips exist, and the finished-clip records are
  what the hand-off reads.

Beyond those, DaVinci Resolve itself must be installed on the machine the flows run on, with
external scripting enabled in its preferences; **Check Resolve** exists so you can confirm that
before spending a delivery. Beat order comes from the screenplay module's beats, so without it
clips still import but fall back on their own ordering. Audio's voice replacements are used
automatically if that module is installed and has produced any. No models, no node packs, no
meaningful disk or VRAM cost.

## Install

```powershell
.\install-module.ps1 -Module delivery
```

Restart the dev server afterwards; the DaVinci Resolve tab appears.

## How it fits

This is the last step. Finished clips come from the video module, their order comes from the
beats the screenplay module created, and any re-voiced versions come from audio; grading, if
used, has already written its graded copies. Nothing feeds off this module — its output is a
project in a real editor, which is where the work leaves the pipeline and becomes an edit.

## Removing it

```powershell
.\uninstall-module.ps1 -Module delivery
```

The tab goes. This module creates no tables of its own, so `-DropTables` has nothing to drop,
and any project already sent to the editor is untouched by removing it.
