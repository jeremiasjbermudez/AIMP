# Director & shot lists

Turn beats into a shot list, decide what each shot is for and who is in it, and generate
the opening frame of each.

> **Note.** Shot breakdown belongs to the `screenplay` module, not this one: it is driven from
> the Screenplay and Tools tabs, never from the Director tab.


## What you get

Two tabs.

### Director

Turns beats, scenes and cast into an ordered shot list, then produces that list stage by
stage: first frames, an automated review, clips, and a stitched cut. It is the busiest tab
in the app.

- *Scene look* — per scene, editable key light, screen direction and staging fields plus a
  **Panorama drawn as** style picker; all four are read by the prompts built for that
  scene's shots.
- *Plan* — a wanted runtime, **New plan**, a plan picker, **Check what it would plan from**
  (a dry run reporting beats, scenes, cast and a projected runtime breakdown without
  writing anything), **Draft shot list**, and a **Reset** for a stuck call.
- *Shot list* — one table row per shot with a thumbnail, a clip player, the scene, shot
  type, size, characters, length, continuity (continues or fresh), description and status.
  Rows are separated at each scene change.
- Per-row actions: re-render this frame, insert a shot before this one, apply a stored
  correction to a flagged frame, **Render clip**, **Replace Image** to swap in any existing
  project picture as the first frame, and **Export frame** to scrub the clip and save a
  still into the project.
- Per-row collapsible image-prompt and motion-prompt editors, plus a read-only summary of
  where that shot's camera stands.
- A bulk bar that appears when rows are ticked: redo the ticked shots, a *Place them on…*
  picker that assigns one background plate to all of them, and a **Wearing** group with a
  costume dropdown per character that also pushes the choice back into the beats and
  re-renders the dressed character reference.
- An insert-shot form: what happens, who is in it, what it is for, how close, a foreground
  note, and optional first and last frame pickers.
- Repair actions: redo the flagged frames, **Redo until clean** (a repair and re-check loop
  with progress and stop conditions), and add the missing shots the review's gap findings
  identified.
- *Produce* — a shot-range limiter, an acceleration checkbox, and five stage buttons with
  live progress counters: first frames, review frames, clips, speech and frame checks (not
  wired), and assemble. Frame batches run three at a time and resume where they stopped.
  **Stop now** clears and interrupts the render queue; **Stop after this one** only sets the
  loop flag.
- **Render via Context Loop** — an alternative chain that carries the previous scene's
  picture and sound forward.

### Context Loop

An embedded ComfyUI, for evaluating a third-party video workflow pack on its own terms. It
is deliberately wired to nothing: it reads no project, writes no row and triggers no flow,
and the pack's runs land in their own output folder.

- A pack-status check that asks ComfyUI for one of the pack's node types and reports one of
  four states: checking, loaded, installed but not loaded (custom nodes register only at
  startup, so a restart is needed), or ComfyUI not answering.
- **Re-check**, **Reload the view** and **Open in its own window**.
- A collapsible list of the pack's usable entry-point workflows with a one-line note on
  each, where to find them in ComfyUI's own Workflows sidebar, and notes on what to
  expect — the model loaders must be re-pointed at this machine's variants, and each run
  needs a unique run name, because reusing one resumes that run.
- The ComfyUI web interface itself, embedded full-width — the pack's controls are ComfyUI
  nodes, so the graph editor is the interface.

## What it installs

### Tables

- `director_plans` — one version of a shot list.
- `director_shots` — a planned shot: type, characters, framing, its plate, and its render
  state.
- `shots` — the older per-beat shot record, kept for the flows that still read it.

### Flows

- **39-Director** — by far the largest node in the pipeline. It plans a shot list from the
  beats and cast, then drives the stages that produce it, across eight modes: a dry run
  that writes nothing, drafting the plan, translating a plan into a chained render plan,
  queueing one scene of that chain, assembling the rendered segments into a cut, reviewing
  neighbouring shots for continuity, inserting one shot at a position and shifting the
  rest, and rebinding existing shot prompts to the current script, cast and wardrobe. The
  split is deliberate: the model decides what is creative — shot type, who is on screen,
  what happens, which line a shot carries — and the node computes everything with an exact
  format, including clip lengths on the generator's frame grid, line timestamps, the style
  prefix and the validity checks.
- **42-Shot-Breakdown** — detects cuts in an existing video, extracts a frame per shot and
  describes each one, then can group those shots into a screenplay. It shells out to a
  standalone script rather than reimplementing it, so the terminal tool and the tab stay
  one copy. It is what the Tools tab drives and what the Screenplay tab's breakdown import
  consumes.

The Director tab also calls flows owned by other modules: the image-edit flow for every
still, the wardrobe flow for dressed character sheets, and the image-to-video and extend
flows for clips. It talks to the ComfyUI queue and interrupt endpoints directly for
**Stop now**.

### ComfyUI node packs

- `ComfyUI-MiniMaxH3-Context-Loop` — the third-party pack the Context Loop tab embeds and
  the **Render via Context Loop** chain uses. ComfyUI must be restarted after installing it
  before its nodes register.

### Models

- A text model on the Ollama host does the planning, the continuity review, the insert and
  the rebind. Nothing here is a fixed template.
- The video model's reference conditioning, for the Context Loop chain and for the clips
  the produce stages queue. Those weights belong to the video module; this module supplies
  the plan, not the generator.

## Before you install

- **core** — the database, the Flowise instance, the render host and the admin shell.
- **screenplay** — a plan is built from beats and scenes. The dry run's first job is to
  count them, and with none the planner has nothing to plan from.
- **characters** — the planner decides who is on screen per shot and hands each render that
  character's reference images, so it reads the cast and its images. Wardrobe sheets come
  from the same module.
- Install the imaging module before producing anything: every first frame is rendered
  through the image-edit flow. Install the video module before the clips stage, and the
  camera module if you want shots composited onto real plates rather than invented
  locations.
- Install the node pack and restart ComfyUI first. No model download of its own, but the
  produce stages queue long runs of image and video work, so plan the GPU time rather than
  the disk.

## Install

```powershell
.\install-module.ps1 -Module director
```

Restart the admin dev server afterwards; the Director and Context Loop tabs appear in the
sidebar.

## How it fits

This is the middle of the pipeline, where the script becomes a production. Screenplay
supplies the beats and scenes, Characters supplies who is in them and what they look like,
and Camera — which depends on this module rather than the other way round — supplies the
plate each shot is composited onto. What comes out is a shot list with a first frame per
shot, which the video module animates into clips and the delivery module lays on a
timeline in screenplay order.

## Removing it

```powershell
.\uninstall-module.ps1 -Module director
```

The tabs and flow ids go; `director_plans`, `director_shots` and `shots` stay, so the shot
lists and their rendered frames survive. Add `-DropTables` to drop them and everything in
them — irreversible, and refused while the camera module, which reads the plans and writes
each shot's plate path, is still installed.
