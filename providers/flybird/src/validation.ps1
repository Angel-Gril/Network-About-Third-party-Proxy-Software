function Set-FlyingBirdSubscriptionMetaFlag {
    param([Parameter(Mandatory = $true)][string]$Url)

    $builder = [UriBuilder]$Url
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($part in $builder.Query.TrimStart('?').Split('&', [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $name = $part.Split('=', 2)[0]
        if ([Uri]::UnescapeDataString($name) -ieq 'flag') { continue }
        $parts.Add($part)
    }
    $parts.Add('flag=meta')
    $builder.Query = $parts -join '&'
    return $builder.Uri.AbsoluteUri
}

function Test-ClashServerAddress {
    param([Parameter(Mandatory = $true)][Net.IPAddress]$Address)

    if ($Address.IsIPv4MappedToIPv6) { $Address = $Address.MapToIPv4() }
    $value = $Address.ToString().ToLowerInvariant()
    return ($value -notmatch '^198\.(18|19)\.' -and -not $value.StartsWith('fdfe:dcba:9876:'))
}

function Get-ClashProxyServerResolutionSummary {
    param(
        [Parameter(Mandatory = $true)][string]$Yaml,
        [scriptblock]$ResolveHost = { param($ServerName) [Net.Dns]::GetHostAddresses($ServerName) }
    )

    $servers = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $proxyCount = 0
    $insideProxies = $false
    foreach ($line in [regex]::Split($Yaml, "\r?\n")) {
        if ($line -match '^proxies:\s*$') {
            $insideProxies = $true
            continue
        }
        if ($insideProxies -and $line -match '^[A-Za-z0-9_-]+:\s*') { break }
        if (-not $insideProxies) { continue }

        $trimmed = $line.Trim()
        if ($trimmed -notmatch '^- \{') { continue }
        try {
            $proxy = $trimmed.Substring(2).Trim() | ConvertFrom-Json
            $proxyCount++
            if ($proxy.server) { [void]$servers.Add([string]$proxy.server) }
        }
        catch {
            throw "Unable to parse proxy entry while validating server hosts"
        }
    }

    $resolvable = 0
    $unresolvable = 0
    foreach ($server in $servers) {
        $address = $null
        if ([Net.IPAddress]::TryParse($server, [ref]$address)) {
            if (Test-ClashServerAddress $address) { $resolvable++ } else { $unresolvable++ }
            continue
        }
        try {
            $addresses = @(& $ResolveHost $server)
            $realAddresses = @($addresses | Where-Object { Test-ClashServerAddress $_ })
            if ($realAddresses.Count -gt 0) { $resolvable++ } else { $unresolvable++ }
        }
        catch {
            $unresolvable++
        }
    }

    return [pscustomobject]@{
        ProxyCount = $proxyCount
        UniqueServerCount = $servers.Count
        ResolvableServerCount = $resolvable
        UnresolvableServerCount = $unresolvable
    }
}

function Wait-ClashProxyServerResolution {
    param(
        [Parameter(Mandatory = $true)][string]$Yaml,
        [int]$Attempts = 3,
        [int]$DelaySeconds = 2
    )

    if ($Attempts -lt 1) { $Attempts = 1 }
    $summary = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $summary = Get-ClashProxyServerResolutionSummary $Yaml
        if ($summary.ResolvableServerCount -gt 0) { break }
        if ($attempt -lt $Attempts -and $DelaySeconds -gt 0) {
            Start-Sleep -Seconds $DelaySeconds
        }
    }
    return $summary
}
