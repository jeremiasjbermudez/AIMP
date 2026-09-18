# Setup instructions for an AI agent

You are setting up this system on a fresh machine. Follow this document top to bottom.

**Your scope is the core only.** Install the four services, the base tables and the admin shell,
and stop. Do **not** install feature modules. The operator installs those individually, later, as
they need them. If you finish the core and are tempted to keep going, you are done; report and
stop.

---

## Before you start

Read [../requirements.md](../requirements.md). Then confirm these exist, and stop and report if
any are missing rather than installing them yourself without saying so:

| Needed | Check |
|---|---|
| Docker Desktop, running | `docker version` |
| Node 24+ | `node --version`. The Flowise build refuses below 24, whatever the admin app needs |
| npm | `npm --version` |
| git | `git --version` |
| An NVIDIA GPU with 24 GB or more | `nvidia-smi` |

PowerShell is the shell for every script here. Run them from the `install` folder.

Two Windows things to settle first, because both fail in ways that point somewhere else:

- **Open a new terminal after installing anything that changes `PATH`** (Docker Desktop, Node). A
  window that was already open keeps the old environment and reports `docker` as not recognized
  even though it is installed. If a new window still does not see it, sign out and back in, or
  reload it in place:
  `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`
- **Unblock the scripts once.** A copy downloaded or fetched from a share carries a mark that makes
  PowerShell ask before every script - including `lib\common.ps1` halfway through a run - and the
  prompt defaults to *Do not run*. From the repository root:
  `Get-ChildItem -Recurse -Include *.ps1 -File | Where-Object { $_.FullName -notmatch '\\node_modules\\' } | Unblock-File`

---

## Step 0 — ComfyUI, by hand

**This is not scripted and you should not improvise it.** The Python environment and the CUDA
build of PyTorch depend on the machine, and a wrong guess wastes a very large download.

Follow section 2 of [../docs/BUILD.md](../docs/BUILD.md). In short: Python 3.12, a CUDA 12.8 build
of PyTorch, ComfyUI itself, and then `python main.py --enable-cors-header`.

**If ComfyUI is already installed**, use it rather than building a second one - as long as it is
0.34 or later and PyTorch sees the GPU. Newer is fine: ComfyUI 0.34.0 on Python 3.11 with PyTorch
2.13 + CUDA 13.0 has run this pipeline. Its root folder is the answer to a question in step 3.

Do not install node packs or models yet. Each module names the ones it needs, and the operator
installs them with that module.

Confirm before moving on:

```powershell
Invoke-RestMethod http://127.0.0.1:8188/system_stats | Select-Object -ExpandProperty system
```

If that fails, stop and report. The later steps check for ComfyUI and will tell you it is absent,
but they will not fix it.

---

## Step 1 — InsForge

```powershell
cd install
.\core\00-insforge.ps1
```

What it does: clones InsForge if absent, generates real secrets instead of the development
defaults its compose file ships with, starts four containers, waits until the API answers.

**It will stop and warn** if InsForge is already running without a settings file. That means it is
using published default secrets. Do not pass `-RotateSecrets` to get past that warning unless the
operator has told you the deployment is empty: rotating secrets makes existing data unreadable.

**Then a human step.** Open the console it prints, and ask the operator to:

1. sign in as the root admin the script printed - it created that account from the settings it wrote
2. **create an app user** (an email and a password) under the console's users page. This is a
   different account from the root admin: the root admin is a console login with a username, and
   the admin app signs in with `signInWithPassword({ email, password })`, which only an app user
   can do. Sign-in fails if `VITE_ADMIN_EMAIL` holds the root admin.
3. copy the anon key

You need these in steps 3 and 4. Do not invent them, and do not create the app user through the API
unless the operator asks you to.

The anon key is also readable over the admin API once signed in, at
`GET /api/metadata/anon-key` (and the service key at `GET /api/metadata/api-key`). Use that if you
have a session; it is not scripted here because it needs an authenticated call that has not been
tested on a fresh install.

Confirm:

