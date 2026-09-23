<#
.SYNOPSIS
    Install AIMP's worker on the render host, as a task that starts at boot.

.DESCRIPTION
    The worker (aimp_worker.py) does, on request from Flowise, what has to happen
    on this machine: for now, starting the on-demand world ComfyUI that runs
    HY-World graphs in their own Python environment, and stopping it when idle.

    Run this ON the render host, once. It copies the worker into -InstallDir,
    writes its config (generating a token the first time), registers the
    AIMP-Worker scheduled task - boot trigger, as this user, the way the main
    ComfyUI service is registered - and starts it.

    Put the printed WORKER_URL and WORKER_TOKEN into install/install.env on the
    machine that runs Flowise, then re-install the world module there.

.EXAMPLE
    .\install-worker.ps1
    .\install-worker.ps1 -WorldPython D:\venv-world\Scripts\python.exe -PublicHost gpu-box
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$InstallDir   = 'C:\ComfyUI-server\aimp-worker',
    # Any Python 3.9+ runs the worker; it uses the standard library only.
    [string]$Python       = (Get-Command python -ErrorAction Stop).Source,
    [int]$Port            = 8190,
    [string]$MainComfy    = 'http://127.0.0.1:8188',
    # The world ComfyUI: its own environment, the shared ComfyUI code, models,
    # inputs and outputs, and only the node packs HY-World graphs use.
    [string]$WorldPython  = 'C:\ComfyUI-server\venv-world\Scripts\python.exe',
    [string]$ComfyMain    = 'C:\ComfyUI-server\ComfyUI-0.37.0\main.py',
    [string]$BaseDir      = 'C:\Users\alexk\ComfyUI',
    [string]$ModelPaths   = 'C:\ComfyUI-server\model_paths.yaml',
    # Not 8188-8189: those are commonly other ComfyUI instances.
    [int]$WorldPort       = 8195,
    # The name other machines reach this one by (the Tailscale name, say).
    [string]$PublicHost   = $env:COMPUTERNAME.ToLower(),
    [int]$IdleMinutes     = 10,
    [string[]]$WorldPacks = @('ComfyUI_HYWorld2', 'comfyui-various', 'comfyui-rename-file', 'ComfyUI-VideoHelperSuite'),
    # Blender sets (blender/ in the repository). Leave -BlenderExe empty to skip.
    [string]$BlenderExe   = 'C:\ComfyUI-server\blender-4.5.9\blender.exe',
    [string]$SetsRoot     = 'C:\Users\alexk\ComfyUI\input\sets',
    # A Python with numpy and Pillow, for the tech-scout sheet: ComfyUI's own.
    [string]$ScoutPython  = 'C:\ComfyUI-server\daisy-v2\venv\Scripts\python.exe'
)
$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'aimp_worker.py') $InstallDir -Force

$configPath = Join-Path $InstallDir 'aimp-worker.json'
$token = $null
if (Test-Path $configPath) {
    # Keep the token, so a re-install does not break the install.env that has it.
    $token = (Get-Content $configPath -Raw | ConvertFrom-Json).token
}
if (-not $token) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', ''
}

$logs = Split-Path -Parent $ComfyMain | Split-Path -Parent | Join-Path -ChildPath 'logs'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
$config = [ordered]@{
    port       = $Port
    token      = $token
    main_comfy = $MainComfy
    world      = [ordered]@{
        python       = $WorldPython
        port         = $WorldPort
        public_host  = $PublicHost
        idle_minutes = $IdleMinutes
        log          = (Join-Path $logs 'world-comfy.log')
        args         = @(
            '-s', $ComfyMain,
            '--base-directory', $BaseDir,
            # Its own settings and temp, so two ComfyUIs never write the same files.
            '--user-directory', (Join-Path $BaseDir 'user-world'),
            '--temp-directory', (Join-Path (Split-Path -Parent (Split-Path -Parent $ComfyMain)) "temp-$WorldPort"),
            # The same inputs and outputs: a panorama the main ComfyUI made is
            # what a world is built from, and the splat lands where the app looks.
            '--input-directory', (Join-Path $BaseDir 'input'),
            '--output-directory', (Join-Path $BaseDir 'output'),
            '--extra-model-paths-config', $ModelPaths,
            '--port', "$WorldPort", '--listen',
            '--disable-comfy-compiler',
            '--disable-all-custom-nodes', '--whitelist-custom-nodes') + $WorldPacks
    }
}
if ($BlenderExe -and (Test-Path $BlenderExe)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $SetsRoot 'locations'), (Join-Path $SetsRoot 'shots') | Out-Null
    $config.blender = [ordered]@{
        exe          = $BlenderExe
        scripts      = (Join-Path $repoRoot 'blender')
        sets_root    = $SetsRoot
        scout_python = $ScoutPython
    }
}
if ($PSCmdlet.ShouldProcess($configPath, 'write')) {
    [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5))
    # ComfyUI refuses a --user-directory that does not exist yet.
    New-Item -ItemType Directory -Force -Path (Join-Path $BaseDir 'user-world') | Out-Null
    # HY-World's WorldStereo loads its text encoder with ComfyUI's own code, and
    # looks for it as <base directory>\comfy. With the code kept apart from the
    # data (--base-directory), it is not there and the loader stops with "Could
    # not locate ComfyUI root". A junction to the code's comfy package fixes
    # that without touching the pack; the main ComfyUI still imports comfy from
    # its own code folder, which comes first on its path.
    $comfyPkg = Join-Path (Split-Path -Parent $ComfyMain) 'comfy'
    $link = Join-Path $BaseDir 'comfy'
    if (-not (Test-Path $link) -and (Test-Path $comfyPkg)) {
        New-Item -ItemType Junction -Path $link -Target $comfyPkg | Out-Null
    }
}

# Registered like ComfyUI-Server: at boot, as this user, without a window.
$taskName = 'AIMP-Worker'
$action = New-ScheduledTaskAction -Execute $Python -Argument "`"$(Join-Path $InstallDir 'aimp_worker.py')`"" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
if ($PSCmdlet.ShouldProcess($taskName, 'register and start')) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $taskName
}

Write-Host ''
Write-Host "AIMP worker installed and started on port $Port." -ForegroundColor Green
Write-Host 'Put these in install/install.env on the Flowise machine, then re-install the world module:' -ForegroundColor Cyan
Write-Host "  WORKER_URL=http://${PublicHost}:$Port"
Write-Host "  WORKER_TOKEN=$token"
