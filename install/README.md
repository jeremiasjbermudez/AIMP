# Installing

The system installs in two stages: a **core** that does nothing on its own, then one **module**
per feature. Install only the modules you want. A module brings its own database tables, its own
orchestration flows, and its own tabs in the admin app — and a tab that was never installed is
never imported, so it costs nothing in the build or the interface.

```
core        database + Flowise + ComfyUI + an admin app with no tabs
  │
  ├── screenplay      write and structure a script
  ├── characters      people and props that must stay consistent
  ├── imaging         generate and edit stills
  ├── world           location panoramas and 3D worlds
  ├── camera          place cameras in those worlds and render plates
  ├── director        plan a shot list and produce it
  ├── video           every route from a still to a moving clip
  ├── faceqa          catch and repair identity drift
  ├── colour          palettes, grading and relighting
  ├── audio           score and voice replacement
  ├── delivery        hand off to an editor
  ├── tools           copy, delete, watch the render host
  ├── library         optional searchable source text
  └── orchestration   run the whole thing from one trigger
```

---

## First time

```powershell
cd install
.\core\00-insforge.ps1      # database, storage and console, in Docker
.\core\01-flowise.ps1       # Flowise, patched and running
.\core\02-settings.ps1      # answers once: URLs, keys, paths
.\core\03-core.ps1          # base tables, registry, blank admin app
```

**`00-insforge.ps1`** clones InsForge if you do not have it, generates real secrets instead of the
development defaults its compose file ships with, starts the four containers and waits until they
answer. Two things are then yours to do once, in the console it opens: create the admin user, and
copy the anon key.

**`01-flowise.ps1`** clones Flowise at the pinned version, applies the one source patch this
pipeline needs, builds it, and starts it on port 3010. The patch gives a Custom Function node
access to the request's uploads; without it every flow that takes an uploaded file fails. Create
an API key in the UI afterwards. Pass `-SkipBuild` if it is already built.

**`02-settings.ps1`** asks for the URLs, keys and paths once and writes `install/install.env`,
which every other script reads. It holds real keys and is git-ignored. Re-run it whenever
something moves or a key is rotated. It finishes by poking each service, so a wrong answer
surfaces immediately rather than halfway through a module.

**`03-core.ps1`** creates the base tables, the module registry, and an admin app with an empty tab
bar. At that point you can sign in and create a project, and nothing else.

**ComfyUI is not scripted.** Its Python environment and CUDA build of PyTorch depend on your
machine, so guessing would do more harm than the step it saves.
[../docs/BUILD.md](../docs/BUILD.md) has it, and `02-settings.ps1` will tell you if it is not
answering. [../requirements.md](../requirements.md) covers what all of it needs.

## Choosing the language model

Story work - parsing a script into beats, drafting, naming a colour - runs on a language model.
`02-settings.ps1` asks which:

| Provider | Means | Needs |
|---|---|---|
| `ollama` | a local Ollama | its URL and a model name |
| `openai` | anything speaking the OpenAI chat-completions API: OpenAI, OpenRouter, Together, vLLM, LM Studio, llama.cpp | a base URL, a model name and an API key |

Every flow that calls a model goes through one shim, so the difference is a setting rather than a
code change. It translates in both directions: temperature, JSON mode and vision images are
converted to the provider's shape, provider-only hints are dropped rather than sent, and the reply
comes back in one shape whichever answered.

**Changing it later is a click, not a re-install.** The admin app has a model picker in the header,
beside the project picker. Add a model there - a local Ollama or a hosted API - and every flow uses
it from its next run. The choice is a row in `app_settings`, read as each call is made.

What the settings script sets is the fallback: what gets used before anyone picks anything, and
what a flow falls back to if the setting cannot be read. A flow with neither returns a message
saying so rather than failing obscurely.

An API key added through the picker is stored in the project database, readable by anyone signed in
to the app. That is reasonable on a machine only you reach and worth thinking about anywhere else;
the table is closed to the anonymous role for that reason.

## Handing the setup to an agent

[AGENT-SETUP.md](AGENT-SETUP.md) is the same four steps written for an AI agent to follow: what to
run, what to check after each step, which values it must ask a human for, and an explicit
instruction to stop once the core is up rather than installing feature modules.

## Adding a feature

```powershell
.\list-modules.ps1                      # what exists, what is installed
.\list-modules.ps1 -Module world        # everything about one
.\install-module.ps1 -Module world      # install it
```

**Dependencies install themselves.** Asking for a module that needs others installs those first,
in order, and says which it added. A dependency is not a decision - it is the module not working
without it. `-NoDeps` refuses instead, if you would rather see the list.

Each module has its own page under `modules/<name>/README.md`: its tabs, feature by feature, the
tables and flows it creates, the node packs and models it needs, and what it depends on.

Installing a module:

