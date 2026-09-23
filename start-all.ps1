<#
.SYNOPSIS
    Start the three services this system runs on: InsForge, ComfyUI and Flowise.

.DESCRIPTION
    For after a reboot. Reads install/install.env, so it starts each service
    where this install put it rather than where one particular machine did.

    Each one is probed first and left alone if it already answers, so running
    this twice never starts a second copy.

    ComfyUI is started with --enable-cors-header. Without it the browser app
    cannot read rendered files from ComfyUI's /view endpoint, and every image
    in the UI comes up blank.

    Flowise is started through node rather than `pnpm start`: its start script
    relies on cmd.exe resolving run.cmd from the current directory, which fails
    wherever NoDefaultCurrentDirectoryInExePath is set.

    The admin app is not started here: cd admin ; npm run dev

.EXAMPLE
    .\start-all.ps1
    .\start-all.ps1 -Restart     # stop ComfyUI and Flowise first, then start all three
    .\start-all.ps1 -Quiet       # no windows for ComfyUI and Flowise
#>
[CmdletBinding()]
param(
    # Stop ComfyUI and Flowise before starting them - after changing Flowise's
    # settings file, or adding a ComfyUI node pack. InsForge is left running.
    [switch]$Restart,
    # Run ComfyUI and Flowise hidden rather than in minimised windows.
    [switch]$Quiet,
    # Keep this window open at the end even when everything came up.
    [switch]$Wait
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSCommandPath

function Write-Step([string]$t) { Write-Host "==> $t" -ForegroundColor Cyan }
function Write-Ok  ([string]$t) { Write-Host "    $t" -ForegroundColor Green }
function Write-Warn([string]$t) { Write-Host "!!  $t" -ForegroundColor Yellow }

# ---------------------------------------------------------------- settings
$envFile = Join-Path $repo 'install/install.env'
if (-not (Test-Path $envFile)) {
    Write-Warn "No install\install.env. Run install\core\02-settings.ps1 first."
    Read-Host 'Press Enter to close'; exit 1
}
$cfg = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim() }
}

# A shortcut or a terminal opened before Docker or Node was installed carries a
# stale PATH; read the current one rather than trusting the inherited copy.
$onWindows = $IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop'
if ($onWindows) {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
    $dockerBin = 'C:\Program Files\Docker\Docker\resources\bin'
    if ((Test-Path $dockerBin) -and $env:Path -notlike "*$dockerBin*") { $env:Path += ";$dockerBin" }
} else {
    # Launched from Finder or a fresh shell, Homebrew may not be on PATH yet.
    foreach ($bin in '/opt/homebrew/bin', '/usr/local/bin') {
        if ((Test-Path $bin) -and $env:PATH -notlike "*$bin*") { $env:PATH = "${bin}:$env:PATH" }
    }
}

$insforgeUrl = if ($cfg.INSFORGE_URL) { $cfg.INSFORGE_URL } else { 'http://localhost:7130' }
$comfyUrl    = if ($cfg.COMFY_URL)    { $cfg.COMFY_URL }    else { 'http://127.0.0.1:8188' }
$flowiseUrl  = if ($cfg.FLOWISE_URL)  { $cfg.FLOWISE_URL }  else { 'http://localhost:3010' }
$comfyRoot   = $cfg.COMFY_ROOT
$flowisePath = if ($cfg.FLOWISE_PATH) { $cfg.FLOWISE_PATH } else { Join-Path $HOME 'flowise' }
$window      = if ($Quiet) { 'Hidden' } else { 'Minimized' }