```powershell
docker ps --format "{{.Names}}`t{{.Status}}"
```

Four containers, all up.

---

## Step 2 — Flowise

```powershell
.\core\01-flowise.ps1
```

What it does: clones Flowise at the pinned version, applies the one source patch this pipeline
requires, installs, builds, and starts it on port 3010.

**About the patch.** It gives a custom function access to the request's uploads. Without it every
flow that takes an uploaded file fails. The script detects an already-patched checkout and leaves
it alone. If it reports that the line it attaches to has moved, **stop and report** — do not
improvise a different patch.

The build takes several minutes. That is normal. Pass `-SkipBuild` only if the checkout is already
built.

**If it reports Flowise answering on port 3000 instead of 3010**, its settings file was not read.
The script writes `packages/server/.env`; check that file exists and holds `PORT=3010`, stop the
running process, and run the script again. Do not "fix" it by changing what the rest of the
pipeline expects.

**Then a human step.** In the Flowise UI, ask the operator to create an API key and give it to
you. You need it in step 3.

Confirm:

```powershell
Invoke-RestMethod http://localhost:3010/api/v1/chatflows -Headers @{ Authorization = "Bearer <key>" }
```

An empty list is the correct answer at this point.

---

## Step 3 — Settings

```powershell
.\core\02-settings.ps1
```

It asks for each value and writes `install/install.env`, which every later script reads. Enter
accepts the value in brackets.

What to enter:

| Prompt | Value |
|---|---|
| Postgres container name | **read it, do not assume it:** `docker ps --format "{{.Names}}"` and take the one containing `postgres` |
| Database name | `insforge` |
| InsForge API URL | `http://localhost:7130` |
| InsForge service API key | from the InsForge console |
| Flowise URL | `http://localhost:3010` |
| Flowise API key | the key from step 2 |
| ComfyUI URL | `http://127.0.0.1:8188` |
| ComfyUI root folder | where you installed it, with a trailing slash |
| Admin app folder | accept the default |
| Language model: provider | `ollama` for a local Ollama, or `openai` for anything speaking the OpenAI chat-completions API (OpenAI, OpenRouter, Together, vLLM, LM Studio). Ask the operator which |
| Language model: URL | Ollama: Enter for `http://localhost:11434`. OpenAI-style: the base URL with no trailing path |
| Language model: model name | ask the operator; for Ollama it must be one `ollama list` shows, e.g. `qwen3.8:latest` |
| Language model: API key | only for `openai`; from the operator |

It finishes by poking each service and printing `ok` or `NOT YET` per service. **Every one must say
`ok` before you continue**, the language model included: the story tools (the screenwriter, beat
parsing) call it on every request. If one does not, fix that service; do not carry on and hope.

**Optional: a Hugging Face token.** Some models are gated and download only with an account that
has accepted their licence - the main image model, `black-forest-labs/FLUX.2-klein-9B`, is one. The
settings script does not ask for it. When the operator installs a module that needs one, they
accept the licence on its Hugging Face page, create a *Read* token, and it goes in `install.env` as
`HF_TOKEN=hf_...`. The downloader picks it up from there. Not needed for the core.

`install.env` holds real keys. It is git-ignored. Never print its contents, never commit it, and
never paste it into a message.

---

## Step 4 — Core

```powershell
.\core\03-core.ps1
```

What it does: checks the tools, creates the base tables and the module registry, **deploys the
core InsForge edge functions**, installs the admin app's dependencies, writes the service URLs into
`admin/.env`, and generates an empty tab registry.

The edge functions matter more than they sound: creating a project calls one of them. If the step
reports it could not deploy `create-movie`, stop and report - the app will load and then fail at
the first thing anyone does with it.

**Then fill in these by hand** in `admin/.env`, which the script cannot know:

```
VITE_INSFORGE_ANON_KEY=   # from the InsForge console
VITE_ADMIN_EMAIL=         # the APP user created in step 1 - an email, not the root admin
VITE_ADMIN_PASSWORD=      # that app user's password
VITE_FLOWISE_API_KEY=     # the key from step 2
```

Ask the operator for them. Do not guess, and do not leave placeholder text in the file.

---

## Step 5 — Check it works, then stop

```powershell
cd ..\admin
npm run dev
```

Open the address it prints. You should see:

- a sign-in that succeeds
- a project picker, where you can create a project
- **an empty tab bar**

**An empty tab bar is success, not a fault.** Every feature is a module, and no modules are
installed. Do not install any to "prove it works".

Verify the registry:

```powershell
cd ..\install
.\list-modules.ps1
```

`core` shows as installed and everything else as `-`. That is the finished state.

---

## Report back

Tell the operator, briefly:

1. Which services are running, and on which ports.
2. Where each one is installed on disk.
3. That the admin app runs with no tabs, and how to start it.
4. **What to run next**, in their words, not yours. Either the gear at the top right of the app,
   which lists every module with an Install button, or:
   ```powershell
   cd install
   .\list-modules.ps1                       # what is available
   .\list-modules.ps1 -Module screenplay    # what one of them brings
   .\install-module.ps1 -Module screenplay  # install it
   ```
   Installing a module also installs the modules it needs, and then opens a separate window that
   downloads its ComfyUI models and node packs (`-NoAssets` skips that). Models run to tens of
   gigabytes. After it: restart ComfyUI if node packs were added, and restart the admin dev server
   to see new tabs.
5. That `Start AIMP.cmd` in the repository root (or `start-all.ps1`) starts InsForge, ComfyUI
   (with CORS) and Flowise after a reboot, skipping whatever is already running.
6. Anything you could not complete, and exactly where it stopped.

---

## Rules

- **Do not install feature modules.** Not to test, not to demonstrate, not because a dependency
  chain suggests it. The operator chooses those.
- **Do not download models or ComfyUI node packs.** They belong to modules and are large. Each
  module's page lists its own.
- **Do not invent credentials.** Keys, emails and passwords come from the operator. If you do not
  have one, stop and ask.
- **Do not skip a failing check.** If a service does not answer, say so and stop. A half-built
  system that reports success is worse than one that stops with a clear message.
- **Do not print or commit `install.env` or `admin/.env`.** Both hold real keys.
- **Every script supports `-WhatIf`.** Use it if you are unsure what a step will do.
- **Every script is safe to run twice.** If one fails halfway, fix the cause and run it again
  rather than patching around it by hand.

## If something goes wrong

| Symptom | What it means |
|---|---|
| `install.env does not exist yet` | step 3 has not run |
| InsForge does not answer after five minutes | check `docker compose logs`; the first start pulls four images |
| `docker` (or `node`) is not recognized, but it is installed | the terminal predates the install; see *Before you start* |
| A security prompt before every script | the scripts are marked as downloaded; unblock them, see *Before you start* |
| Flowise build fails | Node or pnpm outside the range Flowise declares: **Node 24.x** (22 and 26 are both refused) and **pnpm 10.26+**. `node --version` |
| `ERR_PNPM_IGNORED_BUILDS` | pnpm 12 or later; it blocks the native modules Flowise needs. Use pnpm 10.26 |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | a leftover `node_modules` from a different pnpm. Set `$env:CI='true'` and re-run step 2 |
| The patch anchor is missing | Flowise changed upstream. Stop and report; do not improvise |
| A flow fails with `Access to this host is denied by policy` | Flowise's settings file lacks `HTTP_SECURITY_CHECK=false`. Re-run step 2, which writes it, and restart Flowise |
| A flow fails with `Cannot find module 'child_process'` (the settings page, among others) | Flowise's settings file lacks `TOOL_FUNCTION_BUILTIN_DEP=child_process,fs`. Same fix |
| A column is reported missing that exists | PostgREST caches the schema: `NOTIFY pgrst, 'reload schema';` |
| The admin app shows no tabs | correct at this stage |
| New tabs do not appear after installing a module | restart the admin dev server, then hard refresh (Ctrl+F5) |
| A render fails with `value_not_in_list ... not in []` | the model file is not in ComfyUI's models folder. `.\fetch-assets.ps1 -Module <name>` |
| A download fails with `401 ... gated repo` | the model needs a Hugging Face token; see *Optional: a Hugging Face token* in step 3 |
| A node pack is on disk but its nodes are unknown to ComfyUI | its Python requirements are not in ComfyUI's environment, or ComfyUI was not restarted after it arrived |