1. installs the modules it depends on, deepest first, if they are not already there
2. warns about ComfyUI node packs that are missing, and lists the models it will want
3. applies its tables
4. deploys any InsForge edge functions it owns
5. registers its flows and writes their ids into `admin/.env`
6. copies its panels into the app and regenerates the tab registry
7. records itself in `installed_modules`
8. opens a separate window that downloads its ComfyUI models and node packs (see *Getting the
   models and node packs*). It does not wait: the download runs on while the install returns.
   `-NoAssets` skips it.

Restart the dev server afterwards and the new tabs are there.

**Features that cross module boundaries degrade rather than break.** The grade, relight and face
repair controls sit on cards in tabs other modules own. When the module behind one is not
installed, the button stays where it is, disabled, saying which module it needs and the command
that installs it. Nothing disappears and nothing errors when pressed. The shared image picker does
the same with data: it reads six tables belonging to five modules, and a table that does not exist
yet simply contributes nothing.

Everything is safe to run twice, and that is tested rather than asserted: every module's SQL is
guarded (`IF NOT EXISTS` on tables, indexes and schemas; existence checks on constraints and
policies; triggers dropped before creation), a flow with the same name is updated rather than
duplicated, and the registry row is upserted. `-WhatIf` shows what a run would do without doing it.

**Modules that reference each other install in either order.** A rendered clip points at the shot
it came from and a planned shot points at the clip that rendered it, so neither can require the
other. Those foreign keys are added only when both tables exist, and installing the second module
re-applies the first one's schema to close the link.

## Removing a feature

```powershell
.\uninstall-module.ps1 -Module colour                 # tabs go, tables stay
.\uninstall-module.ps1 -Module colour -DropTables     # tables go too
.\uninstall-module.ps1 -Module colour -RemoveFlows    # delete its flows as well
```

Tables are kept by default, deliberately: removing a feature should not destroy the work done
with it, and a tab is easy to put back while a dropped table is not. A module that something else
depends on cannot be removed until the dependent is.

## What a light install saves

Measured on this repository, production build of the admin app:

| install | tabs | bundle |
|---|---|---|
| every module | 24 | 2.76 MB |
| screenplay only | 3 | 1.98 MB |

The floor is the shell and its libraries. The real saving is elsewhere: a module you skip means
its models are never downloaded, its node packs are never installed, and its tables never exist.
The video module alone accounts for the largest model downloads in the system.

## How it is wired

| File | Role |
|---|---|
| `modules.json` | the module map: tables, flows, panels, packs, models, dependencies. The single source of truth — the installers read it and nothing hardcodes a module's contents. Each flow carries its own registered name and the `.env` variable its id belongs in. |
| `tabs.json` | per-tab label, hint, icon, component and props, lifted from the app so the registry can be generated. |
| `install.env` | this install's URLs, keys and paths. Git-ignored. |
| `modules/<name>/schema.sql` | that module's tables, split out of the full schema. |
| `modules/<name>/README.md` | that module's documentation. |
| `lib/common.ps1` | shared helpers: settings, SQL, flow registration, `.env` editing, registry. |
| `core/00-insforge.ps1`, `core/01-flowise.ps1` | install and start the two services the pipeline depends on. |
| `functions/` | InsForge edge functions: Deno code InsForge stores and runs itself. `functions.json` says which module each belongs to. |
| `../flowise/flows/` | the complete exported graph of every flow: all of its nodes, its code and its own variables. This is what a flow is installed from. |
| `../flowise/prompts/` | the system prompts three flows use, as their original Markdown. The installed copy travels inside the flow export; these are the readable originals. |
| `lib/create-flow.js` | registers one flow from a source file, or imports one from an exported graph. |
| `lib/deploy-function.js` | deploys one edge function, through the InsForge API or straight into its table when the API route has moved. |
| `lib/write-registry.js` | rewrites the app's tab registry from the panels present on disk. |

Adding a module later means adding an entry to `modules.json`, a `schema.sql`, a `README.md`, and
the panel files. No installer code changes.

## Installing from the app

The gear in the header opens a settings page listing every module, what each brings, and whether it
is installed, with a button to add or remove one. It is the same installers underneath: a browser
cannot run PowerShell, so the page asks flow `47-Install-Module` to run them on the machine.

That flow takes a module NAME and nothing else, and checks it against `modules.json` before it
spawns anything - a name that is not a module never reaches a shell. Removing a module from the
page takes away its tabs and keeps its data; dropping tables stays a command-line act, so a click
cannot destroy a project.

Restart the dev server after installing from the page: the panel files are new on disk and the
tab registry has been regenerated.

## Getting the models and node packs