function Test-Up([string]$url) {
    try { Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing | Out-Null; $true } catch { $false }
}
# Poll until it answers, rather than sleeping a fixed guess.
function Wait-Up([string]$label, [string]$url, [int]$seconds = 180) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Up $url) { Write-Ok "$label up at $url"; return $true }
        Start-Sleep -Seconds 3
    }
    Write-Warn "$label did not answer at $url within $seconds seconds."
    $false
}
# Stop whatever is listening on a URL's port.
function Stop-Listener([string]$url) {
    $port = ([uri]$url).Port
    if (-not $onWindows) {
        @(lsof -ti "tcp:$port" -sTCP:LISTEN 2>$null) | Where-Object { $_ } |
            ForEach-Object { Stop-Process -Id ([int]$_) -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 1
        return
    }
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    foreach ($i in 1..20) {
        if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 250
    }
}

$failed = @()

# ---------------------------------------------------------------- Docker
Write-Step 'Docker'
function Test-Docker {
    try { docker version --format '{{.Server.Version}}' 2>$null | Out-Null; $LASTEXITCODE -eq 0 } catch { $false }
}
$dockerOk = Test-Docker
if ($dockerOk) {
    Write-Ok 'engine running'
} elseif (-not $onWindows) {
    # macOS: Colima if it is installed, otherwise Docker Desktop.
    if (Get-Command colima -ErrorAction SilentlyContinue) {
        Write-Host '    starting Colima' -ForegroundColor DarkGray
        colima start
    } elseif (Test-Path '/Applications/Docker.app') {
        Write-Host '    starting Docker Desktop (the first start takes a minute)' -ForegroundColor DarkGray
        open -a Docker
    }
    $deadline = (Get-Date).AddSeconds(240)
    while (-not $dockerOk -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5; $dockerOk = Test-Docker }
    if ($dockerOk) { Write-Ok 'engine up' } else { Write-Warn 'the Docker engine did not come up'; $failed += 'Docker' }
} else {
    $desktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path $desktop)) { Write-Warn "Docker Desktop is not installed at $desktop"; $failed += 'Docker' }
    else {
        Write-Host '    starting Docker Desktop (the first start takes a minute)' -ForegroundColor DarkGray
        Start-Process $desktop
        $deadline = (Get-Date).AddSeconds(240)
        while (-not $dockerOk -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5; $dockerOk = Test-Docker }
        if ($dockerOk) { Write-Ok 'engine up' } else { Write-Warn 'the Docker engine did not come up'; $failed += 'Docker' }
    }
}

# ---------------------------------------------------------------- InsForge
Write-Step 'InsForge'
if (Test-Up $insforgeUrl) {
    Write-Ok "already up at $insforgeUrl"
} elseif (-not $dockerOk) {
    Write-Warn 'skipped - Docker is not running'; $failed += 'InsForge'
} else {
    # Compose records the folder it was started from on every container, so the
    # database container named in install.env says where InsForge lives.
    $composeDir = $null
    # The labels come back as JSON and are read here, rather than picked out
    # with `index .Config.Labels "..."`: Windows PowerShell 5.1 strips the
    # double quotes from a native command's arguments, and Docker then fails
    # to parse the template.
    if ($cfg.PG_CONTAINER) {
        try {
            $labels = (docker inspect -f '{{json .Config.Labels}}' $cfg.PG_CONTAINER 2>$null) | ConvertFrom-Json
            $composeDir = $labels.'com.docker.compose.project.working_dir'
        } catch { }
    }
    if (-not $composeDir) { $composeDir = Join-Path $HOME 'insforge/deploy/docker-compose' }
    if (-not (Test-Path (Join-Path $composeDir 'docker-compose.yml'))) {
        Write-Warn "no docker-compose.yml in $composeDir"; $failed += 'InsForge'
    } else {
        Push-Location $composeDir
        try { docker compose up -d } finally { Pop-Location }
        if (-not (Wait-Up 'InsForge' $insforgeUrl)) { $failed += 'InsForge' }
    }
}

