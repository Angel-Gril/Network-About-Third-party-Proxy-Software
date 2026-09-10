[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkerUrl,

    [Parameter(Mandatory = $true)]
    [string]$AccessKey,

    [Parameter(Mandatory = $true)]
    [string]$Email,

    [string]$Password,
    [string]$ProfileId = "",
    [string]$OutDir = (Join-Path $PSScriptRoot "../../../exports/flybird")
)

$ErrorActionPreference = "Stop"

$exportArgs = @{
    Email = $Email
    OutDir = $OutDir
}
if ($Password) {
    $exportArgs.Password = $Password
}

& "$PSScriptRoot\export.ps1" @exportArgs
if ($LASTEXITCODE) {
    exit $LASTEXITCODE
}

$syncArgs = @{
    WorkerUrl = $WorkerUrl
    AccessKey = $AccessKey
    YamlPath = (Join-Path $OutDir "fb_clash.yaml")
}
if ($ProfileId) {
    $syncArgs.ProfileId = $ProfileId
}

& "$PSScriptRoot\sync_worker_cache.ps1" @syncArgs
