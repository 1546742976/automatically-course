param([ValidateSet('source', 'portable', 'all')][string]$Target = 'all')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$trees = @()
if ($Target -in @('source', 'all')) { $trees += 'node_modules\electron\dist' }
if ($Target -in @('portable', 'all')) { $trees += 'dist\win-unpacked' }
foreach ($tree in $trees) {
    $runtimePath = [IO.Path]::GetFullPath((Join-Path $projectRoot $tree))
    if (-not $runtimePath.StartsWith($projectRoot + '\')) { throw 'Runtime path must stay in the project.' }
    if (-not (Test-Path -LiteralPath $runtimePath)) { continue }
    if ((Get-Item -LiteralPath $runtimePath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime directory must not be a link.' }
    # Restore normal execution labels only on generated application files.
    & icacls.exe $runtimePath /grant "${currentUser}:(OI)(CI)(F)" /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot restore owner access: $runtimePath" }
    & icacls.exe $runtimePath /setintegritylevel '(OI)(CI)M' /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot restore runtime integrity labels: $runtimePath" }
    Write-Output "Runtime access restored: $tree"
}
