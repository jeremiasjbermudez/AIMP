# Run it end to end

One trigger that walks a range of the script and runs each stage in order, instead of pressing the
buttons yourself.

## What you get

No tab of its own. It registers one flow that you call with a scope and let run:

- **A scope** names how much to do: a whole act, one scene, or a single beat.
- **It reads the structure first**, then iterates the stages in dependency order: character
  references, then the location panorama, then the 3D world for each scene in range.
- **It skips what already exists** unless told otherwise, so a re-run after a failure picks up
  where it stopped rather than regenerating everything.
- **A force flag** makes it redo work that is already there. Existing output is backed up, not
  overwritten in place.
- **It stops at the world build.** Shot planning, plate rendering and video generation stay
  manual, because those are the stages where a human decision changes the result.

## What it installs

**Tables** — none. It only reads and writes tables the other modules own.

**Flows**

| Flow | What it does |
|---|---|
| `2-Trigger-Orchestration` | takes a scope and a force flag, resolves what is in range, and calls each stage's flow in turn |

This flow spans several nodes rather than one, so the installer imports it from its exported
graph and writes your install's settings into it.

**ComfyUI node packs** — none of its own. It needs whatever the stages it calls need.

**Models** — none of its own, for the same reason.

## Before you install

It calls the other modules' flows, so they have to exist first:

- **core** — the project it works within.
- **screenplay** — it reads scenes and beats to know what is in range. With nothing to read it has
  nothing to do.
- **characters** — the character stage calls this module's flows.
- **world** — the panorama and world stages call this module's flows.

Install it last. A missing stage is reported as a failure for that beat rather than stopping the
whole run, but a run with most stages missing is not worth starting.

Note on cost: a full-act run is hours of GPU time, mostly in the world builds. Start with a single
scene.

## Install

```powershell
.\install-module.ps1 -Module orchestration
```

Nothing appears in the interface. Trigger the flow from Flowise, or from a script, with the scope
you want.

## How it fits

It sits above everything else and calls it. The manual path and the orchestrated path run exactly
the same flows, so anything you can do by hand it can do for you, and anything it produces you can
then pick up by hand.

## Removing it

```powershell
.\uninstall-module.ps1 -Module orchestration
```

It owns no tables and no tabs, so removing it only takes it out of the registry. Add
`-RemoveFlows` to delete its flow from Flowise as well.
