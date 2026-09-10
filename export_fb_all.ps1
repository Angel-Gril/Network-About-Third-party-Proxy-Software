[CmdletBinding()]
param(
    [string]$Email,
    [string]$Password,
    [string]$ApiBaseUrl,
    [string]$ProxyUrl,
    [string]$RoutingTemplatePath,
    [string]$OutDir = ".\fb_export"
)

. (Join-Path $PSScriptRoot "routing.ps1")
. (Join-Path $PSScriptRoot "subscription_validation.ps1")

$ErrorActionPreference = "Stop"
$ProfileAesKey = "14f521a32997b257"
$ProfileAesIv = "d217125f4b9cc9c8"
$FallbackApiBaseUrl = "https://fbesa.apiv2.a047.com/api/v1"

function Get-PlainPassword {
    param([string]$ProvidedPassword)
    if ($ProvidedPassword) { return $ProvidedPassword }
    $secure = Read-Host "Password" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

function Get-FlyingBirdApiBaseCandidates {
    param([string]$ProvidedUrl)

    $rawCandidates = New-Object System.Collections.Generic.List[object]
    if ($ProvidedUrl) {
        $rawCandidates.Add([pscustomobject]@{ Url = $ProvidedUrl; Source = "parameter" })
    }
    elseif ($env:FLYBIRD_API_BASE_URL) {
        $rawCandidates.Add([pscustomobject]@{ Url = $env:FLYBIRD_API_BASE_URL; Source = "environment" })
    }
    else {
        $preferencePaths = @(
            (Join-Path $env:APPDATA "FlyingBird\FlyingBird\shared_preferences.json"),
            (Join-Path $env:APPDATA "FlyingBirdLite\FlyingBirdLite\shared_preferences.json"),
            (Join-Path $env:APPDATA "net.fbclient.app\fbclient\shared_preferences.json")
        )
        $preferenceFiles = @($preferencePaths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | ForEach-Object { Get-Item -LiteralPath $_ } | Sort-Object LastWriteTimeUtc -Descending)
        foreach ($file in $preferenceFiles) {
            try {
                $preferences = Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json
                $detectedUrl = [string]$preferences.'flutter.api_base_url'
                if ($detectedUrl) {
                    $rawCandidates.Add([pscustomobject]@{ Url = $detectedUrl; Source = "client-preferences" })
                }
            }
            catch {
                Write-Warning "无法读取 FlyingBird API 地址记录: $($file.FullName)"
            }
        }
        $rawCandidates.Add([pscustomobject]@{ Url = $FallbackApiBaseUrl; Source = "built-in-fallback" })
    }

    $result = New-Object System.Collections.Generic.List[object]
    $seen = @{}
    foreach ($candidate in $rawCandidates) {
        $url = ([string]$candidate.Url).Trim().TrimEnd('/')
        try { $uri = [Uri]$url } catch { $uri = $null }
        if (-not $uri -or -not $uri.IsAbsoluteUri -or $uri.Scheme -ne "https") {
            if ($ProvidedUrl) { throw "无效的 FlyingBird API 地址: $url" }
            continue
        }
        if ($seen.ContainsKey($url)) { continue }
        $seen[$url] = $true
        $result.Add([pscustomobject]@{ Url = $url; Source = $candidate.Source })
    }
    if ($result.Count -eq 0) { throw "没有可用的 FlyingBird API 地址" }
    return $result.ToArray()
}

function Convert-Base64TextToBytes {
    param([string]$Text)
    $normalized = ($Text -replace '\s+', '').Replace('-', '+').Replace('_', '/')
    $padding = $normalized.Length % 4
    if ($padding -gt 0) {
        $normalized += ('=' * (4 - $padding))
    }
    return [Convert]::FromBase64String($normalized)
}

function Decrypt-FlyingBirdProfile {
    param([string]$CipherText)

    $outer = Convert-Base64TextToBytes $CipherText
    $aes = [System.Security.Cryptography.Aes]::Create()
    $decryptor = $null
    try {
        $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
        $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
        $aes.Key = [Text.Encoding]::ASCII.GetBytes($ProfileAesKey)
        $aes.IV = [Text.Encoding]::ASCII.GetBytes($ProfileAesIv)
        $decryptor = $aes.CreateDecryptor()
        $plainBytes = $decryptor.TransformFinalBlock($outer, 0, $outer.Length)
    }
    finally {
        if ($decryptor) { $decryptor.Dispose() }
        $aes.Dispose()
    }

    $inner = [Text.Encoding]::UTF8.GetString($plainBytes).Trim()
    try {
        return [Text.Encoding]::UTF8.GetString((Convert-Base64TextToBytes $inner))
    }
    catch {
        return $inner
    }
}

function Convert-FlyingBirdSubscriptionContentToClashYaml {
    param([string]$Content)

    if ($Content -match '(?m)^\s*proxies:\s*$') {
        return $Content
    }
    if ($Content -match '(?is)^\s*(?:<!doctype\s+html|<html[\s>])') {
        throw "订阅接口返回了 WAF/HTML 页面"
    }

    $yaml = Decrypt-FlyingBirdProfile $Content
    if ($yaml -notmatch '(?m)^\s*proxies:\s*$') {
        throw "订阅响应既不是 Clash YAML，也不是可解密的 FlyingBird 密文"
    }
    return $yaml
}

function Format-FlyingBirdSubscriptionUrl {
    param(
        [string]$Template,
        [string]$Token
    )
    if (-not $Template) { return $null }
    if ($Template -like "*{0}*") {
        return ([string]::Format($Template, [System.Uri]::EscapeDataString($Token)))
    }
    if ($Template -like "*{token}*") {
        return $Template.Replace("{token}", [System.Uri]::EscapeDataString($Token))
    }
    if ($Template -match '(?:\?|&)token=') {
        return $Template
    }
    return $null
}

function Invoke-FlyingBirdWebRequest {
    param(
        [string]$Uri,
        [string]$Method = "GET",
        [hashtable]$Headers,
        [hashtable]$Body,
        [string]$ContentType,
        [int]$TimeoutSec = 30
    )

    $request = @{
        Uri = $Uri
        Method = $Method
        Headers = $Headers
        TimeoutSec = $TimeoutSec
        UseBasicParsing = $true
    }
    if ($Body) { $request.Body = $Body }
    if ($ContentType) { $request.ContentType = $ContentType }
    $restoreDefaultProxy = $false
    $previousDefaultProxy = $null
    if ($ProxyUrl) {
        $request.Proxy = $ProxyUrl
    }
    elseif ((Get-Command Invoke-WebRequest).Parameters.ContainsKey('NoProxy')) {
        $request.NoProxy = $true
    }
    else {
        $previousDefaultProxy = [Net.WebRequest]::DefaultWebProxy
        [Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy
        $restoreDefaultProxy = $true
    }

    try {
        return [string](Invoke-WebRequest @request).Content
    }
    catch {
        $response = $_.Exception.Response
        $status = "连接失败"
        if ($response) {
            try { $status = [int]$response.StatusCode } catch {}
        }
        throw "HTTP $status - FlyingBird 请求失败"
    }
    finally {
        if ($restoreDefaultProxy) {
            [Net.WebRequest]::DefaultWebProxy = $previousDefaultProxy
        }
    }
}

function Convert-BoolValue {
    param($Value)
    if ($null -eq $Value -or $Value -eq "") { return $null }
    if ($Value -is [bool]) { return $(if ($Value) { "1" } else { "0" }) }
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        return (($Value | ForEach-Object { $_.ToString() }) -join ",")
    }
    return $Value.ToString()
}

function Coalesce-Value {
    foreach ($value in $args) {
        if ($null -ne $value -and $value -ne "") {
            return $value
        }
    }
    return $null
}

function Build-QueryString {
    param([hashtable]$Params)
    $pairs = @()
    foreach ($k in $Params.Keys) {
        $v = Convert-BoolValue $Params[$k]
        if ($null -eq $v -or $v -eq "") { continue }
        $pairs += ([System.Uri]::EscapeDataString($k) + "=" + [System.Uri]::EscapeDataString($v))
    }
    return ($pairs -join "&")
}

function Get-NetworkPath {
    param($Proxy)
    $wsOpts = $Proxy.'ws-opts'
    $httpOpts = $Proxy.'http-opts'
    $grpcOpts = $Proxy.'grpc-opts'
    return (Coalesce-Value `
        $Proxy.'ws-path' `
        $wsOpts.path `
        $Proxy.'http-path' `
        $httpOpts.path `
        $Proxy.path `
        $grpcOpts.path `
        "")
}

function Get-NetworkHost {
    param($Proxy)
    $wsOpts = $Proxy.'ws-opts'
    $wsHeaders = $Proxy.'ws-headers'
    $headers = $wsOpts.headers
    $httpOpts = $Proxy.'http-opts'
    return (Coalesce-Value `
        $wsHeaders.Host `
        $headers.Host `
        $httpOpts.host `
        $Proxy.host `
        "")
}

function Convert-ProxyToLink {
    param($Proxy)
    $type = ([string]$Proxy.type).ToLowerInvariant()
    switch ($type) {
        "vmess" {
            $vmess = [ordered]@{
                v    = "2"
                ps   = $Proxy.name
                add  = $Proxy.server
                port = [string]$Proxy.port
                id   = $Proxy.uuid
                aid  = [string](Coalesce-Value $Proxy.alterId 0)
                scy  = (Coalesce-Value $Proxy.cipher "auto")
                net  = (Coalesce-Value $Proxy.network "tcp")
                type = "none"
                host = (Get-NetworkHost $Proxy)
                path = (Get-NetworkPath $Proxy)
                tls  = $(if ($Proxy.tls) { "tls" } else { "" })
                sni  = (Coalesce-Value $Proxy.servername "")
            }
            $json = $vmess | ConvertTo-Json -Compress -Depth 10
            $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
            return "vmess://$b64"
        }
        "vless" {
            $params = @{
                type          = (Coalesce-Value $Proxy.network "tcp")
                security      = $(if ($Proxy.tls) { "tls" } else { "none" })
                encryption    = (Coalesce-Value $Proxy.encryption "none")
                flow          = $Proxy.flow
                sni           = (Coalesce-Value $Proxy.servername $Proxy.sni)
                host          = (Get-NetworkHost $Proxy)
                path          = (Get-NetworkPath $Proxy)
                serviceName   = (Coalesce-Value $Proxy.'grpc-service-name' ($Proxy.'grpc-opts').'grpc-service-name')
                fp            = $Proxy.'client-fingerprint'
                alpn          = $Proxy.alpn
                pbk           = ($Proxy.'reality-opts').'public-key'
                sid           = ($Proxy.'reality-opts').'short-id'
                spx           = ($Proxy.'reality-opts').'spider-x'
                allowInsecure = $Proxy.'skip-cert-verify'
            }
            $query = Build-QueryString $params
            $name = [System.Uri]::EscapeDataString((Coalesce-Value $Proxy.name "Unnamed"))
            $suffix = $(if ($query) { "?$query" } else { "" })
            return "vless://$($Proxy.uuid)@$($Proxy.server):$($Proxy.port)$suffix#$name"
        }
        "trojan" {
            $params = @{
                type          = (Coalesce-Value $Proxy.network "tcp")
                security      = $(if ($Proxy.tls -eq $false) { "none" } else { "tls" })
                sni           = (Coalesce-Value $Proxy.sni $Proxy.servername)
                host          = (Get-NetworkHost $Proxy)
                path          = (Get-NetworkPath $Proxy)
                serviceName   = (Coalesce-Value $Proxy.'grpc-service-name' ($Proxy.'grpc-opts').'grpc-service-name')
                fp            = $Proxy.'client-fingerprint'
                alpn          = $Proxy.alpn
                allowInsecure = $Proxy.'skip-cert-verify'
            }
            $query = Build-QueryString $params
            $name = [System.Uri]::EscapeDataString((Coalesce-Value $Proxy.name "Unnamed"))
            $suffix = $(if ($query) { "?$query" } else { "" })
            return "trojan://$($Proxy.password)@$($Proxy.server):$($Proxy.port)$suffix#$name"
        }
        "ss" {
            $userinfo = "$($Proxy.cipher):$($Proxy.password)"
            $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($userinfo))
            $name = [System.Uri]::EscapeDataString((Coalesce-Value $Proxy.name "Unnamed"))
            return "ss://$b64@$($Proxy.server):$($Proxy.port)#$name"
        }
        default {
            return $null
        }
    }
}

