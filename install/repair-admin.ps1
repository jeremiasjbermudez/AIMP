<#
.SYNOPSIS
    Make the admin app match what is actually installed.

.DESCRIPTION
    The app's tabs come from the panel files present in admin/src, which the
    module installs put there. If those files and the installed_modules table
    ever disagree - a folder copied from elsewhere, a half-finished install, a
    panel deleted by hand - the app shows tabs with nothing behind them, or
    hides tabs that are installed.

    This makes the files match the table: panels for modules that are installed
    are copied in, panels for modules that are not are removed, and the tab
    registry is regenerated. It changes no database rows, no flows and no
    settings - only which panel files exist.

.EXAMPLE
    .\repair-admin.ps1
    .\repair-admin.ps1 -WhatIf     # show the difference without changing it
#>
[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
. (Join-Path $root 'lib/common.ps1')

$map = Get-ModuleMap
$installed = Get-InstalledModules
Write-Step "Installed modules: $(($installed -join ', '))"

$adminSrc = Join-Path $env:ADMIN_DIR 'src'
$added = @()
$removed = @()

foreach ($name in (Get-ModuleNames $map)) {
    if ($name -eq 'core') { continue }
    $wanted = $installed -contains $name
    foreach ($panel in @($map.$name.panels)) {
        foreach ($file in @($panel.files)) {
            $target = Join-Path $adminSrc $file
            $present = Test-Path $target
            if ($wanted -and -not $present) {
                if ($PSCmdlet.ShouldProcess($file, "restore ($name is installed)")) {
                    Copy-PanelFile -Relative $file
                }
                $added += "$name/$file"
            } elseif (-not $wanted -and $present) {
                if ($PSCmdlet.ShouldProcess($file, "remove ($name is not installed)")) {
                    Remove-Item $target -Recurse -Force
                }
                $removed += "$name/$file"
            }
        }
    }
}

if ($added.Count) {
    Write-Step "Restored $($added.Count) file(s) for installed modules"
    foreach ($f in $added) { Write-Host "  + $f" -ForegroundColor DarkGray }
}
if ($removed.Count) {
    Write-Step "Removed $($removed.Count) file(s) belonging to modules that are not installed"
    foreach ($f in $removed) { Write-Host "  - $f" -ForegroundColor DarkGray }
}
if (-not $added.Count -and -not $removed.Count) {
    Write-Step 'Already matching - nothing to do'
}

# A folder panel copied into an existing folder of the same name used to nest -
# screenplay/screenplay/ - and the app then imports the outer one, which has no
# index. The copy no longer does that; this clears up any left behind.
$nested = @()
foreach ($name in (Get-ModuleNames $map)) {
    foreach ($panel in @($map.$name.panels)) {
        foreach ($file in @($panel.files)) {
            $leaf = $file.TrimEnd('/')
            if ($leaf -notmatch '\.(tsx|ts)$') {
                $inner = Join-Path (Join-Path $adminSrc $leaf) (Split-Path $leaf -Leaf)
                if (Test-Path $inner) { $nested += $inner }
            }
        }
    }
}
foreach ($path in $nested) {
    if ($PSCmdlet.ShouldProcess($path, 'remove a nested duplicate')) {
        Remove-Item $path -Recurse -Force
        Write-Host "  removed nested copy: $path" -ForegroundColor DarkGray
    }
}

if ($PSCmdlet.ShouldProcess('admin tab registry', 'regenerate')) {
    Update-TabRegistry
}

Write-Host ''
Write-Host 'Restart the admin dev server to see the change.' -ForegroundColor Green
