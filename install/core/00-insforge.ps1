<#
.SYNOPSIS
    Bring up InsForge: Postgres, PostgREST, storage and the console.

.DESCRIPTION
    Four containers from InsForge's own compose file. This clones it if you do
    not have it, generates the two secrets rather than leaving the shipped
    development defaults in place, starts it, and waits until it answers.

    It does NOT create the admin user or read the anon key: both are done once,
    by you, in the console it opens at the end. Those two values go into the
    settings script that follows.

.EXAMPLE
    .\00-insforge.ps1
    .\00-insforge.ps1 -Path D:\insforge -Port 7130
    .\00-insforge.ps1 -Recreate          # stop and start again, keeping the data
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    # Where InsForge lives, or should be cloned to.
    [string]$Path = (Join-Path $HOME 'insforge'),
    # The port the API and console are served on. The rest of the pipeline
    # assumes 7130; change it only if something else already has that port.
    [int]$Port = 7130,
    [switch]$Recreate,
    # Write fresh secrets even though the deployment is already running. Only
    # safe when it holds nothing: it changes the key its data is encrypted with.
    [switch]$RotateSecrets,
    # The console's root admin. The admin app signs in as this.
    [string]$AdminUser = 'admin'
)

$ErrorActionPreference = 'Stop'
function Write-Step([string]$t) { Write-Host "==> $t" -ForegroundColor Cyan }
function Write-Warn([string]$t) { Write-Host "!!  $t" -ForegroundColor Yellow }

# ---------------------------------------------------------------- docker
Write-Step 'Checking Docker'
try { docker version --format '{{.Server.Version}}' | Out-Null }
catch { throw 'Docker is not running. Start Docker Desktop and try again.' }
if ($LASTEXITCODE -ne 0) { throw 'Docker is installed but its daemon is not responding.' }

# ---------------------------------------------------------------- the repo
$composeDir = Join-Path $Path 'deploy/docker-compose'
if (-not (Test-Path (Join-Path $composeDir 'docker-compose.yml'))) {
    Write-Step "Cloning InsForge into $Path"
    if ($PSCmdlet.ShouldProcess($Path, 'git clone insforge')) {
        git clone --depth 1 https://github.com/insforge/insforge.git $Path
        if ($LASTEXITCODE -ne 0) { throw "Could not clone InsForge into $Path." }
    }
} else {
    Write-Host "  using the copy already at $Path" -ForegroundColor DarkGray
}
if (-not (Test-Path (Join-Path $composeDir 'docker-compose.yml'))) {
    throw "No docker-compose.yml under $composeDir. Point -Path at an InsForge checkout."
}

