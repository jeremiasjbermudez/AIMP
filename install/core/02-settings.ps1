<#
.SYNOPSIS
    Ask for this install's settings once and write install/install.env.

.DESCRIPTION
    Every other script reads install.env, so this is the only place a URL, a
    key or a path is entered. Run it first, and again whenever something moves
    or a key is rotated.

    install.env is git-ignored. It holds real keys.

.EXAMPLE
    .\02-settings.ps1
    .\02-settings.ps1 -NonInteractive   # keep existing values, fill gaps with defaults
#>
[CmdletBinding()]
param([switch]$NonInteractive)

$ErrorActionPreference = 'Stop'
$installRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$repoRoot = Split-Path -Parent $installRoot
$envPath = Join-Path $installRoot 'install.env'

# Existing values are the defaults, so re-running only changes what you retype.
$current = @{}
if (Test-Path $envPath) {
    Get-Content $envPath | ForEach-Object {
        if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $current[$Matches[1]] = $Matches[2] }
    }
}

function Ask([string]$name, [string]$prompt, [string]$default) {
    $existing = $current[$name]
    $fallback = if ($existing) { $existing } else { $default }
    if ($NonInteractive) { return $fallback }
    $shown = if ($name -match 'KEY|PASSWORD') { if ($fallback) { '(unchanged)' } else { '(none)' } } else { $fallback }
    $answer = Read-Host "$prompt [$shown]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $fallback }
    $answer.Trim()
}

Write-Host "Settings for this install. Enter accepts the value in brackets." -ForegroundColor Cyan
Write-Host ""

