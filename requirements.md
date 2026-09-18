# Requirements

Everything needed before following [docs/BUILD.md](docs/BUILD.md). The figures are from the
machine this was built and run on; where something is a hard floor rather than a measurement, it
says so.

## Hardware

| | Built and run on | Minimum that is realistic |
|---|---|---|
| GPU | NVIDIA RTX 5090, 34 GB VRAM | 24 GB VRAM |
| System RAM | 64 GB | 32 GB |
| Disk for models | 1.0 TB present, ~290 GB required | 200 GB for the core set only |
| Disk for output | grows without bound; renders, splats and video | 500 GB free, more is better |
| CPU | any modern 8-core | 8 cores |

**VRAM is the real constraint.** The video model runs from a ~20 GB quantised checkpoint and the
3D world trainer holds millions of Gaussians; both were tuned against 34 GB. At 24 GB expect to
drop resolution and frame counts. Below 24 GB, the video and 3D stages are not practical.

A **second machine is optional** and only for text: the language models that write and parse story
structure run on a separate box so they do not contend with the GPU doing renders. Everything
works on one machine if you accept the contention.

## Operating system

Built on **Windows 11 Pro (build 26200)**. Nothing is inherently Windows-only, but be aware:

- Paths are stored absolute and Windows-style in several tables. A move to Linux needs a path pass.
- Two Flowise nodes shell out to Python with a hard-coded interpreter path.
- Docker Desktop with the WSL2 backend hosts the database.

## Runtimes

| Component | Version used | Notes |
|---|---|---|
| Node.js | 24.x (verified 24.19.0) | for Flowise and the admin app. Flowise 3.1.3 declares `"node": "^24"` and refuses 22 and 26 |
| pnpm | 10.26+ (verified 10.26.1) | Flowise's package manager. Its `package.json` declares `"pnpm": "^10.26.0"`; pnpm 9 is refused and 12 blocks native builds |
| npm | 10.x | the admin app |
| Python | 3.12.10 | ComfyUI, and two pipeline tools |
| PyTorch | 2.11.0+cu128 | CUDA 12.8 build |
| CUDA runtime | 12.8 | must match the PyTorch build |
| Docker Desktop | current | for InsForge |
| Git | current | |
| FFmpeg | current, on PATH | video assembly and frame extraction |

## Services and versions

| Service | Version | Port |
|---|---|---|
| ComfyUI | 0.34.1 | 8188 |
| Flowise | 3.1.3 (patched fork, see [docs/BUILD.md](docs/BUILD.md)) | 3010 |
| InsForge OSS | `ghcr.io/insforge/insforge-oss:latest` | 7130 |
| — Postgres | `ghcr.io/insforge/postgres:v15.13.4` | 5432 (internal) |
| — PostgREST | `postgrest/postgrest:v12.2.12` | internal |
| — Deno | `denoland/deno:alpine-2.0.6` | internal |
| admin app (Vite dev server) | — | 5185 |
| Ollama (optional) | current | 11434 |

## Python packages beyond ComfyUI's own

The two pipeline tools that render plates from a Gaussian splat and write camera trajectories
import, on top of ComfyUI's environment:

- `gsplat` — splat rasterisation
- `plyfile` — reading `.ply` splats
- `numpy`, `Pillow` — already present for ComfyUI

## ComfyUI node packs

The pipeline submits graphs that use **85 distinct node classes**. The packs that provide the
non-core ones are listed in [docs/COMFYUI.md](docs/COMFYUI.md) with what each is used for. Install
those before running any flow, or graphs will be rejected with an unknown-node error.

## Models

About **290 GB** is required for a working rebuild: roughly 197 GB of core models (video, image
editing, 3D world generation, vision-language) plus ~93 GB of per-feature extras you can skip if
you do not need that feature. See [docs/MODELS.md](docs/MODELS.md) for the file list, sizes,
sources, and the required-versus-optional split.

## Network

All services are local by default and assume a trusted single-operator machine:

- The database is reachable with an anonymous key and row-level security that is permissive on
  most tables.
- Flowise is protected by a single API key.
- ComfyUI is started with `--enable-cors-header` so the browser app can read rendered files
  directly from its `/view` endpoint.

**None of this is safe to expose to a network.** If you put any of it on one, put authentication
in front of all four services first.
