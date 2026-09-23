<#
.SYNOPSIS
    Install Flowise, patched, and start it on the port this pipeline expects.

.DESCRIPTION
    Clones Flowise at the pinned version, applies the one source change the
    pipeline needs, builds it, and starts it.

    THE PATCH. A Custom Function node cannot see a file posted alongside the
    request unless the sandbox is given the request's uploads. Without it every
    flow that takes an uploaded image - a reference, a panorama, a screenplay -
    fails. It is two lines, and this applies them before building. Skipping the
    build is not an option afterwards: the patch is in TypeScript.

    It does NOT create the API key. That is one click in the Flowise UI, which
    this opens at the end, and the key goes into the settings script that follows.

.EXAMPLE
    .\01-flowise.ps1
    .\01-flowise.ps1 -Path D:\flowise -Port 3010
    .\01-flowise.ps1 -SkipBuild        # already built; just start it
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Path = (Join-Path $HOME 'flowise'),
    # The rest of the pipeline assumes 3010.
    [int]$Port = 3010,
    # The version this was built and run against.
    [string]$Version = 'flowise@3.1.3',
    # What that tag's package.json declares. Not the admin app's floors, which
    # are lower: this is what the Flowise build itself refuses to run without.
    [int]$RequiredNodeMajor = 24,
    [int]$RequiredPnpmMajor = 10,
    [switch]$SkipBuild,
    # Do everything except leave it running.
    [switch]$NoStart,
    # The address Flowise listens on. Loopback by default: the admin app and the
    # installers run on this machine, and a flow can run programs here, so
    # nothing else should be able to reach it. Pass 0.0.0.0 only if another
    # machine really needs to.
    [string]$ListenHost = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'
function Write-Step([string]$t) { Write-Host "==> $t" -ForegroundColor Cyan }
function Write-Warn([string]$t) { Write-Host "!!  $t" -ForegroundColor Yellow }

# ---------------------------------------------------------------- tools
Write-Step 'Checking the tools this needs'
foreach ($tool in 'git', 'node') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH. See requirements.md." }
}
# The pinned tag declares its own floors in package.json. They are higher than
# the admin app's, and the failure if you ignore them is a wall of pnpm output
# rather than a clear message, so they are checked here first.
$nodeMajor = [int](((node --version) -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt $RequiredNodeMajor) {
    throw "Flowise $Version needs Node $RequiredNodeMajor or newer; this is Node $nodeMajor. Install it and re-run."
}

# A pinned pnpm, not whatever is newest. pnpm 12 fails differently here AND
# rewrites pnpm-workspace.yaml on the way, which leaves the checkout worse than
# it found it.
$pnpmOk = $false
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    $have = (pnpm --version).Trim()
    $haveMajor = [int](($have -split '\.')[0])
    if ($haveMajor -eq $RequiredPnpmMajor) { $pnpmOk = $true; Write-Host "  pnpm $have" -ForegroundColor DarkGray }
    else { Write-Warn "pnpm $have is installed, but Flowise $Version wants pnpm $RequiredPnpmMajor." }
}
if (-not $pnpmOk) {
    Write-Step "Installing pnpm@$RequiredPnpmMajor"
    if ($PSCmdlet.ShouldProcess("pnpm@$RequiredPnpmMajor", 'npm install -g')) {
        npm install -g "pnpm@$RequiredPnpmMajor"
        if ($LASTEXITCODE -ne 0) { throw "Could not install pnpm@$RequiredPnpmMajor." }
    }
}

