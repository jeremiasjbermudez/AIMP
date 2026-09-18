<#
.SYNOPSIS
    Download the ComfyUI models and node packs a module needs.

.DESCRIPTION
    Installing a module tells you what is missing. This fetches it.

    Node packs are cloned from their own repository, or installed from the
    ComfyUI registry when that is where they came from. Model files are pulled
    from Hugging Face into the folder the graphs load them from.

    WHAT IT WILL NOT DO is guess. Eighteen of the model files in this pipeline
    have no recorded origin - community LoRAs and detector weights collected by
    hand - and inventing a plausible URL for one of those is how you end up with
    the wrong weights silently installed. Those are listed instead, with the
    exact filename and the folder they belong in.

    Nothing already present is downloaded again.

.EXAMPLE
    .\fetch-assets.ps1 -Module characters
    .\fetch-assets.ps1 -Module video -WhatIf
    .\fetch-assets.ps1 -All -PacksOnly
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Module,
    # Everything every module needs. Large: see the total it prints first.
    [switch]$All,
    [switch]$PacksOnly,
    [switch]$ModelsOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
. (Join-Path $root 'lib\common.ps1')

if (-not $Module -and -not $All) { throw 'Name a module with -Module, or pass -All.' }

$map = Get-ModuleMap
$assetsPath = Join-Path $root 'assets.json'
if (-not (Test-Path $assetsPath)) { throw "No assets.json beside this script." }
$assets = Get-Content $assetsPath -Raw | ConvertFrom-Json

$targets = if ($All) { @(Get-ModuleNames $map) } else { @($Module) }
foreach ($t in $targets) {
    if (-not $map.PSObject.Properties.Name.Contains($t)) { throw "No module called '$t'." }
}

# What those modules between them need.
$wantPacks = @()
$wantModels = @()
foreach ($t in $targets) {
    $wantPacks += @($map.$t.packs)
    $wantModels += @($map.$t.modelFiles)
}
$wantPacks = @($wantPacks | Where-Object { $_ } | Select-Object -Unique)
$wantModels = @($wantModels | Where-Object { $_ } | Select-Object -Unique)

$comfy = $env:COMFY_ROOT
$packDir = Join-Path $comfy 'custom_nodes'
$modelRoot = Join-Path $comfy 'models'