# ---------------------------------------------------------------- ComfyUI
Write-Step 'ComfyUI'
$comfyHost = ([uri]$comfyUrl).Host
$comfyLocal = @('localhost', '127.0.0.1', '::1') -contains $comfyHost
if ($Restart -and $comfyLocal) { Stop-Listener $comfyUrl }
if (Test-Up "$comfyUrl/system_stats") {
    Write-Ok "already up at $comfyUrl"
} elseif (-not $comfyLocal) {
    # ComfyUI lives on another machine (over Tailscale, say): that machine
    # starts it, and all this can do is say it is not answering.
    Write-Warn "ComfyUI at $comfyUrl is on another machine and is not answering. Start it there."
    $failed += 'ComfyUI'
} elseif (-not $comfyRoot) {
    Write-Warn 'install.env has no COMFY_ROOT'; $failed += 'ComfyUI'
} else {
    $root = $comfyRoot.TrimEnd('/', '\')
    # ComfyUI's own Python: a venv beside it, or the portable build's copy.
    $python = @((Join-Path $root '.venv/Scripts/python.exe'),
                (Join-Path $root 'venv/Scripts/python.exe'),
                (Join-Path (Split-Path -Parent $root) 'python_embeded/python.exe')) |
        Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $python) {
        Write-Warn "no Python environment found for ComfyUI at $root"; $failed += 'ComfyUI'
    } else {
        $port = ([uri]$comfyUrl).Port
        Start-Process -FilePath $python -WorkingDirectory $root -WindowStyle $window `
            -ArgumentList 'main.py', '--enable-cors-header', '--port', $port
        if (-not (Wait-Up 'ComfyUI' "$comfyUrl/system_stats")) { $failed += 'ComfyUI' }
    }
}

# ---------------------------------------------------------------- Claude bridge
# Claude through the Claude Code CLI, for the model picker's "Claude Code (CLI)"
# profiles (bridge/claude-bridge.js). Only where the CLI is installed.
$bridgeUrl = 'http://127.0.0.1:11435'
if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Step 'Claude bridge'
    if (Test-Up "$bridgeUrl/health") {
        Write-Ok "already up at $bridgeUrl"
    } else {
        $bridge = Join-Path $repo 'bridge/claude-bridge.js'
        if ($onWindows) {
            Start-Process -FilePath 'node.exe' -WorkingDirectory $repo -WindowStyle $window -ArgumentList $bridge
        } else {
            $log = Join-Path $repo 'bridge/claude-bridge.log'
            Start-Process -FilePath 'nohup' -WorkingDirectory $repo -ArgumentList 'node', $bridge `
                -RedirectStandardOutput $log -RedirectStandardError (Join-Path $repo 'bridge/claude-bridge.err.log')
        }
        if (-not (Wait-Up 'Claude bridge' "$bridgeUrl/health" 20)) { $failed += 'Claude bridge' }
    }
}

# ---------------------------------------------------------------- Flowise
Write-Step 'Flowise'
if ($Restart) { Stop-Listener $flowiseUrl }
if (Test-Up $flowiseUrl) {
    Write-Ok "already up at $flowiseUrl"
} elseif (-not (Test-Path (Join-Path $flowisePath 'packages/server/bin/run'))) {
    Write-Warn "no built Flowise at $flowisePath"; $failed += 'Flowise'
} else {
    # Its port and security settings come from packages\server\.env, written by
    # install\core\01-flowise.ps1.
    if ($onWindows) {
        Start-Process -FilePath 'node.exe' -WorkingDirectory $flowisePath -WindowStyle $window `
            -ArgumentList 'packages\server\bin\run', 'start'
    } else {
        $log = Join-Path $flowisePath 'flowise.out'
        Start-Process -FilePath 'nohup' -WorkingDirectory $flowisePath `
            -ArgumentList 'node', 'packages/server/bin/run', 'start' `
            -RedirectStandardOutput $log -RedirectStandardError "$log.err"
        Write-Host "    logging to $log" -ForegroundColor DarkGray
    }
    if (-not (Wait-Up 'Flowise' $flowiseUrl)) { $failed += 'Flowise' }
}

# ---------------------------------------------------------------- summary
Write-Host ''
if ($failed.Count -eq 0) {
    Write-Step 'All three are up'
    Write-Host "  InsForge  $insforgeUrl" -ForegroundColor Green
    Write-Host "  ComfyUI   $comfyUrl" -ForegroundColor Green
    Write-Host "  Flowise   $flowiseUrl" -ForegroundColor Green
    Write-Host ''
    Write-Host '  Admin app:  cd admin ; npm run dev' -ForegroundColor DarkGray
} else {
    Write-Warn ('Did not come up: ' + ($failed -join ', '))
    Write-Host '  Run this from a terminal to see why, or look at the windows it opened.' -ForegroundColor DarkGray
}
if (($Wait -or $failed.Count) -and $onWindows) { Write-Host ''; Read-Host 'Press Enter to close' }