$apiCandidates = @(Get-FlyingBirdApiBaseCandidates $ApiBaseUrl)
$commonHeaders = @{
    "User-Agent" = "NetFlow/v3.0.3 clash-verge Platform/windows"
    "Accept" = "application/json"
    "x-auth-token" = "K9rM2bA7vP5wN8x"
    "x-app-package-name" = "atlas"
    "x-client-platform" = "windows"
}

if (-not $Email) { $Email = Read-Host "Email" }
$Password = Get-PlainPassword $Password

$apiBase = $null
$apiBaseSource = $null
$token = $null
$authData = $null
$loginFailures = New-Object System.Collections.Generic.List[string]
foreach ($apiCandidate in $apiCandidates) {
    $candidateBase = $apiCandidate.Url
    Write-Host "[+] 正在登录 FlyingBird: $candidateBase ($($apiCandidate.Source))"
    try {
        $loginText = Invoke-FlyingBirdWebRequest `
            -Uri "$candidateBase/passport/auth/login" `
            -Method "POST" `
            -Headers $commonHeaders `
            -Body @{ email = $Email.Trim(); password = $Password } `
            -ContentType "application/x-www-form-urlencoded" `
            -TimeoutSec 20
        try { $loginResp = $loginText | ConvertFrom-Json }
        catch { throw "登录接口未返回有效 JSON" }
        if ($loginResp.status -ne "success") {
            throw "登录失败"
        }
        if (-not $loginResp.data.token -or -not $loginResp.data.auth_data) {
            throw "登录成功，但响应缺少 token/auth_data"
        }

        $apiBase = $candidateBase
        $apiBaseSource = $apiCandidate.Source
        $token = $loginResp.data.token
        $authData = $loginResp.data.auth_data
        break
    }
    catch {
        $loginFailures.Add("$(([Uri]$candidateBase).Host): $($_.Exception.Message)")
    }
}
$Password = $null

