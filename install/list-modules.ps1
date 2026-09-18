<#
.SYNOPSIS
    What can be installed, what is installed, and what each one brings.

.EXAMPLE
    .\list-modules.ps1
    .\list-modules.ps1 -Module world     # everything about one module
#>
[CmdletBinding()]
param([string]$Module)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
. (Join-Path $root 'lib\common.ps1')

$map = Get-ModuleMap
$installed = Get-InstalledModules

if ($Module) {
    if (-not $map.PSObject.Properties.Name.Contains($Module)) { throw "No module called '$Module'." }
    $s = $map.$Module
    Write-Host ""
    Write-Host $s.title -ForegroundColor Cyan
    Write-Host $s.summary
    Write-Host ""
    Write-Host ("  status    " + $(if ($installed -contains $Module) { 'installed' } else { 'not installed' }))
    if (@($s.needs).Count)   { Write-Host ("  needs     " + (@($s.needs) -join ', ')) }
    if (@($s.optional).Count){ Write-Host ("  optional  " + (@($s.optional) -join ', ')) }
    if (@($s.panels).Count)  { Write-Host ("  tabs      " + ((@($s.panels) | ForEach-Object { $_.tab }) -join ', ')) }
    if (@($s.tables).Count)  { Write-Host ("  tables    " + (@($s.tables) -join ', ')) }
    if (@($s.flows).Count)   { Write-Host ("  flows     " + @($s.flows).Count) }
    if (@($s.packs).Count)   { Write-Host ("  packs     " + (@($s.packs) -join ', ')) }
    if (@($s.models).Count)  {
        Write-Host "  models"
        foreach ($m in $s.models) { Write-Host "            $m" -ForegroundColor DarkGray }
    }
    $doc = Join-Path $root "modules\$Module\README.md"
    if (Test-Path $doc) { Write-Host ""; Write-Host "  full documentation: install/modules/$Module/README.md" -ForegroundColor DarkGray }
    Write-Host ""
    return
}

Write-Host ""
Write-Host ("{0,-16} {1,-13} {2,-28} {3}" -f 'MODULE', 'STATUS', 'TABS', 'WHAT IT ADDS') -ForegroundColor Cyan
Write-Host ("-" * 110) -ForegroundColor DarkGray
foreach ($name in (Get-ModuleNames $map)) {
    $s = $map.$name
    $status = if ($installed -contains $name) { 'installed' } else { '-' }
    $tabs = ((@($s.panels) | ForEach-Object { $_.tab }) -join ',')
    if ($tabs.Length -gt 27) { $tabs = $tabs.Substring(0, 24) + '...' }
    $what = $s.title
    $colour = if ($status -eq 'installed') { 'Green' } else { 'Gray' }
    Write-Host ("{0,-16} {1,-13} {2,-28} {3}" -f $name, $status, $tabs, $what) -ForegroundColor $colour
}
Write-Host ""
Write-Host "Detail:   .\list-modules.ps1 -Module <name>" -ForegroundColor DarkGray
Write-Host "Install:  .\install-module.ps1 -Module <name>" -ForegroundColor DarkGray
Write-Host "Remove:   .\uninstall-module.ps1 -Module <name>" -ForegroundColor DarkGray
Write-Host ""
