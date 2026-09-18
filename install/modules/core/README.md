# Core

The database, the module registry and an admin app with no tabs. It is not a feature; it is what
every feature is installed into.

## What you get

A working but deliberately empty system:

- **Sign-in** against the database, with the session kept alive while you work.
- **A project picker.** Create a project, switch between projects, mark one active. Most flows
  resolve which project they are working on from that active flag.
- **The layout**: the sidebar, the tab bar, the theme switch and the image preview overlay. The tab
  bar starts empty and fills in as modules are installed.
- **A render-host monitor**, which lists what the GPU is working on and what is queued behind it.
  It is in the shell rather than a module because it is useful whatever else is installed.
- **The shared helpers** every panel builds on: the database client, the flow trigger, file upload,
  the image pickers, and the common controls.

No generation of any kind. Install a module for that.

## What it installs

**Tables**

| Table | Holds |
|---|---|
| `movies` | one row per project: title, slug, storage bucket, active flag, status |
| `movie_frames` | frames and snapshots saved into a project, which is what the image pickers list |
| `movie_reference_images` | a loose pool of uploaded images usable from anywhere |
| `prompt_log` | an audit trail of what was sent to which model |
| `installed_modules` | the installer's own record: which modules are present, their flow ids and their tabs |

**Flows**

| Flow | What it does |
|---|---|
| `41-Copy-Movie` | duplicate a project, with or without its rendered work |
| `15-Delete-Movie` | survey what a project owns, then remove it and its files |
| `29-Delete-Asset` | remove one asset’s files from the render host |

They are core rather than a feature because the project picker and the shared asset helper that
call them are part of the shell. Everything else core does, it does against the database directly.

**ComfyUI node packs** — none.

**Models** — none.

## Before you install

The four services must already exist and answer. See [../../../requirements.md](../../../requirements.md)
for what they need and [../../../docs/BUILD.md](../../../docs/BUILD.md) for building them:

- **InsForge** running, with an admin user created and its anon key to hand.
- **Flowise** running, patched, with an API key created.
- **ComfyUI** running with CORS enabled.
- **Node 20 or newer, npm, Docker** on PATH.

## Install

```powershell
cd install
.\core\02-settings.ps1
.\core\03-core.ps1
```

`02-settings.ps1` asks for the URLs, keys and paths once and writes `install/install.env`, which
every other script reads. It finishes by poking each service, so a wrong answer surfaces now
rather than halfway through a module.

`03-core.ps1` creates the tables, installs the app's dependencies, writes the service URLs into
`admin/.env` and generates an empty tab registry. Three values it cannot know — the InsForge anon
key and the admin email and password — you fill in by hand.

Then `cd admin ; npm run dev` and sign in.

## How it fits

Everything else depends on core, and core depends on nothing. Its `movies` table is the root that
every other table hangs off, and its `installed_modules` table is how the installer knows what is
present and how the app knows which tabs to show.

## Removing it

Core cannot be uninstalled. Remove the modules on top of it instead; what remains is a system with
projects and no features, which is where you started.
