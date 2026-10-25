[CmdletBinding()]
param(
    [string]$ClientDataDir = (Join-Path $env:APPDATA "com.fbapp.clients.apex\飞鸟-极速版"),
    [string]$OutFile = (Join-Path $PSScriptRoot "../../../exports/flybird/flybird-client-state.json")
)

$ErrorActionPreference = "Stop"

function Read-DpapiJson {
    param([Parameter(Mandatory = $true)][string]$Path)

    Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction SilentlyContinue
    $ciphertext = [System.IO.File]::ReadAllBytes($Path)
    $plaintext = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $ciphertext,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    try {
        return ([System.Text.Encoding]::UTF8.GetString($plaintext) | ConvertFrom-Json)
    }
    finally {
        [Array]::Clear($plaintext, 0, $plaintext.Length)
    }
}

$dataDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ClientDataDir)
$securePath = Join-Path $dataDir "flutter_secure_storage.dat"
$preferencesPath = Join-Path $dataDir "shared_preferences.json"
if (-not (Test-Path -LiteralPath $securePath -PathType Leaf)) {
    throw "FlyingBird 7.2.x secure storage not found: $securePath"
}
if (-not (Test-Path -LiteralPath $preferencesPath -PathType Leaf)) {
    throw "FlyingBird shared preferences not found: $preferencesPath"
}

$secure = Read-DpapiJson $securePath
$preferences = Get-Content -Raw -LiteralPath $preferencesPath | ConvertFrom-Json
$profileKey = [string]$secure.apex_profile_file_key_v3
$xboardToken = [string]$secure.xboard_token
$subscription = $preferences.'flutter.xboard_domain_subscription' | ConvertFrom-Json
$clientVersion = [string]$preferences.'flutter.apex_last_run_version'

if (-not $profileKey -or -not $subscription.subscribeUrl -or -not $subscription.token) {
    throw "FlyingBird client state is incomplete; log in with the official client first"
}
if (-not ([string]$subscription.subscribeUrl).StartsWith("apex-url-v2:") -or
    -not ([string]$subscription.token).StartsWith("apex-url-v2:")) {
    throw "Unsupported FlyingBird client subscription envelope"
}

$outPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
$outDir = Split-Path -Parent $outPath
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$bundle = [ordered]@{
    format               = "flybird-client-state/v1"
    clientVersion        = $clientVersion
    capturedAt           = [DateTime]::UtcNow.ToString("o")
    apexProfileFileKeyV3 = $profileKey
    subscriptionUrl      = [string]$subscription.subscribeUrl
    subscriptionToken    = [string]$subscription.token
    xboardToken          = $xboardToken
}
[System.IO.File]::WriteAllText(
    $outPath,
    ($bundle | ConvertTo-Json -Depth 10),
    (New-Object System.Text.UTF8Encoding($false))
)
Write-Host "Client-state bundle written: $outPath"
Write-Host "Client version: $clientVersion"
Write-Host "Contains subscription URL/token: $([bool]$subscription.subscribeUrl)/$([bool]$subscription.token)"

