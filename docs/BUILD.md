# Building the infrastructure

Build order matters: the database first, because everything writes to it; then the render host,
because it takes longest; then the orchestration layer, which needs both; then the browser app,
which needs the flow ids the orchestration layer hands back.

Read [requirements.md](../requirements.md) first. Versions given here are the ones this was built
and run against.

---

## 1. InsForge — database, REST and file storage

InsForge OSS runs as four containers: the app, Postgres, PostgREST and a Deno worker. It gives you
a Postgres database, an auto-generated REST API over it (PostgREST), object storage in buckets,
and an admin console.

```
image                                     role
ghcr.io/insforge/insforge-oss:latest      app + console + storage API
ghcr.io/insforge/postgres:v15.13.4        the database
postgrest/postgrest:v12.2.12              REST over the schema
denoland/deno:alpine-2.0.6                edge functions (unused here)
```

**Install**

1. Install Docker Desktop with the WSL2 backend.
2. Clone InsForge and bring up its deploy compose file. The pipeline expects the API on
   **port 7130**; set that in the compose environment if your copy defaults elsewhere.
3. Open the console, create the admin user, and copy the **anon key** — the browser app uses it
   for every request.

**Create the schema**

```bash
docker exec -i <postgres-container> psql -U postgres -d insforge < insforge/schema.sql
docker exec -i <postgres-container> psql -U postgres -d insforge -c "NOTIFY pgrst, 'reload schema';"
```

That creates all 31 tables, empty, with their indexes, constraints and row-level security. See
[../insforge/README.md](../insforge/README.md) for what the tables hold and how they relate.

**The one thing that will bite you:** PostgREST caches the schema. After any `ALTER TABLE`, run
`NOTIFY pgrst, 'reload schema';` or the new column comes back as "not found in the schema cache"
even though it exists.

**Storage buckets** are created per project by the app, named from the project slug. Nothing to
pre-create.

---

## 2. ComfyUI — the render host

Everything that touches the GPU runs here. Version **0.34.1**.

**Install**

1. Install Python 3.12 and a CUDA 12.8 PyTorch build (`torch 2.11.0+cu128`).
2. Clone ComfyUI and install its requirements.
3. Install the node packs listed in [COMFYUI.md](COMFYUI.md). The pipeline submits graphs using
   85 node classes; a missing pack means the graph is rejected with an unknown-node error and
   nothing renders.
4. Download models per [MODELS.md](MODELS.md) into the folders it names.

**Run it with CORS enabled**, because the browser app reads rendered files straight from
ComfyUI's `/view` endpoint:

```bash
python main.py --enable-cors-header
```

**Conventions the pipeline relies on**

- Output lands under `output/<project-slug>/<feature-folder>/`. Paths are stored in the database
  as `output/...` or `input/...`, relative to the ComfyUI root.
- Graphs are submitted to `POST /prompt` and polled at `GET /history/<prompt_id>`.
- Images to be loaded by a graph must be under `input/`; flows stage anything else there first,
  either by re-uploading it or by reading it back through `/view`.
- Restart ComfyUI after adding a node pack. The pipeline cannot do this for you; a flow submitted
  against a stale process fails on the unknown node.

---

## 3. Flowise — orchestration

Flowise **3.1.3**, on **port 3010**, with one patch.

**The patch.** In `packages/components/nodes/agentflow/CustomFunction/CustomFunction.ts`, the
sandbox given to a custom function is extended with the request's uploads:

```diff
             fileAnnotations: options.postProcessing?.fileAnnotations
+            fileAnnotations: options.postProcessing?.fileAnnotations,
+            uploads: options.uploads
```

Without it, a flow cannot see a file posted alongside the request, and every flow that takes an
uploaded image (a reference, a panorama, a screenplay) fails. Apply it before building.

**Install**

1. Clone Flowise at the 3.1.3 tag, apply the patch above.
2. `pnpm install && pnpm build`, then start it on port 3010.
3. In the UI, create an API key. The admin app sends it as a bearer token.

**Create the flows**

Do not create them by hand. The modular installer does it, one module at a time, and records the
ids where the app expects them:

```powershell
cd install
.\core\02-settings.ps1     # once: URLs, keys, paths
.\core\03-core.ps1         # base tables and a blank admin app
.\install-module.ps1 -Module screenplay
```

See [../install/README.md](../install/README.md). Each module registers only the flows it needs,
so a feature you skip costs nothing.

Under the covers every flow is the same shape — a Start node feeding one Custom Function node
whose body is a file from `flowise/nodes/` — and `install/lib/create-flow.js` builds that, setting
these four values from `install.env` on every flow it creates:

| Value | Used by the flow as |
|---|---|
| InsForge URL and API key | `$insforgeUrl` / `$insforgeApiKey` |
| ComfyUI URL | `$comfyUrl` |
| ComfyUI root path | `$comfyRoot`, e.g. `C:/ComfyUI/` |

A few flows span several nodes rather than one. Those are imported from their exported graph in
`flowise/flows/`, with the same four values written in.

`flowise/scripts/_create_*.js` are the original per-flow creator scripts. They still work and are
kept as a reference, but the installer supersedes them.

---

## 4. The admin app

React and Vite, dev server on **port 5185**.

`install/core/03-core.ps1` does the npm install and writes the service URLs into `admin/.env`.
Three values it cannot know must be filled in by hand: the InsForge anon key, and the admin email
and password you created in the InsForge console. Then:

```bash
cd admin
npm run dev
```

The app starts with **no tabs**. Each module you install copies its panels in and regenerates
`src/modules.generated.tsx`, which is the only place the app learns what exists.

What ends up in `.env`:

| Set by | Values |
|---|---|
| `03-core.ps1` | the InsForge, Flowise and ComfyUI URLs |
| you, by hand | the InsForge anon key, the admin email and password, the Flowise API key |
| each module install | that module's flow ids, about 45 across all of them |

A tab whose flow id is blank still loads; its actions fail with a missing-id error. That is what
an interrupted install looks like, and re-running the module fixes it.

Type-check and build with:

```bash
npx tsc --noEmit -p tsconfig.app.json
npx vite build
```

**Note:** a bare `tsc --noEmit` checks nothing in this project — the project flag is required.

---

## 5. Ollama (optional)

Text work — parsing a screenplay into beats, drafting structure, naming colours — calls an
OpenAI-compatible chat endpoint on port **11434**. Running it on a second machine keeps it off the
GPU doing renders. Point the flows at `http://<host>:11434`. Models are listed in
[MODELS.md](MODELS.md).

---

## Verifying the build

In order, each step proving the layer under it:

1. **Database** — the console lists 31 tables and every one is empty.
2. **ComfyUI** — `GET /object_info/<NodeClass>` returns a definition for a class from each pack
   you installed.
3. **Flowise** — trigger a flow that only reads the database (a listing flow) and confirm JSON
   comes back, not an error.
4. **End to end** — create a project in the admin app, then run one short generation and watch the
   row go `queued → rendering → complete` with a file path written back.

If step 4 stalls at `rendering`, the flow submitted a graph and is waiting on ComfyUI: look at the
ComfyUI console. If it goes straight to `failed`, the message is on the row.
