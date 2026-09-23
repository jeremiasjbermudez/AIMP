<#
Shared helpers for the installers.

Everything install-specific lives in install/install.env, written by
core/02-settings.ps1 and read here, so no script holds a URL or a key.
#>

$script:InstallRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$script:RepoRoot = Split-Path -Parent $script:InstallRoot

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Warn([string]$text) { Write-Host "!!  $text" -ForegroundColor Yellow }

<#
Load install.env into the process environment.

Called on import, so every helper below can assume the settings are there and
say plainly which one is missing when it is not.
#>
function Import-InstallEnv {
    $path = Join-Path $script:InstallRoot 'install.env'
    if (-not (Test-Path $path)) {
        throw "install/install.env does not exist yet. Run core\02-settings.ps1 first."
    }
    Get-Content $path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith('#') -or -not $line.Contains('=')) { return }
        $i = $line.IndexOf('=')
        $name = $line.Substring(0, $i).Trim()
        $value = $line.Substring($i + 1).Trim()
        # -WhatIf:$false because a caller running with -WhatIf still has to LOAD
        # its settings: without this the whole dry run fails on the first check,
        # reporting a missing setting that is sitting right there in the file.
        Set-Item -Path "Env:$name" -Value $value -WhatIf:$false -Confirm:$false
    }
    # LLM_* are deliberately not required: an install with no language model is
    # a valid one, and the flows that need it say so at run time rather than
    # blocking the install of everything else.
    foreach ($required in @('PG_CONTAINER', 'PG_DB', 'FLOWISE_URL', 'FLOWISE_API_KEY',
                            'INSFORGE_URL', 'INSFORGE_API_KEY', 'COMFY_URL', 'COMFY_ROOT', 'ADMIN_DIR')) {
        if (-not (Get-Item -Path "Env:$required" -ErrorAction SilentlyContinue)) {
            throw "install.env has no $required. Re-run core\02-settings.ps1."
        }
    }
}
# The settings page runs the installers through a flow, so the flow has to be
# told where they are. Derived rather than asked for: it is this folder.
$env:INSTALL_ROOT = $script:InstallRoot

Import-InstallEnv

# Docker inside WSL, when that is where InsForge runs (DOCKER_WSL_DISTRO).
. (Join-Path $script:InstallRoot 'lib/docker-wsl.ps1')
Enable-DockerThroughWsl $env:DOCKER_WSL_DISTRO

function Get-ModuleMap {
    Get-Content (Join-Path $script:InstallRoot 'modules.json') -Raw | ConvertFrom-Json
}

function Get-ModuleNames($map) {
    $map.PSObject.Properties.Name | Where-Object { -not $_.StartsWith('$') }
}

<#
Run SQL against the database, inside the Postgres container.

-v ON_ERROR_STOP=1 matters: without it psql reports success after a failed
statement, and a module would be recorded as installed with half its tables.
#>
function Invoke-Sql {
    param([string]$File, [string]$Command)
    if ($File) {
        Get-Content $File -Raw | docker exec -i $env:PG_CONTAINER psql -U postgres -d $env:PG_DB -v ON_ERROR_STOP=1 -q
    } else {
        # Piped rather than passed with -c: a multi-line statement survives
        # stdin identically everywhere, while argument quoting does not.
        $Command | docker exec -i $env:PG_CONTAINER psql -U postgres -d $env:PG_DB -v ON_ERROR_STOP=1 -q
    }
    if ($LASTEXITCODE -ne 0) { throw "SQL failed (exit $LASTEXITCODE). Nothing further was applied." }
}

function Get-InstalledModules {
    # Ask whether the registry exists before selecting from it. Selecting from a
    # missing table works, but psql writes to stderr and PowerShell turns that
    # into a NativeCommandError - noise that reads like a failure on a perfectly
    # normal first run, before core has been installed.
    $exists = docker exec -i $env:PG_CONTAINER psql -U postgres -d $env:PG_DB -tAc `
        "SELECT to_regclass('public.installed_modules') IS NOT NULL;"
    if ($LASTEXITCODE -ne 0 -or ($exists | Select-Object -First 1) -ne 't') { return @() }
    $out = docker exec -i $env:PG_CONTAINER psql -U postgres -d $env:PG_DB -tAc `
        "SELECT name FROM public.installed_modules ORDER BY name;"
    if ($LASTEXITCODE -ne 0) { return @() }
    @($out | Where-Object { $_ })
}