if (-not $token -or -not $authData) {
    throw "所有 FlyingBird API 地址都登录失败: $($loginFailures -join ' | ')"
}

$subInfo = $null
try {
    $subInfoHeaders = $commonHeaders.Clone()
    $subInfoHeaders.Authorization = "Bearer $authData"
    $subInfoText = Invoke-FlyingBirdWebRequest `
        -Uri "$apiBase/user/getSubscribe" `
        -Headers $subInfoHeaders `
        -TimeoutSec 20
    try { $subInfoResp = $subInfoText | ConvertFrom-Json }
    catch { throw "订阅信息接口未返回有效 JSON" }
    if ($subInfoResp.status -eq "success") { $subInfo = $subInfoResp.data }
    else { Write-Warning "获取订阅信息失败，将使用内置订阅地址" }
}
catch {
    Write-Warning "获取订阅信息失败，将使用内置订阅地址: $($_.Exception.Message)"
}

$candidateTemplates = @(
    $subInfo.subscribe_url,
    $subInfo.subscription_url,
    "$apiBase/client/subscribe?token={token}",
    "$apiBase/client/subscribe?flag=meta&token={token}"
)

$baseCandidateUrls = New-Object System.Collections.Generic.List[string]
$seenBaseUrls = @{}
foreach ($template in $candidateTemplates) {
    $candidateUrl = Format-FlyingBirdSubscriptionUrl $template $token
    if (-not $candidateUrl -or $seenBaseUrls.ContainsKey($candidateUrl)) { continue }
    $seenBaseUrls[$candidateUrl] = $true
    $baseCandidateUrls.Add($candidateUrl)
}

$candidateUrls = New-Object System.Collections.Generic.List[string]
$seenCandidateUrls = @{}
foreach ($candidateUrl in $baseCandidateUrls) {
    $metaUrl = Set-FlyingBirdSubscriptionMetaFlag $candidateUrl
    if (-not $seenCandidateUrls.ContainsKey($metaUrl)) {
        $seenCandidateUrls[$metaUrl] = $true
        $candidateUrls.Add($metaUrl)
    }
}
foreach ($candidateUrl in $baseCandidateUrls) {
    if (-not $seenCandidateUrls.ContainsKey($candidateUrl)) {
        $seenCandidateUrls[$candidateUrl] = $true
        $candidateUrls.Add($candidateUrl)
    }
}

$clashYaml = $null
$clashUrl = $null
$downloadFailures = New-Object System.Collections.Generic.List[string]
foreach ($candidateUrl in $candidateUrls) {
    try {
        $candidateContent = Invoke-FlyingBirdWebRequest `
            -Uri $candidateUrl `
            -Headers $commonHeaders `
            -TimeoutSec 30
        $candidateYaml = Convert-FlyingBirdSubscriptionContentToClashYaml $candidateContent
        $resolution = Wait-ClashProxyServerResolution -Yaml $candidateYaml -Attempts 3 -DelaySeconds 2
        if ($resolution.ProxyCount -eq 0 -or $resolution.UniqueServerCount -eq 0) {
            throw "订阅未包含可验证的节点入口"
        }
        if ($resolution.ResolvableServerCount -eq 0) {
            throw "订阅的 $($resolution.UniqueServerCount) 个节点入口域名全部无法解析"
        }
        if ($resolution.UnresolvableServerCount -gt 0) {
            Write-Warning "候选订阅中有 $($resolution.UnresolvableServerCount) 个节点入口域名无法解析"
        }
        $clashYaml = $candidateYaml
        $clashUrl = $candidateUrl
        break
    }
    catch {
        $candidateHost = ([Uri]$candidateUrl).Host
        $downloadFailures.Add("${candidateHost}: $($_.Exception.Message)")
    }
}