# ---------------------------------------------------------------- the source
if (-not (Test-Path (Join-Path $Path 'package.json'))) {
    Write-Step "Cloning Flowise $Version into $Path"
    if ($PSCmdlet.ShouldProcess($Path, 'git clone')) {
        git clone --depth 1 --branch $Version https://github.com/FlowiseAI/Flowise.git $Path
        if ($LASTEXITCODE -ne 0) {
            throw "Could not clone Flowise at tag '$Version'. Check the tag exists, or pass -Version."
        }
    }
} else {
    Write-Host "  using the checkout already at $Path" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- the patch
$target = Join-Path $Path 'packages/components/nodes/agentflow/CustomFunction/CustomFunction.ts'
if (-not (Test-Path $target)) {
    throw "Cannot find CustomFunction.ts under $Path. Is this a Flowise checkout?"
}
$source = Get-Content $target -Raw
if ($source -match 'uploads:\s*options\.uploads') {
    Write-Host '  patch already applied' -ForegroundColor DarkGray
    $patched = $false
} else {
    $anchor = 'fileAnnotations: options.postProcessing?.fileAnnotations'
    if ($source -notmatch [regex]::Escape($anchor)) {
        throw @'
The line this patch attaches to is not in CustomFunction.ts. That means Flowise
has changed here. Apply it by hand: add `uploads: options.uploads` to the object
that builds the sandbox variables, then re-run with -SkipBuild:false.
'@
    }
    Write-Step 'Applying the uploads patch'
    if ($PSCmdlet.ShouldProcess('CustomFunction.ts', 'patch')) {
        # A comment travels with it so the next person to read this file knows
        # it is deliberate and why.
        $replacement = $anchor + ",`n" +
            "            // Patched for this pipeline: without the request's uploads in the`n" +
            "            // sandbox, a flow cannot see a file posted alongside it.`n" +
            "            uploads: options.uploads"
        Set-Content -Path $target -Value ($source -replace [regex]::Escape($anchor), $replacement) -Encoding utf8
        Write-Host '  patched' -ForegroundColor DarkGray
    }
    $patched = $true
}

# ---------------------------------------------------------------- build
if (-not $SkipBuild) {
    Write-Step 'Installing dependencies and building (this takes several minutes)'
    Push-Location $Path
    try {
        if ($PSCmdlet.ShouldProcess('pnpm install', 'run')) {
            pnpm install
            if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed.' }
        }
        if ($PSCmdlet.ShouldProcess('pnpm build', 'run')) {
            pnpm build
            if ($LASTEXITCODE -ne 0) { throw 'pnpm build failed.' }
        }
    } finally { Pop-Location }
} elseif ($patched) {
    Write-Warn 'The patch was applied but -SkipBuild was passed. It is TypeScript: it does nothing until you build.'
}

# ---------------------------------------------------------------- settings
# Its own .env, so the port and the database location survive restarts and do
# not depend on whoever happens to launch it.
# Flowise reads packages/server/.env, NOT the repository root. Writing the root
# one looks like it worked and changes nothing: the server takes its defaults,
# comes up on 3000 while this script polls 3010, and puts its state in ~/.flowise.
# That was silent until someone went looking for the database.
$envFile = Join-Path $Path 'packages/server/.env'
$dataDir = Join-Path $Path ('data' + $Port)
$wanted = [ordered]@{
    'PORT' = $Port
    'HOST' = $ListenHost
    # Keep the sqlite database beside the checkout rather than in the home
    # directory, so two installs on one machine do not share one database.
    'DATABASE_PATH' = $dataDir
    'APIKEY_PATH' = $dataDir
    'SECRETKEY_PATH' = $dataDir
    'LOG_PATH' = (Join-Path $dataDir 'logs')
    # Flowise refuses outbound requests to private addresses by default, and
    # every service this pipeline talks to is one: the database on localhost,
    # ComfyUI on 127.0.0.1, a local Ollama. Without this every flow fails with
    # "Access to this host is denied by policy" - not at install, but the first
    # time one runs, which is a miserable way to find out.
    'HTTP_SECURITY_CHECK' = 'false'
    # Turning the default list off does not mean allowing everything. These are
    # the cloud metadata endpoints, which are the address a server-side request
    # forgery actually wants, and they stay blocked.
    'HTTP_DENY_LIST' = '169.254.169.254,169.254.169.253,fd00:ec2::254'
    # Node built-ins a flow may require, beyond Flowise's default set (assert,
    # buffer, crypto, events, path, querystring, timers, url, zlib). 22 flows
    # read and write files, and 8 run a program - the module installer behind
    # the settings page, PowerShell file pickers, Python render tools. Without
    # this they fail with "Cannot find module 'child_process'". Same condition
    # as the line above: fine while Flowise is reachable only from this machine.
    'TOOL_FUNCTION_BUILTIN_DEP' = 'child_process,fs'
}
if ($PSCmdlet.ShouldProcess($envFile, 'write settings')) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $envFile) | Out-Null
    # NOT `$lines = if (...) { @(...) } else { @() }`. PowerShell unrolls an
    # empty array returned from an if, so on a missing file $lines is $null,
    # the first += turns it into a String, and every later key concatenates
    # onto that one line. The result is a file Flowise cannot parse and a
    # script that is not safe to run twice.
    [string[]]$lines = @()
    if (Test-Path $envFile) { $lines = @(Get-Content $envFile) }
    foreach ($key in $wanted.Keys) {
        $line = "$key=$($wanted[$key])"
        $at = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^\s*$([regex]::Escape($key))\s*=") { $at = $i; break }
        }
        if ($at -ge 0) { $lines[$at] = $line } else { $lines += $line }
    }
    # No BOM. Set-Content -Encoding utf8 writes one on Windows PowerShell 5.1,
    # and the first key here is PORT: Flowise would read it as "﻿PORT",
    # ignore it, and start on 3000 while everything else looks for 3010.
    [System.IO.File]::WriteAllLines($envFile, $lines)
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    Write-Host "  port $Port, data in $dataDir" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- start
if (-not $NoStart -and $PSCmdlet.ShouldProcess('Flowise', 'start')) {
    Write-Step 'Starting Flowise'
    # Its own window: it is a long-running server, and burying it inside this
    # script would make it die with the install.
    if ($IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop') {
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'pnpm start' -WorkingDirectory $Path -WindowStyle Minimized
    } else {
        # No separate window on macOS/Linux: detach it with nohup and log to
        # the data folder, so it outlives this script and the terminal.
        $log = Join-Path $dataDir 'logs/flowise.out'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
        Start-Process -FilePath 'nohup' -ArgumentList 'pnpm', 'start' -WorkingDirectory $Path `
            -RedirectStandardOutput $log -RedirectStandardError "$log.err"
        Write-Host "  logging to $log" -ForegroundColor DarkGray
    }
    $url = "http://localhost:$Port"
    $ready = $false
    foreach ($attempt in 1..60) {
        Start-Sleep -Seconds 5
        try {
            Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing | Out-Null
            $ready = $true
            break
        } catch { }
    }
    if ($ready) {
        Write-Host "  answering on $url" -ForegroundColor Green
    } else {
        # Before blaming the build, say whether it came up somewhere else. A
        # server answering on 3000 means the settings did not take, which is a
        # different problem from a server that did not start.
        $elsewhere = @()
        foreach ($other in 3000, 8080) {
            if ($other -eq $Port) { continue }
            try {
                Invoke-WebRequest -Uri "http://localhost:$other" -TimeoutSec 2 -UseBasicParsing | Out-Null
                $elsewhere += $other
            } catch { }
        }
        if ($elsewhere.Count) {
            Write-Warn "Flowise is answering on $($elsewhere -join ', ') instead of $Port."
            Write-Host "  That means $envFile was not read. Check it exists and holds PORT=$Port," -ForegroundColor DarkGray
            Write-Host "  then stop that process and re-run this script." -ForegroundColor DarkGray
        } else {
            Write-Warn "No answer from $url after five minutes. Look at the window it opened."
        }
    }
}

Write-Host ''
Write-Step 'Flowise is installed'
Write-Host "  url   http://localhost:$Port" -ForegroundColor Green
Write-Host "  path  $Path" -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Outbound requests to private addresses are allowed, except the cloud' -ForegroundColor DarkGray
Write-Host 'metadata endpoints. The pipeline needs it: every service it calls is local.' -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Do this once, in the Flowise UI:' -ForegroundColor Cyan
Write-Host '  create an API key - the admin app and the installers send it as a bearer token'
Write-Host ''
Write-Host 'Then: .\02-settings.ps1' -ForegroundColor Cyan
