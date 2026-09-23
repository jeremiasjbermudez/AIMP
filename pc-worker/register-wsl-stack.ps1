<#
.SYNOPSIS
    Keep InsForge running in WSL's Docker on a Windows render host.

.DESCRIPTION
    WSL shuts its virtual machine down once nothing is using it, and InsForge's
    containers go with it. The Postgres one has no restart policy in InsForge's
    compose file, so when WSL next started it stayed down and every query failed
    with "container is not running".

    This registers AIMP-WSL: at boot, as this user, it brings InsForge's compose
    stack up and then keeps one process running inside the distribution, which
    is what keeps WSL - and so Docker - alive. It also gives every container in
    the stack an unless-stopped restart policy.

.EXAMPLE
    .\register-wsl-stack.ps1
    .\register-wsl-stack.ps1 -Distro Ubuntu-24.04 -ComposeDir /home/alexk/insforge/deploy/docker-compose
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Distro = 'Ubuntu-24.04',
    [string]$ComposeDir = '/home/' + $env:USERNAME + '/insforge/deploy/docker-compose'
)
$ErrorActionPreference = 'Stop'

$up = "cd '$ComposeDir' && docker compose up -d"
$taskName = 'AIMP-WSL'
# `exec sleep infinity` is the process that keeps the distribution running.
$action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $Distro -u root -- sh -c `"$up; exec sleep infinity`""
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
foreach ($i in 1..60) {
    if ($i -eq 3) {
        # Set once here rather than inside the task's command line, where the
        # nested quoting did not survive: every container restarts on failure.
        & wsl.exe -d $Distro -u root -- bash -c 'for c in $(docker ps -aq); do docker update --restart unless-stopped $c >/dev/null; done'
    }
    Start-Sleep 3
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:7130 | Out-Null; Write-Host "InsForge answering after $($i*3)s" -ForegroundColor Green; break } catch {}
}
