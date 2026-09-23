<#
`docker`, when Docker runs inside WSL rather than on Windows itself.

A render host that runs InsForge in WSL's own Docker (no Docker Desktop) has no
docker command on Windows. With DOCKER_WSL_DISTRO set - in install.env or the
environment - and no docker on PATH, `docker ...` runs as root inside that
distribution, stdin and all, so `Get-Content x.sql | docker exec -i ...` works
unchanged. As root, because a user added to the docker group only gets it in a
new login, and the installers should not depend on when WSL last restarted.

Dot-sourced by lib/common.ps1 and core/02-settings.ps1.
#>
function Enable-DockerThroughWsl([string]$Distro) {
    if (-not $Distro) { return }
    if (Get-Command docker -CommandType Application -ErrorAction SilentlyContinue) { return }
    $script:DockerWslDistro = $Distro
    function global:docker {
        if ($MyInvocation.ExpectingInput) { $input | wsl.exe -d $script:DockerWslDistro -u root -- docker @args }
        else { wsl.exe -d $script:DockerWslDistro -u root -- docker @args }
    }
}
