[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkerUrl,

    [Parameter(Mandatory = $true)]
    [string]$AccessKey,

    [string]$YamlPath = (Join-Path $PSScriptRoot "../../../exports/flybird/fb_clash.yaml"),
    [string]$ProfileId = "",
    [bool]$GeoAutoUpdate = $true,
    [int]$GeoUpdateInterval = 24
)

$ErrorActionPreference = "Stop"

$resolvedYamlPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($YamlPath)
if (-not (Test-Path -LiteralPath $resolvedYamlPath)) {
    throw "YAML file not found: $resolvedYamlPath"
}

$baseUrl = $WorkerUrl.TrimEnd("/")
$payload = @{
    accessKey         = $AccessKey
    # PS 5.1 serializes Get-Content metadata; read a plain UTF-8 string instead.
    clashYaml         = [System.IO.File]::ReadAllText($resolvedYamlPath)
    geoAutoUpdate     = $GeoAutoUpdate
    geoUpdateInterval = $GeoUpdateInterval
}

if ($ProfileId) {
    $payload.profileId = $ProfileId
}

$response = Invoke-RestMethod `
    -Uri "$baseUrl/api/cache" `
    -Method POST `
    -ContentType "application/json; charset=utf-8" `
    -Body ($payload | ConvertTo-Json -Depth 20)

Write-Host "Profile ID: $($response.profile.id)"
Write-Host "Cache only: $($response.profile.cacheOnly)"
Write-Host "Nodes: $($response.profile.nodeCount)"
Write-Host "mihomo subscription:"
Write-Host $response.links.clash
