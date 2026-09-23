# Flows

Every server-side step of the pipeline is a Flowise flow. Their code lives here.

```
nodes/            one file per code step - the only copy anyone edits
lib/              code shared between steps, pulled in with `// @include <name>`
flows/            the exported graphs the installer registers, generated from nodes/
flows/_sources.json   which node file is which step of which flow
build.js          writes flows/ from nodes/ and lib/
```

## Changing a flow

1. Edit its file in `nodes/` (or the shared code in `lib/`).
2. Run `node flowise/build.js`. It rewrites the steps in `flows/*.json` that changed.
3. Re-install the module, or register just that flow:
   `pwsh -Command ". install/lib/common.ps1; Register-Flow -Name <flow> -Source x"`

`node flowise/build.js --check` changes nothing and exits 1 if any export is out of
date or any code step has no source. The installer also rebuilds each step from its
source as it registers a flow, so a forgotten build cannot install stale code.

## Shared code

A Custom Function runs in a sandbox that can load Node built-ins and a few packages,
not a file of ours. So shared code is inlined: a source line of exactly

```js
// @include llm
```

is replaced by `lib/llm.js` when the flow is built. The inlined block is marked, so
it is clear in Flowise's editor where it came from and that it is not edited there.

| Include | What it is |
|---|---|
| `llm` | the language-model shim: reads the model picker's choice, talks to Ollama or any OpenAI-compatible API (including the Claude Code bridge) |
| `comfy_world` | `worldComfyUrl()`: the address of the ComfyUI that runs HY-World graphs - the on-demand one the render host's worker starts, or the main one when no worker is configured |
| `comfy_models` | `pickModel(folder, [candidates])`: the first of several equivalent model files this ComfyUI has, so a graph runs on a render host holding another precision or folder layout |

## Flows that run other flows

Refer to another flow by name, never by id: `'{{flow:26-Image-Edit}}'`. The installer
replaces it with the id that flow has on this install, and refuses to register the
flow if the one it names is not installed. Call it through `$flowiseUrl` with
`$flowiseApiKey`.

## A flow's project

A flow that works on a project takes it explicitly: `--movie <id>` on a text input,
`movieId` in a JSON one. The app sends it. Falling back to `movies.is_active` is only
for runs with no project given, such as a script.
