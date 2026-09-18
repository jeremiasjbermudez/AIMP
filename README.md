# AIMP — AI Movie Pipeline

Infrastructure for producing film from a screenplay with local generative models: a database, a
browser admin, an orchestration layer of flows, and a GPU render host. It covers the whole path
from script to rendered shots — story structure, character references, 360° location panoramas,
3D Gaussian-splat worlds you can place cameras in, plate rendering, image editing, video
generation, colour, score and an editorial hand-off.

This repository is the **infrastructure only**: the machinery, with none of the work made with it.
No images, no video, no audio, no screenplays and an empty database. See
[What is deliberately missing](#what-is-deliberately-missing).

---

## What this is

Four services on one workstation, plus one optional second machine for text work:

| Service | Role | Default port |
|---|---|---|
| **InsForge** (Postgres + PostgREST + storage) | every row and every uploaded file | 7130 |
| **Flowise** | 45 flows: the orchestration and all server-side logic | 3010 |
| **ComfyUI** | every GPU render: image, video, audio, 3D | 8188 |
| **pipeline-admin** (React + Vite) | the operator's browser UI, 24 tabs | 5185 |
| **Ollama** (optional, second box) | text models for story and prompt work | 11434 |

The browser app never talks to ComfyUI for work: it writes a row, then triggers a Flowise flow,
which builds a ComfyUI graph in code, submits it, waits, and writes the result back to the row.
The UI polls the row. That is the shape of nearly every feature here.

```
browser (admin)  ──writes row──►  InsForge (Postgres)
       │                                ▲
       └──triggers flow──►  Flowise  ───┘
                              │
                              └──builds + submits graph──►  ComfyUI  ──►  files on disk
```

## Documentation

| Document | What it covers |
|---|---|
| [requirements.md](requirements.md) | hardware, OS, runtimes, disk, everything needed before install |
| [docs/BUILD.md](docs/BUILD.md) | step-by-step build of all four services, with versions |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how the pieces fit, data flow, conventions, gotchas |
| [docs/TABS.md](docs/TABS.md) | every tab of the admin app, its purpose and its features |
| [docs/MODELS.md](docs/MODELS.md) | every model file, size, source and what uses it |
| [docs/FLOWS.md](docs/FLOWS.md) | all 45 Flowise flows, what each does and what it takes |
| [docs/COMFYUI.md](docs/COMFYUI.md) | the graphs submitted over the API and the node packs they need |
| [insforge/README.md](insforge/README.md) | the database: 31 tables, how to create them empty |
| [install/README.md](install/README.md) | the modular installer: core, then one module per feature |
| [install/AGENT-SETUP.md](install/AGENT-SETUP.md) | the core setup written for an AI agent to run end to end |
| `install/modules/<name>/README.md` | one page per module: its tabs, tables, flows, models and dependencies |

## Layout

```
install/        the installer: core scripts, per-module payloads and docs
  modules.json  the module map - what each module owns
  modules/      one folder per module: schema.sql and README.md
admin/          the admin SHELL: sign-in, project picker, layout, shared helpers
  .env.example  every variable the app reads, values blank
admin-src/      the panels modules copy in when installed
flowise/
  nodes/        the custom-function source of each flow - the real logic
  scripts/      create/update a flow on a Flowise instance from that source
  flows/        exported flow graphs, one JSON per flow, install ids stripped
insforge/
  schema.sql    all 31 tables, empty, with indexes and row-level security
comfyui/        which graphs are submitted, and the node packs required
docs/           everything above
```

## Quick start

It installs in two stages: a core that does nothing on its own, then one module per feature. You
install only the features you want, and a feature you skip costs nothing — no tables, no flows, no
models to download, no tab in the interface.

```powershell
# 1. ComfyUI, by hand - its Python and CUDA build depend on your machine.
#    see requirements.md, then docs/BUILD.md

# 2. the rest, scripted
cd install
.\core\00-insforge.ps1     # database, storage, console
.\core\01-flowise.ps1      # orchestration, patched and running
.\core\02-settings.ps1     # URLs, keys, paths - asked once
.\core\03-core.ps1         # base tables and an admin app with no tabs

# 3. add what you need
.\list-modules.ps1
.\install-module.ps1 -Module screenplay
.\install-module.ps1 -Module characters
```

Full detail in [install/README.md](install/README.md), and one page per module under
`install/modules/<name>/README.md`. Expect the model downloads, not the code, to be the long part:
see [docs/MODELS.md](docs/MODELS.md).

## What is deliberately missing

This repository is the machinery, not the work made with it:

- **No media.** No images, video, audio, panoramas, splats, LUTs, model weights or any other
  binary asset. Nothing here is larger than a source file.
- **No project content.** The database ships empty: no screenplays, beats, scenes, characters or
  renders. Where a code comment cited a real case from the films this was built on, the names have
  been replaced with neutral ones.
- **No secrets.** No API keys, tokens, passwords or hosts. Every such value is blank in
  `.env.example` and redacted anywhere else.
- **No saved ComfyUI workflow files.** Every graph is built in code inside the flow that runs it,
  so `flowise/nodes/` is the real reference. See [docs/COMFYUI.md](docs/COMFYUI.md).

The prompt engineering **is** included: the templates, presets and prompt-assembly logic are part
of the machinery and ship as written.

## Licence and third-party components

The admin app, the flow sources and the documentation here are this project's own work. Flowise,
ComfyUI, InsForge, every ComfyUI node pack and every model carry their own licences, which are
not restated here and not bundled — you install them yourself and accept their terms. Several
models are non-commercial or carry use restrictions; check each one before shipping anything.
