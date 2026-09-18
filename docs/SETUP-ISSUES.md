# Issues found during a clean core setup

Found following [install/AGENT-SETUP.md](../install/AGENT-SETUP.md) top to bottom on a fresh
machine, 2026-09-17. Core scope only — no feature modules.

Machine: Windows 11 Pro 26200, RTX 3090 (24 GB), Docker Desktop 4.91.0 / engine 29.8.0.

Five issues stop the install outright (the fifth is in the first module install, not core). One of them is silent, which is worse: Flowise comes up
apparently fine, on the wrong port, and every later step that talks to it fails for reasons that
point somewhere else.

Files changed in this repo: `install/modules/core/prelude.sql` (issue 4) and
`install/lib/common.ps1` (issue 5, plus the `Set-EnvValues` fix under issue 2). Separately, as a
feature rather than a fix, `install-module.ps1` and `uninstall-module.ps1` now restart the admin
dev server when tabs change, if it is running. Everything else was worked around outside the repo, so the bugs are all still
reproducible from a clean checkout.

---

## 1. `install/core/01-flowise.ps1` writes `.env` where Flowise does not read it

**Severity: breaks the install, silently.**

[01-flowise.ps1:120](../install/core/01-flowise.ps1#L120) writes the settings file to the repo
root:

```powershell
$envFile = Join-Path $Path '.env'          # C:\Users\Alivai\flowise\.env
```

Flowise 3.1.3 loads it from `packages/server/.env`. From
`packages/server/src/commands/base.ts:6`:

```ts
dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), override: true })
```

`__dirname` at runtime is `packages/server/dist/commands`, so `../../.env` resolves to
`packages/server/.env`.

**What it looks like when it bites.** Nothing errors. `PORT`, `DATABASE_PATH`, `APIKEY_PATH`,
`SECRETKEY_PATH` and `LOG_PATH` are all ignored, so Flowise starts on its default port **3000**
and puts its SQLite database in `~/.flowise`. The script's own readiness probe polls
`http://localhost:3010`, never gets an answer, and prints:

```
!!  No answer from http://localhost:3010 after five minutes. Look at the window it opened.
```

The window it opened shows a perfectly healthy server:

```
[INFO]: 🎉 [server]: All initialization steps completed successfully!
[INFO]: ⚡️ [server]: Flowise Server is listening at :3000
```

`data3010/` stays empty, which is the quickest tell. The state lands in `~/.flowise` instead —
verified: `database.sqlite`, `encryption.key`, `jwt_auth_token_secret.key` and friends were all
created there. Anyone who hits this and then fixes the path should delete that stray directory,
or they will be looking at one database while Flowise reads another.

**Fix.** Write to the path Flowise reads, and keep the port the rest of the pipeline assumes:

```powershell
$envFile = Join-Path $Path 'packages\server\.env'
```

Worth also verifying after start that the port answering is the port requested, rather than only
polling the expected one.

---

## 2. The same block writes a malformed file

**Severity: breaks the install. Independent of #1 — fixing the path alone is not enough.**

[01-flowise.ps1:132](../install/core/01-flowise.ps1#L132):

```powershell
$lines = if (Test-Path $envFile) { @(Get-Content $envFile) } else { @() }
```

On a first run the `else` branch returns `@()`. PowerShell **unrolls an empty array returned from
an `if` expression to `$null`**, so `$lines` is not an empty array — it is `$null`. The first
`$lines += $line` then makes it a *String*, and every subsequent `+=` concatenates rather than
appends.

Confirmed directly:

```
type: String  count: 1
```

`Set-Content -Encoding utf8` under Windows PowerShell 5.1 then adds a BOM. The file produced:

```
00000000   EF BB BF 50 4F 52 54 3D 33 30 31 30 44 41 54 41  ï»¿PORT=3010DATA
00000010   42 41 53 45 5F 50 41 54 48 3D 43 3A 5C 78 4C 4F  BASE_PATH=C:\xLO
00000020   47 5F 50 41 54 48 3D 43 3A 5C 78 5C 6C 6F 67 73  G_PATH=C:\x\logs
00000030   0D 0A                                            ..
```

Five keys on one line, no separators, and a BOM that turns the first key into `\ufeffPORT`.
Nothing in it parses.

The update-in-place loop just above it never fires either, since it only ever sees a one-element
collection — so the script is not idempotent for this file, contrary to the "safe to run twice"
promise in [AGENT-SETUP.md](../install/AGENT-SETUP.md).

**Fix.** Force an array and drop the BOM:

```powershell
[string[]]$lines = @(if (Test-Path $envFile) { Get-Content $envFile })
...
[System.IO.File]::WriteAllLines($envFile, $lines)   # UTF-8, no BOM
```

**The same pattern is in `Set-EnvValues`** in [common.ps1](../install/lib/common.ps1), which every
module install uses to write flow ids into `admin/.env`. There it only misfires if `admin/.env` is
missing, but its BOM was live: `admin/.env` started `EF BB BF` after the first module install. That
was harmless only because the file's first line is a comment. Both are fixed there (an array forced
with `@()`, written with `WriteAllLines`); `01-flowise.ps1` is not yet.

`@(...)` wrapped around the whole conditional is the idiom that survives the unroll. If you keep
`Set-Content`, note that `-Encoding utf8` means BOM on 5.1 and no BOM on 7+; `utf8NoBOM` does not
exist on 5.1.

---

## 3. `requirements.md` records a toolchain the pinned Flowise tag rejects

**Severity: breaks the install at `pnpm install`.**

[requirements.md:38-39](../requirements.md#L38-L39) gives:

| Component | Version used |
|---|---|
| Node.js | 22.23.1 |
| pnpm | 9.x |

The pinned tag `flowise@3.1.3` (commit `09f099d Release/3.1.3`) declares in its root
`package.json`:

```json
"engines": { "node": "^24", "pnpm": "^10.26.0" }
```

Installing pnpm 9 as the doc directs produces:

```
ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)
Expected version: ^10.26.0   Got: 9.15.9
Expected version: ^24        Got: v26.1.0
```

Note `01-flowise.ps1` installs pnpm itself when absent
([line 46](../install/core/01-flowise.ps1#L46)) with a bare `npm install -g pnpm`, so it picks up
whatever is latest — pnpm 12 at time of writing, which is also outside the supported range and
fails differently, on `ERR_PNPM_IGNORED_BUILDS`:

```
× installing dependencies
╰─▶ Ignored build scripts: @swc/core@1.4.6, canvas@2.11.2, faiss-node@0.5.1,
    sharp@0.33.5, sqlite3@5.1.7, ssh2@1.16.0, ...
```

Those are native modules Flowise needs built. pnpm 10+ blocks build scripts by default; pnpm 12
treats it as a hard error. It also rewrites `pnpm-workspace.yaml`, adding an `allowBuilds:` block
full of literal `set this to true or false` placeholders, and touches `pnpm-lock.yaml` — both need
reverting before a retry.

**Fix.** Update `requirements.md` to Node 24.x / pnpm 10.26+, and pin the install in the script so
it cannot drift:

```powershell
npm install -g pnpm@10.26.1
```

Verified working: **Node 24.19.0, pnpm 10.26.1** — `pnpm install` clean, `pnpm build` 6/6 packages
in 1m6s, server answering on 3010 in 10s.

The guidance in [AGENT-SETUP.md:235](../install/AGENT-SETUP.md#L235) — "Flowise build fails |
almost always Node too old" — should probably say "too old *or too new*"; a current Windows box
installs Node 26 by default, and being ahead of the range fails just as hard.

---

## 4. `install/modules/core/prelude.sql` cannot succeed against an InsForge database

**Severity: breaks the install on a first run, every time.**

`prelude.sql` is a raw `pg_dump` fragment, and its only real statement is:

```sql
CREATE SCHEMA public;
```

InsForge's database always has a `public` schema. `Invoke-Sql` runs psql with
`-v ON_ERROR_STOP=1` ([common.ps1:62](../install/lib/common.ps1#L62)) — correctly, as its own
comment explains — so the whole run aborts on the first statement of the first file:

```
==> Creating the core tables
  prelude.sql
ERROR:  schema "public" already exists
SQL failed (exit 3). Nothing further was applied.
```

`schema.sql` and `registry.sql` never run, and step 4 gets no further.

The dump header (`Dumped by pg_dump version 18.4`) suggests this was generated against a database
where `public` had been dropped, so it round-tripped cleanly for whoever produced it.

**Fix applied here:**

```sql
CREATE SCHEMA IF NOT EXISTS public;
```

That yields a `NOTICE: schema "public" already exists, skipping` and the run proceeds. The
`\restrict` / `\unrestrict` markers and the pg_dump preamble are noise in a file this small and
could go too.

**Related, not fixed:** `schema.sql` has 4 `CREATE TABLE` statements and no `IF NOT EXISTS`, and
`03-core.ps1` does not guard against re-entry. So `03-core.ps1` is not in fact safe to run twice
on a database where core is already installed — it will abort on the first existing table.
`registry.sql` does use `IF NOT EXISTS` and is fine. Given the "Every script is safe to run
twice" promise in [AGENT-SETUP.md](../install/AGENT-SETUP.md), `schema.sql` probably wants the same
treatment.

---

## 5. `Invoke-Sql -Command` strips double quotes, so module installs fail at the last step

**Severity: breaks every module install that registers flows. Found installing `screenplay`.**

[common.ps1](../install/lib/common.ps1) ran inline SQL as a native argument:

```powershell
docker exec -i $env:PG_CONTAINER psql ... -c $Command
```

Windows PowerShell 5.1 strips embedded double quotes from arguments passed to native programs.
`install-module.ps1` builds the `flow_ids` JSON correctly with `ConvertTo-Json`, but psql receives
it with its quotes gone:

```
ERROR:  invalid input syntax for type json
LINE 2: VALUES ('screenplay', '{VITE_SHOT_BREAKDOWN_ID:ef2aa77c-042a...
DETAIL:  Token "VITE_SHOT_BREAKDOWN_ID" is invalid.
```

This is the final step (recording the module), so by the time it fails the tables exist, the
flows are registered in Flowise, their ids are written to `admin/.env` and the panels are copied.
The module works but is recorded as not installed.

**And it cannot then be re-run.** The module's `schema.sql` has no `IF NOT EXISTS`, so the retry
aborts with `relation "beats" already exists`. If it got past that, it would register a second copy
of every flow in Flowise.

**Fix applied here:** `-Command` is now piped through stdin, as `-File` already was, which is
immune to argument quoting:

```powershell
$Command | docker exec -i $env:PG_CONTAINER psql -U postgres -d $env:PG_DB -v ON_ERROR_STOP=1 -q
```

That fixes every caller, not just this one. The half-installed `screenplay` was completed by
running only its missing registry insert, with the five flow ids already in `admin/.env`.

**Still open:** module installs are not idempotent (schema has no `IF NOT EXISTS`, flows are
re-created rather than looked up by name). Any failure after step 3 leaves a module that has to be
finished or removed by hand.

---

## Smaller things

**`AGENT-SETUP.md` names the wrong Postgres container.**
[Line 126](../install/AGENT-SETUP.md#L126) says "usually `insforge-postgres-1`". InsForge's compose
file names containers after its directory, so on a default clone it is
**`docker-compose-postgres-1`**. Since the value is read from `docker ps` anyway, it is enough to
drop the guess, or say "whatever `docker ps` shows, ending `-postgres-1`".

**`00-insforge.ps1` leaves the console admin on the published default password.**
It generates `JWT_SECRET` and `POSTGRES_PASSWORD`
([lines 82-93](../install/core/00-insforge.ps1#L82-L93)) but not `ROOT_ADMIN_PASSWORD`, which falls
through to the compose default at
`deploy/docker-compose/docker-compose.yml:80-83`:

```yaml
- ROOT_ADMIN_USERNAME=${ROOT_ADMIN_USERNAME:-${ADMIN_EMAIL:-admin}}
- ROOT_ADMIN_PASSWORD=${ROOT_ADMIN_PASSWORD:-${ADMIN_PASSWORD:-change-this-password}}
```

So the dashboard at `:7130` is reachable with `admin` / `change-this-password`. That is the same
reasoning the script already applies to the other two secrets — defensible on an unreachable
machine, indefensible anywhere else — so it seems like an oversight rather than a decision. It
also surprises the operator, who reasonably expects the admin user they were told to create in
step 1 to be the console login; it is not, it is an application user.

**Step 1's human step could be automated.** `AGENT-SETUP.md` asks the operator to copy the anon key
out of the console, but both keys are readable over the admin API once signed in:

```
GET /api/metadata/anon-key
GET /api/metadata/api-key
```

Removing that copy-paste would take two manual values out of the flow.

---

## Not repo bugs, noted so the next person does not chase them

- **`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`** — pnpm wants to confirm before wiping a
  `node_modules` built by a different pnpm version, and cannot prompt without a TTY. Set `CI=true`.
  Only arises after a failed install with a mismatched pnpm, so fixing #3 avoids it.
- **`'run' is not recognized as an internal or external command`** from `pnpm start` — the
  `start:windows` script is `cd packages/server/bin && run start`, which relies on `cmd.exe`
  resolving `run.cmd` from the current directory. That is disabled when
  `NoDefaultCurrentDirectoryInExePath=1` is set in the environment. Not the repo's fault, and not
  set on this machine's user or system environment. `node packages\server\bin\run start` from the
  checkout root works regardless and may be the more robust invocation.
- **`The term 'docker' is not recognized`** when running `install-module.ps1`, after Docker was
  installed successfully and `docker ps` works elsewhere. The installer puts its `bin` on the
  **machine** `PATH`, and an already-open terminal keeps the environment it started with. Close
  the shell and open a new one. Worth a line in `AGENT-SETUP.md` next to the Docker prerequisite,
  since this bites exactly the person who installs Docker and then carries straight on in the
  same window — the same applies to the Node install in step 2.
- **`Security warning ... Do you want to run C:\AIMP\install\install-module.ps1?`**, prompting
  once per script including `lib\common.ps1` mid-run. These are mark-of-the-web flags: 8 of the
  repo's 9 `.ps1` files carried a `Zone.Identifier` stream after being fetched on this machine.
  Clear them once from the repo root:

  ```powershell
  Get-ChildItem -Recurse -Include *.ps1,*.psm1 -File |
      Where-Object { $_.FullName -notmatch '\\node_modules\\' } | Unblock-File
  ```

  The prompt defaults to `[D] Do not run`, so anyone hitting Enter out of habit gets a module
  that reports failure with no obvious cause. A note in `AGENT-SETUP.md` would save that.

---

## What was verified working after the workarounds

| Component | Version | Endpoint |
|---|---|---|
| ComfyUI | 0.34.0, `--enable-cors-header` | `127.0.0.1:8188` |
| InsForge | 4 containers, all healthy | `localhost:7130` |
| Flowise | 3.1.3, uploads patch applied, built | `localhost:3010` |

The uploads patch in `01-flowise.ps1` applied cleanly at its anchor — no drift there on 3.1.3.
