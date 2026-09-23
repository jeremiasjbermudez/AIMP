<#
.SYNOPSIS
    Run the admin app on the render host at boot, for opening from another machine.

.DESCRIPTION
    Registers AIMP-Admin: the admin app's dev server, started at boot as this
    user. With ADMIN_PROXY=1 in install.env (see core/03-core.ps1) it serves
    InsForge, Flowise and ComfyUI through itself, so it is the one port another
    machine needs, and it listens on ADMIN_HOST - the Tailscale address, say -
    rather than on every interface.

.EXAMPLE
    .\register-admin.ps1
    .\register-admin.ps1 -Node C:\ComfyUI-server\node24\node.exe -AdminDir C:\AIMP\admin
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Node = (Get-Command node -ErrorAction Stop).Source,
    # Default: the admin folder of the checkout this script is in (worked out
    # below - Windows PowerShell 5.1 does not have $PSScriptRoot in defaults).
    [string]$AdminDir = '',
    [int]$Port = 5185
)
$ErrorActionPreference = 'Stop'
if (-not $AdminDir) { $AdminDir = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'admin' }

$vite = Join-Path $AdminDir 'node_modules\vite\bin\vite.js'
if (-not (Test-Path $vite)) { throw "No vite under $AdminDir - run core\03-core.ps1 first." }
$log = Join-Path $AdminDir 'admin-dev.log'
$taskName = 'AIMP-Admin'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$Node`" `"$vite`" > `"$log`" 2>&1`"" -WorkingDirectory $AdminDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
if ($PSCmdlet.ShouldProcess($taskName, 'register and start')) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $taskName
}
foreach ($i in 1..40) {
    Start-Sleep 2
    $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listening) { Write-Host "Admin app listening on $($listening.LocalAddress):$Port" -ForegroundColor Green; break }
}
