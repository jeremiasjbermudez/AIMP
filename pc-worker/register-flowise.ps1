<#
.SYNOPSIS
    Run Flowise at boot on the render host, on the Node it needs.

.DESCRIPTION
    Registers AIMP-Flowise: Flowise's server, started at boot as this user.
    Flowise 3.1.3 needs Node 24 - on Node 25 it cannot start - so -Node can point
    at a portable Node 24 while the machine's own node stays whatever it is.
    Its port, loopback address and data folder come from packages\server\.env,
    which core\01-flowise.ps1 writes.

.EXAMPLE
    .\register-flowise.ps1 -Node C:\ComfyUI-server\node24\node.exe
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Node = (Get-Command node -ErrorAction Stop).Source,
    [string]$FlowisePath = (Join-Path $HOME 'flowise'),
    [int]$Port = 3010
)
$ErrorActionPreference = 'Stop'

$run = Join-Path $FlowisePath 'packages\server\bin\run'
if (-not (Test-Path $run)) { throw "No built Flowise at $FlowisePath - run core\01-flowise.ps1 first." }
$major = [int](((& $Node --version) -replace '^v', '') -split '\.')[0]
if ($major -ne 24) { throw "Flowise needs Node 24; $Node is Node $major. Pass -Node with a Node 24 (a portable copy is enough)." }

$logs = Join-Path $FlowisePath "data$Port\logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$taskName = 'AIMP-Flowise'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$Node`" packages\server\bin\run start > `"$logs\flowise.out`" 2>&1`"" -WorkingDirectory $FlowisePath
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
    Start-Sleep 5
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port" | Out-Null; Write-Host "Flowise answering after $($i*5)s" -ForegroundColor Green; break } catch {}
}
