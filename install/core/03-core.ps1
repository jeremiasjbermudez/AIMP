<#
.SYNOPSIS
    Install the core: the base tables, the module registry, and a blank admin app.

.DESCRIPTION
    After this you have a working but featureless system: you can sign in,
    create a project, and see an empty tab bar. Every feature arrives as a
    module on top.

    Run 02-settings.ps1 first.

.EXAMPLE
    .\03-core.ps1
    .\03-core.ps1 -SkipNpm      # when node_modules is already there
#>
[CmdletBinding(SupportsShouldProcess)]
param([switch]$SkipNpm)

$ErrorActionPreference = 'Stop'
$installRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$repoRoot = Split-Path -Parent $installRoot
. (Join-Path $installRoot 'lib\common.ps1')

# ---------------------------------------------------------------- 1. preflight
Write-Step 'Checking the tools this needs'
$tools = [ordered]@{
    'node'   = { node --version }
    'npm'    = { npm --version }
    'docker' = { docker --version }
}
foreach ($name in $tools.Keys) {
    try {
        $version = (& $tools[$name] 2>&1 | Select-Object -First 1)
        Write-Host "  $name $version" -ForegroundColor DarkGray
    } catch { throw "$name is not on PATH. See requirements.md." }
}
$major = [int](((node --version) -replace '^v', '') -split '\.')[0]
if ($major -lt 20) { Write-Warn "Node $major is older than this was built against (22)." }

# ---------------------------------------------------------------- 2. database
Write-Step 'Creating the core tables'
foreach ($sql in @('prelude.sql', 'schema.sql', 'registry.sql', 'settings.sql')) {
    $path = Join-Path $installRoot "modules\core\$sql"
    if (Test-Path $path) {
        if ($PSCmdlet.ShouldProcess($sql, 'apply')) {
            Write-Host "  $sql" -ForegroundColor DarkGray
            Invoke-Sql -File $path
        }
    }
}
if ($PSCmdlet.ShouldProcess('PostgREST', 'reload schema cache')) { Invoke-Sql -Command "NOTIFY pgrst, 'reload schema';" }

if ($PSCmdlet.ShouldProcess('core', 'record in installed_modules')) {
    Invoke-Sql -Command @"
INSERT INTO public.installed_modules (name, tabs, notes)
VALUES ('core', ARRAY[]::text[], 'base tables, registry and admin shell')
ON CONFLICT (name) DO UPDATE SET installed_at = now();
"@
}

# ---------------------------------------------------------------- 2b. edge functions
# Without create-movie the app cannot create a project, so this is not optional
# and it belongs to core rather than to any feature.
Write-Step 'Deploying the core edge functions'
if ($PSCmdlet.ShouldProcess('core', 'deploy edge functions')) { Install-EdgeFunctions -Module 'core' }

# ---------------------------------------------------------------- 3. admin .env
Write-Step 'Writing the admin app configuration'
$envFile = Join-Path $env:ADMIN_DIR '.env'
if (-not (Test-Path $envFile)) {
    $example = Join-Path $env:ADMIN_DIR '.env.example'
    if (Test-Path $example) { Copy-Item $example $envFile }
    else { New-Item -ItemType File -Path $envFile | Out-Null }
}
# The values the app needs regardless of which modules are installed. Flow ids
# are written later, one module at a time.
Set-EnvValues -Values @{
    'VITE_INSFORGE_URL'  = $env:INSFORGE_URL
    'VITE_FLOWISE_URL'   = $env:FLOWISE_URL
    'VITE_COMFY_URL'     = $env:COMFY_URL
}
Write-Host "  set the service URLs in admin/.env" -ForegroundColor DarkGray
Write-Warn "Still to fill in by hand: VITE_INSFORGE_ANON_KEY, VITE_ADMIN_EMAIL, VITE_ADMIN_PASSWORD, VITE_FLOWISE_API_KEY"
Write-Host "  The anon key is in the InsForge console; the admin user is the one you created there." -ForegroundColor DarkGray

# ---------------------------------------------------------------- 4. the shell
if (-not $SkipNpm) {
    Write-Step 'Installing the admin app dependencies (this takes a minute)'
    if ($PSCmdlet.ShouldProcess('npm install', 'run')) {
        Push-Location $env:ADMIN_DIR
        try {
            npm install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
        } finally { Pop-Location }
    }
}

Write-Step 'Generating an empty tab registry'
if ($PSCmdlet.ShouldProcess('modules.generated.tsx', 'write')) { Update-TabRegistry }

Write-Host ''
Write-Step 'Core installed'
Write-Host 'Start it with:  cd admin ; npm run dev' -ForegroundColor Green
Write-Host 'Then add what you need, for example:' -ForegroundColor Green
Write-Host '  ..\install\install-module.ps1 -Module screenplay' -ForegroundColor DarkGray
Write-Host '  ..\install\install-module.ps1 -Module characters' -ForegroundColor DarkGray
Write-Host 'List everything available:  ..\install\list-modules.ps1' -ForegroundColor DarkGray
