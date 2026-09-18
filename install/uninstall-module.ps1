<#
.SYNOPSIS
    Remove one module: its tabs, its flows, and optionally its tables.

.DESCRIPTION
    The reverse of install-module.ps1, with one deliberate asymmetry: the
    module's TABLES ARE KEPT unless you ask for them. Uninstalling a feature
    should not destroy the work done with it, and a tab is easy to put back
    while a dropped table is not.

    Refuses to remove a module another installed module depends on.

.EXAMPLE
    .\uninstall-module.ps1 -Module colour
    .\uninstall-module.ps1 -Module colour -DropTables
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$Module,
    # Also drop this module's tables and everything in them. Irreversible.
    [switch]$DropTables,
    # Also delete its flows from Flowise. Off by default: a flow costs nothing
    # to leave in place and may be shared with work in progress.
    [switch]$RemoveFlows
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
. (Join-Path $root 'lib\common.ps1')

$map = Get-ModuleMap
if (-not $map.PSObject.Properties.Name.Contains($Module)) { throw "No module called '$Module'." }
if ($Module -eq 'core') { throw "Core cannot be uninstalled. Remove the modules on top of it instead." }
$spec = $map.$Module

# ---------------------------------------------------------------- dependents
$installed = Get-InstalledModules
$dependents = @()
foreach ($name in (Get-ModuleNames $map)) {
    if ($installed -contains $name -and @($map.$name.needs) -contains $Module) { $dependents += $name }
}
if ($dependents.Count) {
    throw "$($dependents -join ', ') depend on '$Module'. Remove them first."
}

Write-Step "Removing $($spec.title)"

# ---------------------------------------------------------------- panels
foreach ($panel in @($spec.panels)) {
    foreach ($file in @($panel.files)) {
        $path = Join-Path $env:ADMIN_DIR "src\$file"
        if (Test-Path $path) {
            if ($PSCmdlet.ShouldProcess($file, 'remove from the admin app')) {
                Remove-Item $path -Recurse -Force
                Write-Host "  removed $file" -ForegroundColor DarkGray
            }
        }
    }
}
if ($PSCmdlet.ShouldProcess('admin tab registry', 'regenerate')) { Update-TabRegistry }

# ---------------------------------------------------------------- flows
if ($RemoveFlows) {
    $row = docker exec -i $env:PG_CONTAINER psql -U postgres -d $env:PG_DB -tAc `
        "SELECT flow_ids FROM public.installed_modules WHERE name = '$Module';"
    if ($row) {
        $ids = $row | ConvertFrom-Json
        foreach ($name in $ids.PSObject.Properties.Name) {
            $id = $ids.$name
            if ($PSCmdlet.ShouldProcess($id, "delete Flowise flow ($name)")) {
                try {
                    Invoke-RestMethod -Method Delete -Uri "$($env:FLOWISE_URL)/api/v1/chatflows/$id" `
                        -Headers @{ Authorization = "Bearer $($env:FLOWISE_API_KEY)" } | Out-Null
                    Write-Host "  deleted flow $name" -ForegroundColor DarkGray
                } catch {
                    Write-Warn "  could not delete flow $name : $($_.Exception.Message)"
                }
            }
        }
    }
    # Blank the ids in the admin .env so nothing points at a flow that is gone.
    $blank = @{}
    foreach ($flow in @($spec.flows)) { if ($flow.env) { $blank[$flow.env] = '' } }
    if ($blank.Count -and $PSCmdlet.ShouldProcess('admin/.env', 'blank this module''s flow ids')) {
        Set-EnvValues -Values $blank
    }
}

# ---------------------------------------------------------------- tables
if ($DropTables) {
    $tables = @($spec.tables)
    if ($tables.Count) {
        Write-Warn "About to DROP: $($tables -join ', '). Everything in them goes with it."
        if ($PSCmdlet.ShouldProcess(($tables -join ', '), 'DROP TABLE')) {
            # Reverse order, and CASCADE, because these tables reference each
            # other and a plain DROP would stop on the first foreign key.
            [array]::Reverse($tables)
            foreach ($t in $tables) { Invoke-Sql -Command "DROP TABLE IF EXISTS public.$t CASCADE;" }
            Invoke-Sql -Command "NOTIFY pgrst, 'reload schema';"
        }
    }
} elseif (@($spec.tables).Count) {
    Write-Host "  tables kept: $(@($spec.tables) -join ', '). Pass -DropTables to remove them." -ForegroundColor DarkGray
}

if ($PSCmdlet.ShouldProcess($Module, 'remove from installed_modules')) {
    Invoke-Sql -Command "DELETE FROM public.installed_modules WHERE name = '$Module';"
}
Write-Step "$($spec.title) removed"
