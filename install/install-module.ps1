<#
.SYNOPSIS
    Install one module: its tables, its flows, its admin tabs.

.DESCRIPTION
    Reads install/modules.json, which is the only place that decides what a
    module owns. For the named module it:

      1. checks the modules it depends on are already installed
      2. warns about ComfyUI node packs that are missing
      3. applies its schema.sql to the database
      4. registers its Flowise flows and writes their ids into admin/.env
      5. copies its admin panels into the app and regenerates the tab registry
      6. records the install in the installed_modules table

    Safe to run twice: the schema is written to be replayable, a flow with the
    same name is updated rather than duplicated, and the registry row is upserted.

.EXAMPLE
    .\install-module.ps1 -Module screenplay
    .\install-module.ps1 -Module world -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$Module,
    # Skip the dependency check entirely. For repairing an install, not for
    # normal use.
    [switch]$Force,
    # Refuse rather than installing what this module needs. The default is to
    # install them, because a dependency is not a decision - it is the module
    # not working without it.
    [switch]$NoDeps,
    # Do not start downloading the module's ComfyUI models and node packs.
    # The default is to start it, in its own window, once the install is done.
    [switch]$NoAssets
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
$repo = Split-Path -Parent $root

. (Join-Path $root 'lib\common.ps1')

$map = Get-ModuleMap
if (-not $map.PSObject.Properties.Name.Contains($Module)) {
    throw "No module called '$Module'. Known: $((Get-ModuleNames $map) -join ', ')"
}
$spec = $map.$Module
Write-Step "Installing $($spec.title)"
Write-Host $spec.summary -ForegroundColor DarkGray

# ---------------------------------------------------------------- 1. dependencies
$installed = Get-InstalledModules

<#
Everything $Module needs, deepest first.

Walks the whole chain rather than one level, so installing a module that needs
one that needs another arrives in the right order without being asked twice.
#>
function Resolve-Needs {
    param([string]$Name, [System.Collections.Generic.List[string]]$Order, [hashtable]$Seen)
    if ($Seen.ContainsKey($Name)) { return }
    $Seen[$Name] = $true
    foreach ($need in @($map.$Name.needs)) {
        if (-not $need -or $need -eq 'core') { continue }
        Resolve-Needs -Name $need -Order $Order -Seen $Seen
        if (-not $Order.Contains($need)) { $Order.Add($need) }
    }
}

$chain = [System.Collections.Generic.List[string]]::new()
Resolve-Needs -Name $Module -Order $chain -Seen @{}
$toAdd = @($chain | Where-Object { $installed -notcontains $_ })

if ($installed -notcontains 'core') {
    if ($Force) { Write-Warn "core is not installed. Continuing because -Force." }
    else { throw "core is not installed. Run: .\core\03-core.ps1" }
}

if ($toAdd.Count) {
    if ($NoDeps) {
        throw "$Module needs $($toAdd -join ', '), which $(if ($toAdd.Count -eq 1) {'is'} else {'are'}) not installed. Install $(if ($toAdd.Count -eq 1) {'it'} else {'them'}) first, or drop -NoDeps."
    }
    Write-Step "$Module needs $($toAdd -join ', '); installing $(if ($toAdd.Count -eq 1) {'it'} else {'them'}) first"
    foreach ($need in $toAdd) {
        # Each one goes through this same script, so a dependency is installed
        # exactly the way it would be on its own - its flows, its panels, its
        # registry row - rather than by some lesser path that only half does it.
        # -NoAssets: the outermost install fetches everything in one window,
        # rather than each dependency opening its own.
        & $PSCommandPath -Module $need -NoAssets -WhatIf:$WhatIfPreference
        if ($LASTEXITCODE -gt 0) { throw "Stopped: '$need' did not install." }
    }
    $installed = Get-InstalledModules
    Write-Step "Back to $($spec.title)"
}
foreach ($opt in @($spec.optional)) {
    if ($opt -and $installed -notcontains $opt) {
        Write-Host "  optional: '$opt' is not installed; the parts that use it will fall back." -ForegroundColor DarkGray
    }
}