# ---------------------------------------------------------------- secrets
# The compose file defaults to a published development secret. Leaving it is
# fine on a machine nobody else can reach and indefensible anywhere else, so a
# real one is generated on first run and kept afterwards.
$envFile = Join-Path $composeDir '.env'
$alreadyRunning = @(docker ps --filter 'name=insforge' --format '{{.Names}}').Count -gt 0
if (-not (Test-Path $envFile) -and $alreadyRunning -and -not $RotateSecrets) {
    # This deployment is up and has no .env, so it is running on the secrets the
    # compose file defaults to. Writing new ones would change the key its stored
    # data is encrypted with, and that data would stop being readable. Left
    # alone unless asked, loudly.
    Write-Warn 'InsForge is already running without a .env, so it is using the compose defaults.'
    Write-Host '  Those defaults are published, which is fine on a machine nobody else can reach' -ForegroundColor DarkGray
    Write-Host '  and unsafe anywhere else. Generating new secrets now would make the data it has' -ForegroundColor DarkGray
    Write-Host '  already stored unreadable, so they are being left as they are.' -ForegroundColor DarkGray
    Write-Warn "The console's root admin password is also still the published default."
    Write-Host '  Change it in the console before this machine is reachable by anyone else.' -ForegroundColor DarkGray
    Write-Host '  To rotate them on an empty deployment: -RotateSecrets' -ForegroundColor DarkGray
} elseif (-not (Test-Path $envFile)) {
    Write-Step 'Generating secrets'
    function New-Secret {
        $bytes = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        [Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', ''
    }
    # The console's root admin too, not only the two service secrets. Its
    # compose default is the published string 'change-this-password', and
    # generating the other two while leaving that one would be security
    # theatre: the console is the way in to everything else.
    $adminPassword = New-Secret
    $lines = @(
        '# Written by install/core/00-insforge.ps1. Keep it: the stored data is',
        '# encrypted with these, and the admin login is here.',
        "APP_PORT=$Port",
        "JWT_SECRET=$(New-Secret)",
        "POSTGRES_PASSWORD=$(New-Secret)",
        "ROOT_ADMIN_USERNAME=$AdminUser",
        "ROOT_ADMIN_PASSWORD=$adminPassword"
    )
    if ($PSCmdlet.ShouldProcess($envFile, 'write')) {
        Set-Content -Path $envFile -Value $lines -Encoding utf8
        Write-Host '  wrote deploy/docker-compose/.env' -ForegroundColor DarkGray
        Write-Host "  console admin: $AdminUser" -ForegroundColor Green
        Write-Host "  console password: $adminPassword" -ForegroundColor Green
        Write-Warn 'Record those now, and back up that .env. Lose the secrets and the stored data cannot be read.'
    }
} else {
    Write-Host '  keeping the existing .env - secrets unchanged' -ForegroundColor DarkGray
    $existing = Select-String -Path $envFile -Pattern '^APP_PORT=(\d+)' | Select-Object -First 1
    if ($existing) {
        $found = [int]$existing.Matches[0].Groups[1].Value
        if ($found -ne $Port) {
            Write-Warn "That .env publishes port $found, not $Port. Using $found."
            $Port = $found
        }
    }
}

# ---------------------------------------------------------------- start
Push-Location $composeDir
try {
    if ($Recreate) {
        Write-Step 'Stopping the existing containers'
        if ($PSCmdlet.ShouldProcess('compose', 'down')) { docker compose down }
    }
    Write-Step 'Starting InsForge'
    if ($PSCmdlet.ShouldProcess('compose', 'up -d')) {
        docker compose up -d
        if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed. The output above says why.' }
    }
} finally { Pop-Location }

# ---------------------------------------------------------------- wait
if ($PSCmdlet.ShouldProcess('InsForge', 'wait for it to answer')) {
    Write-Step 'Waiting for it to answer'
    $url = "http://localhost:$Port"
    $ready = $false
    foreach ($attempt in 1..60) {
        try {
            Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing | Out-Null
            $ready = $true
            break
        } catch {
            # First start pulls four images and initialises the database, so a
            # refused connection early on is normal rather than a failure.
            Start-Sleep -Seconds 5
        }
    }
    if (-not $ready) {
        Write-Warn "No answer from $url after five minutes."
        Write-Host '  Check: docker compose -f "' + $composeDir + '\docker-compose.yml" logs --tail 50' -ForegroundColor DarkGray
        throw 'InsForge did not come up.'
    }
    Write-Host "  answering on $url" -ForegroundColor Green
}

# ---------------------------------------------------------------- what is next
$pg = (docker ps --filter 'ancestor=ghcr.io/insforge/postgres:v15.13.4' --format '{{.Names}}' | Select-Object -First 1)
if (-not $pg) { $pg = (docker ps --format '{{.Names}}' | Where-Object { $_ -like '*postgres*' } | Select-Object -First 1) }

Write-Host ''
Write-Step 'InsForge is up'
Write-Host "  console            http://localhost:$Port" -ForegroundColor Green
Write-Host "  Postgres container $pg" -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Do this once, in the console:' -ForegroundColor Cyan
Write-Host '  1. sign in as the admin above - it was created from the settings this wrote'
Write-Host '  2. copy the anon key - the browser sends it on every request'
Write-Host '     (it is not readable without signing in, which is why this step is yours)'
Write-Host ''
Write-Host 'Then: .\01-flowise.ps1' -ForegroundColor Cyan