if (-not $clashYaml) {
    throw "所有订阅地址都拉取失败: $($downloadFailures -join ' | ')"
}

$resolvedRoutingTemplatePath = $RoutingTemplatePath
if (-not $resolvedRoutingTemplatePath) {
    $resolvedRoutingTemplatePath = Join-Path $PSScriptRoot "routing_template.yaml"
}
$routingResult = Apply-ClashRoutingTemplate `
    -ClashYaml $clashYaml `
    -TemplatePath $resolvedRoutingTemplatePath
$clashYaml = $routingResult.Yaml

$subscriptionHost = ([Uri]$clashUrl).Host
$token = $null
$authData = $null
$clashUrl = $null
$seenBaseUrls = $null
$seenCandidateUrls = $null
$baseCandidateUrls = $null
$candidateUrls = $null

$outPath = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $outPath | Out-Null
Write-Host "[+] 已拉取并解密订阅: $subscriptionHost"
Write-Host "[+] 已应用动态分流: $($routingResult.ProviderCount) 个规则集 / $($routingResult.RuleCount) 条编排规则"

$fullYamlPath = Join-Path $outPath "fb_clash.yaml"
$nodesYamlPath = Join-Path $outPath "fb_clash_nodes.yaml"
$linksPath = Join-Path $outPath "fb_v2rayn_links.txt"
$subB64Path = Join-Path $outPath "fb_v2rayn_subscription_base64.txt"
$metaPath = Join-Path $outPath "fb_meta.json"