# ---------------------------------------------------------------- 2. node packs
$missingPacks = @()
foreach ($pack in @($spec.packs)) {
    if ($pack -and -not (Test-Path (Join-Path $env:COMFY_ROOT "custom_nodes\$pack"))) { $missingPacks += $pack }
}
if ($missingPacks.Count) {
    Write-Warn "ComfyUI node packs not found: $($missingPacks -join ', ')"
    Write-Host "  Fetch them with:  .\fetch-assets.ps1 -Module $Module" -ForegroundColor DarkGray
    Write-Host "  Restart ComfyUI afterwards, or this module's renders will be rejected." -ForegroundColor DarkGray
}
# Which model files this module's graphs actually load, and whether they are
# here. Without this the module installs clean and fails at the first render
# with ComfyUI's own message, which names a file but not the module that wanted
# it - and a missing model is the single most common reason a fresh install
# cannot render anything.
$modelFiles = @($spec.modelFiles)
if ($modelFiles.Count) {
    $modelRoot = Join-Path $env:COMFY_ROOT 'models'
    $present = @{}
    if (Test-Path $modelRoot) {
        # One walk, then a lookup per file: these folders hold thousands of
        # files and a search each would be slow enough to notice.
        Get-ChildItem $modelRoot -Recurse -File -ErrorAction SilentlyContinue |
            ForEach-Object { $present[$_.Name.ToLower()] = $true }
    }
    $missing = @($modelFiles | Where-Object { -not $present[([System.IO.Path]::GetFileName($_)).ToLower()] })
    if ($missing.Count) {
        Write-Warn "$($missing.Count) of $($modelFiles.Count) model file(s) are not under $modelRoot :"
        foreach ($m in $missing) { Write-Host "    - $m" -ForegroundColor DarkGray }
        Write-Host "  The module installs anyway; renders that need these will be rejected by" -ForegroundColor DarkGray
        Write-Host "  ComfyUI until they are there. To fetch what can be fetched:" -ForegroundColor DarkGray
        Write-Host "    .\fetch-assets.ps1 -Module $Module" -ForegroundColor DarkGray
    } else {
        Write-Host "  All $($modelFiles.Count) model file(s) this module loads are present." -ForegroundColor DarkGray
    }
} elseif (@($spec.models).Count) {
    Write-Host "  Models this module loads:" -ForegroundColor DarkGray
    foreach ($m in $spec.models) { Write-Host "    - $m" -ForegroundColor DarkGray }
    Write-Host "  See docs/MODELS.md for the files and where they go." -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 3. schema
$moduleDir = Join-Path $root "modules\$Module"
foreach ($sql in @('prelude.sql', 'registry.sql', 'settings.sql', 'schema.sql')) {
    $path = Join-Path $moduleDir $sql
    if (Test-Path $path) {
        if ($PSCmdlet.ShouldProcess($sql, 'apply to database')) {
            Write-Step "  schema: $sql"
            Invoke-Sql -File $path
        }
    }
}
# A module already installed may have a foreign key into this one that was
# skipped because this one did not exist yet - a rendered clip and the shot it
# came from point at each other, so whichever is installed second has to close
# the loop. Re-applying that module's schema does it, and costs nothing because
# the schemas are idempotent.
foreach ($other in (Get-ModuleNames $map)) {
    if ($other -eq $Module -or $installed -notcontains $other) { continue }
    if (@($map.$other.linksTo) -notcontains $Module) { continue }
    $otherSchema = Join-Path $root "modules\$other\schema.sql"
    if (-not (Test-Path $otherSchema)) { continue }
    if ($PSCmdlet.ShouldProcess($other, 'add the foreign keys it was waiting for')) {
        Write-Step "  linking $other to $Module"
        Invoke-Sql -File $otherSchema
    }
}

if ($PSCmdlet.ShouldProcess('PostgREST', 'reload schema cache')) { Invoke-Sql -Command "NOTIFY pgrst, 'reload schema';" }

# ---------------------------------------------------------------- 3b. edge functions
if ($PSCmdlet.ShouldProcess($Module, 'deploy its InsForge edge functions')) {
    Install-EdgeFunctions -Module $Module
}

# ---------------------------------------------------------------- 4. flows
$flowIds = @{}
foreach ($flow in @($spec.flows)) {
    # Each flow carries its own name and its own .env variable, so nothing
    # depends on two lists staying the same length and in the same order.
    #
    # Register-Flow installs from the flow's COMPLETE EXPORTED GRAPH in
    # flowise/flows/, which is what carries its own variables - the writer's
    # system prompt, the kind that separates image-to-video from text-to-video -
    # and every node of the seven flows that have more than one. The node file
    # named here is the readable copy of the same code and is only used when no
    # export exists.
    $source = Join-Path $repo "flowise\nodes\$($flow.source)"
    if ($PSCmdlet.ShouldProcess($flow.name, 'register Flowise flow')) {
        Write-Step "  flow: $($flow.name)"
        $id = Register-Flow -Name $flow.name -Source $source
        if ($id -and $flow.env) { $flowIds[$flow.env] = $id }
    }
}
if ($flowIds.Count -and $PSCmdlet.ShouldProcess('admin/.env', 'write flow ids')) {
    Set-EnvValues -Values $flowIds
    Write-Host "  wrote $($flowIds.Count) flow id(s) into admin/.env" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 5. admin panels
$tabs = @()
foreach ($panel in @($spec.panels)) {
    if ($panel.tab) { $tabs += $panel.tab }
    foreach ($file in @($panel.files)) {
        if ($PSCmdlet.ShouldProcess($file, 'copy into the admin app')) { Copy-PanelFile -Relative $file }
    }
}
if ($tabs.Count -and $PSCmdlet.ShouldProcess('admin tab registry', 'regenerate')) {
    Update-TabRegistry
    Write-Host "  tabs now available: $($tabs -join ', ')" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 6. record it
if ($PSCmdlet.ShouldProcess($Module, 'record in installed_modules')) {
    $json = ($flowIds | ConvertTo-Json -Compress)
    if (-not $json) { $json = '{}' }
    $tabList = if ($tabs.Count) { "ARRAY['" + ($tabs -join "','") + "']" } else { "ARRAY[]::text[]" }
    Invoke-Sql -Command @"
INSERT INTO public.installed_modules (name, flow_ids, tabs)
VALUES ('$Module', '$($json -replace "'", "''")'::jsonb, $tabList)
ON CONFLICT (name) DO UPDATE
   SET flow_ids = EXCLUDED.flow_ids, tabs = EXCLUDED.tabs, installed_at = now();
"@
}

if ($toAdd.Count) { Write-Step "$($spec.title) installed, along with $($toAdd -join ', ')" }
else { Write-Step "$($spec.title) installed" }
if ($tabs.Count) { Write-Host "Restart the admin dev server to see: $($tabs -join ', ')" -ForegroundColor Green }

# ---------------------------------------------------------------- 7. models and node packs
# Started, not awaited. The models run to tens of gigabytes: waiting would hold
# a terminal for an hour, and an install started from the settings page runs
# inside a Flowise request that would time out long before. So it gets its own
# window, which shows progress and stays open with the result. fetch-assets.ps1
# skips anything already present, so re-installing costs nothing here.
$fetchFor = @(@($toAdd) + $Module | Where-Object { $_ } | Select-Object -Unique |
    Where-Object { @($map.$_.modelFiles).Count -or @($map.$_.packs).Count })
if ($fetchFor.Count -and -not $NoAssets -and -not $WhatIfPreference) {
    $fetch = Join-Path $root 'fetch-assets.ps1'
    $logDir = Join-Path $root 'logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $log = Join-Path $logDir ("fetch-{0}-{1:yyyyMMdd-HHmmss}.log" -f $Module, (Get-Date))
    $steps = ($fetchFor | ForEach-Object { "& '$fetch' -Module $_" }) -join '; '
    $command = "Start-Transcript -Path '$log' | Out-Null; $steps; Stop-Transcript | Out-Null; " +
        "Write-Host ''; Write-Host 'Restart ComfyUI if node packs were added.' -ForegroundColor Yellow"
    Start-Process powershell.exe -WorkingDirectory $root -ArgumentList @(
        '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $command)
    Write-Host "Downloading models and node packs for $($fetchFor -join ', ') in a separate window." -ForegroundColor Green
    Write-Host "  log: $log" -ForegroundColor DarkGray
    Write-Host "  Skip this next time with -NoAssets." -ForegroundColor DarkGray
}