Installing a module starts this for you, in its own window, with a log under `install\logs\`. It
is also a script of its own, for fetching again after a failure or ahead of time:

```powershell
.\fetch-assets.ps1 -Module video            # one module
.\fetch-assets.ps1 -Module video -WhatIf    # what it would do
.\fetch-assets.ps1 -All -PacksOnly          # every pack, no downloads
```

Node packs are cloned from their own repository, or installed from the ComfyUI registry when that
is where they came from. Models are pulled from Hugging Face into the folder the graphs load them
from. Anything already present is skipped, and downloads go through the shared cache, so a second
machine or a re-run does not transfer them again.

**It does not guess.** Eighteen of the model files here - community LoRAs and detector weights
collected by hand - have no recorded origin. Inventing a plausible URL for one of those is how the
wrong weights end up silently installed, so they are listed with their filename and target folder
instead. `docs/MODELS.md` has whatever is known about each.

A cloned node pack has its `requirements.txt` installed into **ComfyUI's own Python** (its `.venv`,
`venv`, or the portable build's `python_embeded`), never whatever `python` is on PATH. Without that
ComfyUI skips the pack at startup and its nodes are unknown, with the pack sitting on disk.

**Gated models need a Hugging Face token.** Some model owners require an account that has accepted
their licence - the main image model, `black-forest-labs/FLUX.2-klein-9B`, is one. Open the model's
page on huggingface.co and accept the licence, create a *Read* token under Settings > Access Tokens,
and add it to `install.env`:

```
HF_TOKEN=hf_...
```

Without it the download fails with `401 ... Cannot access gated repo`, and the rest still arrive.
Run `.\fetch-assets.ps1 -Module <name>` again once the token is in.

Downloads land in the Hugging Face cache first (`%USERPROFILE%\.cache\huggingface\hub`) and are
copied into ComfyUI's models folder, so a large model occupies its size twice. Delete the cache
when space matters more than skipping a re-download.

Restart ComfyUI after new node packs. **Do not render while a large model is still being copied
into place:** ComfyUI lists a file as soon as it appears, and a half-written one fails to load.

## When the tabs and the install disagree

The tabs come from the panel files in `admin/src`, which module installs put there. If those files
and the `installed_modules` table ever disagree - a folder copied from another machine, an install
that stopped halfway, a panel deleted by hand - the app shows tabs with nothing behind them, or
hides tabs that are installed.

```powershell
.\repair-admin.ps1            # make the files match the table
.\repair-admin.ps1 -WhatIf    # show the difference, change nothing
```

It restores panels for installed modules, removes panels for modules that are not, and regenerates
the registry. It touches no database rows, no flows and no settings.

## Troubleshooting

**"install.env does not exist yet"** — run `core\02-settings.ps1`.

**A module installs but its tab does not appear** — the dev server caches the registry; restart
it. If it still does not, check `admin/src/modules.generated.tsx` lists the tab.

**A render fails with an unknown node** — a ComfyUI node pack is missing, or ComfyUI was not
restarted after one was installed. `list-modules.ps1 -Module <name>` names the packs.

**A column is reported missing that clearly exists** — PostgREST caches the schema. The installer
sends the reload, but if you changed the database by hand, run
`NOTIFY pgrst, 'reload schema';` yourself.

**"Access to this host is denied by policy"** — Flowise is blocking requests to private addresses,
which is every service here. Re-run `core\01-flowise.ps1` or add `HTTP_SECURITY_CHECK=false` and
the `HTTP_DENY_LIST` line to `packages/server/.env`, then restart Flowise. `02-settings.ps1`
reports this before you hit it.

**"Cannot find module 'child_process'"** (the settings page, file pickers, the render tools) —
Flowise's sandbox lets a flow load only a short list of Node built-ins. Re-run `core\01-flowise.ps1`
or add `TOOL_FUNCTION_BUILTIN_DEP=child_process,fs` to `packages/server/.env`, then restart Flowise.

**A render fails with `value_not_in_list ... not in []`** — the model file is not in ComfyUI's
models folder yet. `.\fetch-assets.ps1 -Module <name>`; a `401` there means the model is gated and
needs `HF_TOKEN` (see *Getting the models and node packs*).

**A flow id in `.env` points at nothing** — re-run the module's install; it updates the existing
flow and rewrites the id.

### Not faults in this repository

Two things that look like installer bugs and are not, both found on a second machine:

**pnpm stops at a prompt and nothing happens.** Run from a console without a TTY, pnpm waits on a
confirmation nobody can answer. Run the install from a real terminal, or set `CI=1` for the run.

**`pnpm start` fails to find its own executable.** If `NoDefaultCurrentDirectoryInExePath` is set
in the environment, Windows will not resolve a command from the working directory, and Flowise's
start script depends on that. Clear it for the session, or start Flowise from a shell without it.

## Starting everything afterwards

```powershell
..\start-all.ps1          # or double-click "Start AIMP.cmd" in the repository root
```

It reads `install.env`, so it starts the three services where this install put them, leaves
anything already running alone, and starts ComfyUI with CORS enabled — which the admin app needs
to display rendered images at all. `-Restart` stops them first; `-Quiet` runs them without
windows.
