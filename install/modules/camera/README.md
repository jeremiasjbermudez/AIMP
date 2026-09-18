# Cameras & plates

Place a camera inside a built world by intent rather than coordinates, render the plate it
sees, and sharpen the world at that angle.

## What you get

One tab.

### Camera

The tech recce. Where every camera in one scene stands inside that scene's 3D world, shown
as a grid of plates so coverage can be judged side by side rather than down a list.

- A **Shot list** picker, each plan labelled with its date, its shot count in this scene
  and its status, and a **Scene** picker.
- **Survey the room** / **Re-survey** — sweeps the scene's Gaussian splat, measures wall
  distances at every bearing and computes a room radius, so camera distances can be stored
  as fractions of the room and survive a rebuild.
- A grid of survey views; click one to name what it looks at, from suggested names or free
  text. Those landmark names are what every camera in the scene points at.
- **Seed cameras for every shot** — gives each shot in the plan a starting camera derived
  from the named landmarks.
- **Render every plate** — renders the background plate for all cameras in the plan.
- A coverage grid with one card per shot, showing the shot number, the shot type, who is
  on screen, and a camera widget.
- Camera widget sliders for orbit, dolly, elevation, pedestal, tilt, pan and zoom, with a
  **Bigger** / **Done framing** full-window mode; every change re-renders that shot's
  plate.
- A collapsible *Numbers* section: the looking-at landmark, the standing-toward landmark,
  which side of the line the camera is on, distance and sideways offset as fractions of the
  room radius, camera height, aim height, aim sideways and lens angle in degrees.
- **Clean up** — repairs the plate with either the splat cleanup engine or the freer
  image-edit engine, with a short instruction field and a **Back to raw plate** undo.
- **Sharpen this angle** — retrains the scene's world around this camera. It sits behind a
  confirm, because it takes roughly half an hour and every shot in the scene then renders
  from the new build.
- Rendering a plate points the shot at it as its background, so the next frame redo
  composites the cast onto that angle.

## What it installs

### Tables

- `scene_floor_plans` — the measured geometry of a world: centre, up axis, facing, radius
  and named landmarks.
- `shot_cameras` — a camera stored as intent — which landmark to look at, from where, how
  far, how high — rather than as coordinates.
- `camera_plates` — a plate rendered from a resolved camera, together with the pose it
  resolved to.
- `camera_presets` — the reusable camera vocabulary the video tabs' camera dropdowns are
  drawn from.

### Flows

- **45-Splat-Camera** — the whole tab behind one flow, with six modes: *survey* sweeps the
  splat and measures the room, *landmarks* records the names given to the survey views,
  *seed* places a starting camera for every shot in a plan, *render* renders one plate or
  all of them, *plys* lists the splat files on disk for a project, and *sharpen* writes a
  camera path through a shot and renders it so the world builder has something new to
  expand from. It is a thin wrapper around two Python scripts, because the work needs torch
  and gsplat, which the Flowise sandbox does not have, and it runs with no timeout on
  purpose — a survey loads a large splat and renders many views.

The tab also calls flows owned by other modules: the world builder for **Sharpen this
angle**, and either the cleanup flow or the image-edit flow for **Clean up**.

### ComfyUI node packs

- `ComfyUI_HYWorld2` — the same pack the world module needs, because sharpening an angle
  re-enters the world-building chain.

### Models

None of its own. Plates are rendered directly from a trained splat by the Python tool, not
by a diffusion graph. The plate cleanup step borrows the imaging module's editing model,
and sharpening an angle borrows the world module's expansion and reconstruction models.

## Before you install

- **core** — the database, the Flowise instance, the render host and the admin shell.
- **world** — there is nothing to place a camera inside until a scene has a trained splat,
  and the survey measures that splat. Panoramas alone are not enough.
- **director** — cameras are placed per shot, against a shot list. The tab's first control
  is a shot-list picker, and seeding cameras iterates the shots in a plan.
- Practically, you also want the imaging module installed before the first plate: without
  it **Clean up** has no engine to call.
- No new model downloads. VRAM is still a consideration: a survey loads the whole splat,
  and sharpening an angle runs a training pass of roughly half an hour, during which the
  card is busy.

## Install

```powershell
.\install-module.ps1 -Module camera
```

Restart the admin dev server afterwards; the Camera tab appears in the sidebar.

## How it fits

This module sits between the world and the shot list. World supplies the trained splat;
Director supplies the plan and the shots that need covering. The survey turns the splat
into a measured room with named landmarks, each shot gets a camera expressed against those
landmarks, and rendering its plate points the shot at that image as its background. From
there Director's frame renders composite the cast onto a real, consistent angle instead of
inventing a fresh location every time, and the fractions-of-the-room storage means a world
rebuild does not invalidate the coverage.

## Removing it

```powershell
.\uninstall-module.ps1 -Module camera
```

The tab and the flow id go; `scene_floor_plans`, `shot_cameras`, `camera_plates` and
`camera_presets` stay, so the survey and the placed cameras survive and the video tabs keep
their camera vocabulary. Add `-DropTables` to drop them and everything in them — that is
irreversible, and it will lose the room measurements a re-survey would have to redo.