Set-Content -LiteralPath $fullYamlPath -Value $clashYaml -Encoding UTF8

$lines = $clashYaml -split "`r?`n"
$start = -1
$end = $lines.Count
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^proxies:\s*$') {
        $start = $i
        continue
    }
    if ($start -ge 0 -and $i -gt $start -and $lines[$i] -and -not $lines[$i].StartsWith(" ") -and $lines[$i] -match '^(proxy-groups:|rules:)\s*$') {
        $end = $i
        break
    }
}
if ($start -lt 0) {
    throw "未找到 proxies 段"
}

$proxyLines = $lines[$start..($end - 1)]
Set-Content -LiteralPath $nodesYamlPath -Value ($proxyLines -join [Environment]::NewLine) -Encoding UTF8

$links = New-Object System.Collections.Generic.List[string]
$skipped = New-Object System.Collections.Generic.List[string]
$proxyCount = 0

foreach ($line in $proxyLines) {
    $trimmed = $line.Trim()
    if ($trimmed -notmatch '^- \{') { continue }
    $proxyCount++
    try {
        $jsonText = $trimmed.Substring(2).Trim()
        $proxy = $jsonText | ConvertFrom-Json
        $link = Convert-ProxyToLink $proxy
        if ($link) {
            $links.Add($link)
        } else {
            $skipped.Add("$($proxy.name) ($($proxy.type))")
        }
    }
    catch {
        $skipped.Add("节点转换失败")
    }
}

if ($proxyCount -eq 0) {
    throw "订阅的 proxies 不是可导出的行内格式"
}

Set-Content -LiteralPath $linksPath -Value ($links -join [Environment]::NewLine) -Encoding UTF8
$subB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($links -join "`n")))
Set-Content -LiteralPath $subB64Path -Value $subB64 -Encoding UTF8

$meta = [ordered]@{
    source = "account-api"
    api_base_url = $apiBase
    api_base_source = $apiBaseSource
    subscription_host = $subscriptionHost
    routing_template = $routingResult.TemplatePath
    routing_provider_count = $routingResult.ProviderCount
    routing_rule_count = $routingResult.RuleCount
    fetched_at_utc = [DateTime]::UtcNow.ToString("o")
    node_count = $proxyCount
    link_count = $links.Count
    skipped = @($skipped)
}

$meta | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $metaPath -Encoding UTF8

Write-Host "[+] 导出完成"
Write-Host "[+] Clash YAML: $fullYamlPath"
Write-Host "[+] Clash 节点段: $nodesYamlPath"
Write-Host "[+] v2rayN links: $linksPath"
Write-Host "[+] v2rayN base64 subscription body: $subB64Path"
Write-Host "[+] Meta: $metaPath"
Write-Host "[+] 节点数: $proxyCount"
Write-Host "[+] 可转换链接数: $($links.Count)"
if ($skipped.Count -gt 0) {
    Write-Host "[!] 跳过 $($skipped.Count) 个不支持/报错节点，详情见 fb_meta.json"
}