$settings = [ordered]@{}
Write-Host "-- Database (InsForge) --" -ForegroundColor Cyan
# Docker inside WSL rather than on Windows: name the distribution, and every
# docker command the installers run goes there. Blank when docker is on PATH.
. (Join-Path $installRoot 'lib/docker-wsl.ps1')
$wslDefault = if (-not (Get-Command docker -ErrorAction SilentlyContinue) -and (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { 'Ubuntu-24.04' } else { '' }
$settings.DOCKER_WSL_DISTRO = Ask 'DOCKER_WSL_DISTRO' 'WSL distribution Docker runs in (blank if docker is on PATH)' $wslDefault
Enable-DockerThroughWsl $settings.DOCKER_WSL_DISTRO
# Read from Docker, not guessed: InsForge's compose names containers after the
# directory it was cloned into, so the name differs per install.
$pgGuess = @(docker ps --format '{{.Names}}' 2>$null | Where-Object { $_ -like '*postgres*' })[0]
if (-not $pgGuess) { $pgGuess = 'insforge-postgres-1' }
$settings.PG_CONTAINER    = Ask 'PG_CONTAINER'    'Postgres container name' $pgGuess
$settings.PG_DB           = Ask 'PG_DB'           'Database name' 'insforge'
$settings.INSFORGE_URL    = Ask 'INSFORGE_URL'    'InsForge API URL' 'http://localhost:7130'
$settings.INSFORGE_API_KEY = Ask 'INSFORGE_API_KEY' 'InsForge service API key (from its console)' ''

Write-Host ""
Write-Host "-- Orchestration (Flowise) --" -ForegroundColor Cyan
$settings.FLOWISE_URL     = Ask 'FLOWISE_URL'     'Flowise URL' 'http://localhost:3010'
$settings.FLOWISE_API_KEY = Ask 'FLOWISE_API_KEY' 'Flowise API key' ''
# Where it is installed, not just where it answers: start-all.ps1 needs the
# folder to launch it from.
$settings.FLOWISE_PATH    = Ask 'FLOWISE_PATH'    'Flowise folder on disk' (Join-Path $HOME 'flowise')

Write-Host ""
Write-Host "-- Render host (ComfyUI) --" -ForegroundColor Cyan
$settings.COMFY_URL       = Ask 'COMFY_URL'       'ComfyUI URL' 'http://127.0.0.1:8188'
$settings.COMFY_ROOT      = Ask 'COMFY_ROOT'      'ComfyUI root folder, with a trailing slash' 'C:/ComfyUI/'

Write-Host ""
Write-Host "-- Admin app --" -ForegroundColor Cyan
$settings.ADMIN_DIR       = Ask 'ADMIN_DIR'       'Admin app folder' (Join-Path $repoRoot 'admin')

Write-Host ""
Write-Host "-- Language model --" -ForegroundColor Cyan
Write-Host "  Used for story work: parsing a script into beats, drafting, naming colours." -ForegroundColor DarkGray
Write-Host "  'ollama' is a local Ollama. 'openai' is anything speaking the OpenAI" -ForegroundColor DarkGray
Write-Host "  chat-completions API: OpenAI, OpenRouter, Together, vLLM, LM Studio." -ForegroundColor DarkGray
$settings.LLM_PROVIDER    = Ask 'LLM_PROVIDER'    'Provider (ollama / openai)' 'ollama'
if ($settings.LLM_PROVIDER -eq 'ollama') {
    $settings.LLM_URL     = Ask 'LLM_URL'         'Ollama URL' 'http://localhost:11434'
    $settings.LLM_MODEL   = Ask 'LLM_MODEL'       'Model name' 'qwen3:8b'
    $settings.LLM_API_KEY = ''
} else {
    $settings.LLM_URL     = Ask 'LLM_URL'         'API base URL, no trailing path' 'https://api.openai.com'
    $settings.LLM_MODEL   = Ask 'LLM_MODEL'       'Model name' 'gpt-4o-mini'
    $settings.LLM_API_KEY = Ask 'LLM_API_KEY'     'API key' ''
}

$lines = @(
    '# Written by install/core/02-settings.ps1.',
    '# Real keys live here. It is git-ignored; do not commit it.',
    ''
)
foreach ($k in $settings.Keys) { $lines += "$k=$($settings[$k])" }
Set-Content -Path $envPath -Value $lines -Encoding utf8

Write-Host ""
Write-Host "Wrote $envPath" -ForegroundColor Green

# A setting that is wrong is worth finding now rather than halfway through a
# module install, so each service is poked once.
Write-Host ""
Write-Host "Checking what answers:" -ForegroundColor Cyan
function Probe([string]$label, [scriptblock]$test) {
    try { & $test; Write-Host "  ok       $label" -ForegroundColor Green }
    catch { Write-Host "  NOT YET  $label - $($_.Exception.Message.Split([Environment]::NewLine)[0])" -ForegroundColor Yellow }
}
Probe "Postgres ($($settings.PG_CONTAINER))" {
    docker exec -i $settings.PG_CONTAINER psql -U postgres -d $settings.PG_DB -tAc 'SELECT 1;' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'container not running, or the name is wrong' }
}
Probe "InsForge ($($settings.INSFORGE_URL))" { Invoke-RestMethod -Uri $settings.INSFORGE_URL -TimeoutSec 5 | Out-Null }
Probe "Flowise ($($settings.FLOWISE_URL))" {
    Invoke-RestMethod -Uri "$($settings.FLOWISE_URL)/api/v1/chatflows" -TimeoutSec 5 `
        -Headers @{ Authorization = "Bearer $($settings.FLOWISE_API_KEY)" } | Out-Null
}
Probe "ComfyUI ($($settings.COMFY_URL))" { Invoke-RestMethod -Uri "$($settings.COMFY_URL)/system_stats" -TimeoutSec 5 | Out-Null }
if ($settings.LLM_URL) {
    if ($settings.LLM_PROVIDER -eq 'ollama') {
        Probe "Ollama ($($settings.LLM_URL))" { Invoke-RestMethod -Uri "$($settings.LLM_URL)/api/tags" -TimeoutSec 5 | Out-Null }
    } else {
        # A models listing is the one route every OpenAI-compatible server has,
        # and it proves the key as well as the address.
        Probe "Language model API ($($settings.LLM_URL))" {
            $h = @{}
            if ($settings.LLM_API_KEY) { $h['Authorization'] = "Bearer $($settings.LLM_API_KEY)" }
            Invoke-RestMethod -Uri "$($settings.LLM_URL)/v1/models" -Headers $h -TimeoutSec 8 | Out-Null
        }
    }
} else {
    Write-Host '  skipped   language model - story features will report it is unconfigured' -ForegroundColor DarkGray
}

Write-Host ""
# Flowise refusing to call a private address does not show up until a flow runs,
# and then it appears from inside the flow with no hint of where it came from.
if ($settings.FLOWISE_PATH) {
    $flowiseEnvPath = Join-Path $settings.FLOWISE_PATH 'packages/server/.env'
    if (Test-Path $flowiseEnvPath) {
        $flowiseEnv = Get-Content $flowiseEnvPath -Raw
        if ($flowiseEnv -match '(?m)^HTTP_SECURITY_CHECK\s*=\s*false') {
            Write-Host "  ok       Flowise may reach this machine's own services" -ForegroundColor Green
        } else {
            Write-Host "  NOT YET  Flowise blocks requests to private addresses" -ForegroundColor Yellow
            Write-Host "           Every service here is one, so every flow would fail when it runs." -ForegroundColor DarkGray
            Write-Host "           Re-run core\01-flowise.ps1, which writes both of these, or add" -ForegroundColor DarkGray
            Write-Host "           them to $flowiseEnvPath and restart Flowise:" -ForegroundColor DarkGray
            Write-Host "             HTTP_SECURITY_CHECK=false" -ForegroundColor DarkGray
            Write-Host "             HTTP_DENY_LIST=169.254.169.254,169.254.169.253,fd00:ec2::254" -ForegroundColor DarkGray
        }
    }
}

Write-Host "Next: .\03-core.ps1" -ForegroundColor Cyan