<#
Register one flow, from its node source or - for the few whose logic spans
several nodes - from its exported graph.
#>
function Register-Flow {
    param([string]$Name, [string]$Source)
    # The exported graph wins when there is one. It carries every node - seven
    # flows have more than one - and every per-flow variable, including the
    # system prompts. The node source is the readable copy of the same code and
    # is only used when no export exists.
    $export = Join-Path $script:RepoRoot "flowise/flows/$Name.json"
    if (Test-Path $export) {
        $Source = $export
    } elseif (-not (Test-Path $Source)) {
        Write-Warn "  neither an export nor a node source for $Name"
        return $null
    }
    $script = Join-Path $script:InstallRoot 'lib/create-flow.js'
    $output = node $script --name $Name --source $Source 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "  could not register $Name : $($output -join ' ')"
        return $null
    }
    # create-flow.js prints what it did, then the id on the last line. Showing
    # only the id hid whether a flow came from its export or was rebuilt from a
    # source file, which is exactly what someone checking an install wants.
    $lines = @($output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
    foreach ($line in $lines[0..([Math]::Max(0, $lines.Count - 2))]) {
        if ($line -and $line -ne $lines[-1]) { Write-Host "    $line" -ForegroundColor DarkGray }
    }
    $lines[-1]
}

<#
Set values in the admin app's .env, preserving everything else.

An existing key is replaced in place rather than appended, because two lines
with the same name means the app reads whichever Vite saw last - which is a
bug that only shows up as a flow id that is somehow the wrong one.
#>
function Set-EnvValues {
    param([hashtable]$Values)
    $path = Join-Path $env:ADMIN_DIR '.env'
    # NOT `$lines = if (...) { @(...) } else { @() }`. PowerShell unrolls an
    # empty array returned from an if, so on a missing file $lines would be
    # $null; the first += then makes it a String, every later key concatenates
    # onto that one string, and the replace-in-place loop below never matches -
    # so the file comes out malformed AND re-running stops being safe.
    # Declaring the type first is what keeps it an array.
    [string[]]$lines = @()
    if (Test-Path $path) { $lines = @(Get-Content $path) }
    foreach ($key in $Values.Keys) {
        $line = "$key=$($Values[$key])"
        $index = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^\s*$([regex]::Escape($key))\s*=") { $index = $i; break }
        }
        if ($index -ge 0) { $lines[$index] = $line } else { $lines += $line }
    }
    Set-Content -Path $path -Value $lines -Encoding utf8
}

<#
Copy one panel file (or folder) from the module payload into the admin app.

The payload lives in admin-src/ so the repository keeps one copy of each panel
and the installer decides which of them a given install actually has.
#>
function Copy-PanelFile {
    param([string]$Relative)
    $from = Join-Path $script:RepoRoot "admin-src/$Relative"
    $to = Join-Path $env:ADMIN_DIR "src/$Relative"
    if (-not (Test-Path $from)) { Write-Warn "  panel source missing, skipped: $Relative"; return }
    $parent = Split-Path -Parent $to
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    if ((Get-Item $from).PSIsContainer) {
        # Copy-Item of a folder INTO an existing folder of the same name nests
        # it - screenplay/screenplay/ - and the app then imports the outer one,
        # which is empty. Removing the target first is what makes a re-install
        # idempotent rather than one level deeper each time.
        if (Test-Path $to) { Remove-Item $to -Recurse -Force }
        Copy-Item $from $to -Recurse -Force
    } else {
        Copy-Item $from $to -Force
    }
}

<#
Rewrite the admin app's generated tab registry from what is installed.

The app imports only this file, so a tab whose panel was never copied in is
never imported, and the bundle stays as small as the install.
#>
function Update-TabRegistry {
    $node = Join-Path $script:InstallRoot 'lib/write-registry.js'
    $out = node $node 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Warn "  tab registry not regenerated: $($out -join ' ')" }
}

<#
Deploy the InsForge edge functions a module owns.

Edge functions are Deno code InsForge stores and runs itself - not Postgres
functions, and not Flowise flows. They were missed entirely until a clean
install could not create a project, because the button that creates one calls
the create-movie function and nothing had ever deployed it.
#>
function Install-EdgeFunctions {
    param([string]$Module)
    $manifestPath = Join-Path $script:InstallRoot 'functions/functions.json'
    if (-not (Test-Path $manifestPath)) { return }
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $mine = @($manifest | Where-Object { $_.module -eq $Module })
    if (-not $mine.Count) { return }
    $deployer = Join-Path $script:InstallRoot 'lib/deploy-function.js'
    foreach ($fn in $mine) {
        $file = Join-Path $script:InstallRoot "functions/$($fn.file)"
        if (-not (Test-Path $file)) { Write-Warn "  edge function file missing: $($fn.file)"; continue }
        Write-Step "  edge function: $($fn.slug)"
        $out = node $deployer --slug $fn.slug --file $file --name $fn.name --description $fn.description 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Warn "  could not deploy $($fn.slug): $($out -join ' ')" }
        else { Write-Host "    $($out | Select-Object -Last 1)" -ForegroundColor DarkGray }
    }
}
