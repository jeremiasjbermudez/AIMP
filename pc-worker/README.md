# Running everything on the Windows render host

The whole backend can live on the GPU box. You open the app from another machine,
such as a Mac on the same Tailscale network. Flows then read and write ComfyUI's
folders on the same disk, and nothing but the app's port is visible to other machines.

```
Windows render host
  ComfyUI (main)            127.0.0.1:8188  your existing service
  World ComfyUI             127.0.0.1:8195  on demand, HY-World only (venv-world)
  AIMP worker               :8190           starts/stops the world ComfyUI; token-protected
  WSL (Ubuntu) + Docker
    InsForge                127.0.0.1:7130  database, storage, auth
  Flowise (Node 24)         127.0.0.1:3010  flows
  Admin app (Vite)          <tailscale ip>:5185   serves /api, /flowise, /comfy through itself
  Ollama                    127.0.0.1:11434  optional language model
```

Every service runs as a boot-time scheduled task: `AIMP-WSL`, `AIMP-Flowise`,
`AIMP-Worker` and `AIMP-Admin`, next to the existing `ComfyUI-Server`.

## Order

1. **Docker in WSL.** Run `apt install docker.io docker-compose-v2` in the Ubuntu
   distribution, then `systemctl enable --now docker`. No Docker Desktop is needed.
2. **InsForge.** Clone it inside WSL and start it with
   `APP_PORT=127.0.0.1:7130`, as `core\00-insforge.ps1` writes. Then run
   `register-wsl-stack.ps1`. WSL stops its VM when idle and takes the containers with
   it; this task keeps it running.
3. **Flowise.** Run `core\01-flowise.ps1 -NoStart` with **Node 24** first on PATH;
   Flowise cannot start on Node 25. Then run
   `register-flowise.ps1 -Node <node24>\node.exe`.
4. **Settings.** Run `core\02-settings.ps1`. Set `DOCKER_WSL_DISTRO=Ubuntu-24.04` so the
   installers' `docker` commands run inside WSL. Set `COMFY_PYTHON` to ComfyUI's own
   Python, for Face QA. Set `ADMIN_PROXY=1` and `ADMIN_HOST=<tailscale ip>`.
5. **Core and modules.** Run `core\03-core.ps1`, then `install-module.ps1` for each
   module.
6. **Admin app.** Run `register-admin.ps1 -Node <node24>\node.exe`. Open
   `http://<tailscale ip>:5185` from the other machine.
7. **World building.** Only needed for HY-World.
   - Create `venv-world`. Use the same Python as ComfyUI, and torch built for the same
     CUDA.
   - Install ComfyUI's requirements, then `ComfyUI_HYWorld2\requirements.txt`, then
     `world-requirements.txt` here.
   - Build HY-World's native wheels (gsplat fork, pytorch3d) with the CUDA Toolkit
     matching torch's CUDA and the MSVC Build Tools. Build pytorch3d at a short path:
     at the pack's own path, the compiler passes Windows' 260-character limit
     (error C1083).
   - Run `python patch-hyworld2.py <ComfyUI_HYWorld2>`.
   - Run `install-worker.ps1`.

## Why each piece is the way it is

- **The world ComfyUI is separate and on demand.** HY-World pins numpy below what the
  main ComfyUI runs, and needs its own compiled extensions. The machine is set up for
  one GPU server at a time, so the worker unloads the main ComfyUI's models, starts
  the world one, and stops it after 10 idle minutes. Port 8189 was already another
  ComfyUI here; the worker refuses a port it did not start a server on.
- **`world-requirements.txt`** lists what HY-World imports without declaring. Each of
  them failed a world build until it was installed.
- **The app proxies InsForge and Flowise.** Both stay on loopback; only the app's port
  faces the network.