# A cloned pack is only half installed: its Python requirements have to go into
# the environment ComfyUI runs in, or ComfyUI skips the pack at startup and its
# graphs are rejected as unknown nodes - with the pack sitting right there on
# disk. That environment is ComfyUI's own, never whatever `python` is on PATH.
function Get-ComfyPython {
    foreach ($candidate in @(
            (Join-Path $comfy '.venv\Scripts\python.exe'),
            (Join-Path $comfy 'venv\Scripts\python.exe'),
            (Join-Path (Split-Path -Parent $comfy.TrimEnd('/\')) 'python_embeded\python.exe'))) {
        if (Test-Path $candidate) { return $candidate }
    }
    $null
}
function Install-PackRequirements([string]$Pack, [string]$Dir) {
    $req = Join-Path $Dir 'requirements.txt'
    if (-not (Test-Path $req)) { return }
    $py = Get-ComfyPython
    if (-not $py) {
        Write-Warn "  could not find ComfyUI's Python. Install $Pack's requirements by hand:"
        Write-Host "    <ComfyUI python> -m pip install -r `"$req`"" -ForegroundColor DarkGray
        return
    }
    if ($PSCmdlet.ShouldProcess($Pack, "pip install its requirements into $py")) {
        Write-Step "  installing $Pack's Python requirements"
        & $py -m pip install -r $req
        if ($LASTEXITCODE -ne 0) { Write-Warn "  requirements for $Pack failed to install" }
    }
}

# ---------------------------------------------------------------- node packs
if (-not $ModelsOnly) {
    Write-Step "Node packs: $($wantPacks.Count) needed"
    foreach ($pack in $wantPacks) {
        $dest = Join-Path $packDir $pack
        if (Test-Path $dest) { Write-Host "  have    $pack" -ForegroundColor DarkGray; continue }
        $info = $assets.packs.$pack
        if (-not $info) {
            Write-Warn "  no source recorded for $pack - install it from the ComfyUI registry by hand"
            continue
        }
        if ($info.git) {
            if ($PSCmdlet.ShouldProcess($pack, "git clone $($info.git)")) {
                Write-Step "  cloning $pack"
                git clone --depth 1 $info.git $dest
                if ($LASTEXITCODE -ne 0) { Write-Warn "  clone of $pack failed" }
                else { Install-PackRequirements -Pack $pack -Dir $dest }
            }
        } elseif ($info.registry) {
            # It came from the registry rather than a repository, so that is how
            # it goes back on. comfy-cli knows where the registry is.
            if (-not (Get-Command comfy -ErrorAction SilentlyContinue)) {
                Write-Warn "  $pack comes from the ComfyUI registry and comfy-cli is not installed."
                Write-Host "    pip install comfy-cli, then: comfy node install $($info.registry)" -ForegroundColor DarkGray
                continue
            }
            if ($PSCmdlet.ShouldProcess($pack, "comfy node install $($info.registry)")) {
                Write-Step "  installing $pack from the registry"
                comfy --skip-prompt node install $info.registry
                if ($LASTEXITCODE -ne 0) { Write-Warn "  registry install of $pack failed" }
            }
        }
    }
    Write-Warn 'Restart ComfyUI after new node packs, or its graphs will still be rejected.'
}

# ---------------------------------------------------------------- models
if (-not $PacksOnly) {
    # One walk of the models tree, then a lookup each: these folders are large.
    $present = @{}
    if (Test-Path $modelRoot) {
        Get-ChildItem $modelRoot -Recurse -File -ErrorAction SilentlyContinue |
            ForEach-Object { $present[$_.Name.ToLower()] = $_.FullName }
    }

    $fetchable = @()
    $manual = @()
    $already = 0
    foreach ($file in $wantModels) {
        $leaf = [System.IO.Path]::GetFileName($file)
        if ($present[$leaf.ToLower()]) { $already++; continue }
        $info = $assets.models.$leaf
        if (-not $info) { $info = $assets.models.$file }
        if ($info -and $info.source.type -eq 'huggingface') { $fetchable += [pscustomobject]@{ File = $leaf; Info = $info } }
        else { $manual += [pscustomobject]@{ File = $leaf; Info = $info } }
    }

    Write-Step "Models: $($wantModels.Count) needed, $already already here, $($fetchable.Count) to download, $($manual.Count) by hand"

    if ($fetchable.Count) {
        $size = ($fetchable | ForEach-Object { [double]($_.Info.sizeGb) } | Measure-Object -Sum).Sum
        if ($size -gt 0) { Write-Host ("  about {0:N0} GB to download" -f $size) -ForegroundColor DarkGray }
        $python = 'python'
        $helper = Join-Path $root 'lib\fetch-model.py'
        foreach ($item in $fetchable) {
            $folder = Join-Path $modelRoot $item.Info.folder
            if ($PSCmdlet.ShouldProcess($item.File, "download from $($item.Info.source.repo)")) {
                Write-Step "  $($item.File)  <- $($item.Info.source.repo)"
                & $python $helper --repo $item.Info.source.repo --path $item.Info.source.path `
                    --file $item.File --into $folder
                if ($LASTEXITCODE -ne 0) { Write-Warn "  download of $($item.File) failed" }
            }
        }
    }

    if ($manual.Count) {
        Write-Host ''
        Write-Warn "$($manual.Count) file(s) have no recorded source. Nothing is guessed - find these yourself:"
        foreach ($item in $manual) {
            $folder = if ($item.Info) { $item.Info.folder } else { '?' }
            $note = if ($item.Info -and $item.Info.source.note) { " - $($item.Info.source.note)" } else { '' }
            Write-Host ("    {0,-56} -> models\{1}{2}" -f $item.File, $folder, $note) -ForegroundColor DarkGray
        }
        Write-Host '  docs/MODELS.md has what is known about each.' -ForegroundColor DarkGray
    }
}

Write-Host ''
Write-Step 'Done'
