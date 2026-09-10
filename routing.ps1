function Get-YamlTopLevelSection {
    param(
        [string]$Yaml,
        [string]$Key
    )

    $lines = [regex]::Split($Yaml, "\r?\n")
    $start = -1
    $headerPattern = '^' + [regex]::Escape($Key) + ':\s*(?:#.*)?$'
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $headerPattern) {
            $start = $i
            break
        }
    }
    if ($start -lt 0) { throw "YAML 缺少顶层 $Key 段" }

    $end = $lines.Count
    for ($i = $start + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^[A-Za-z0-9_-]+:\s*') {
            $end = $i
            break
        }
    }
    return ($lines[$start..($end - 1)] -join "`n").TrimEnd()
}

function Set-YamlTopLevelSection {
    param(
        [string]$Yaml,
        [string]$Key,
        [string]$Replacement
    )

    $lines = [regex]::Split($Yaml, "\r?\n")
    $replacementLines = [regex]::Split($Replacement.TrimEnd(), "\r?\n")
    $start = -1
    $headerPattern = '^' + [regex]::Escape($Key) + ':\s*(?:#.*)?$'
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $headerPattern) {
            $start = $i
            break
        }
    }
    if ($start -lt 0) {
        $insertAt = $lines.Count
        if ($Key -eq 'rule-providers') {
            for ($i = 0; $i -lt $lines.Count; $i++) {
                if ($lines[$i] -match '^rules:\s*$') {
                    $insertAt = $i
                    break
                }
            }
        }

        $output = New-Object System.Collections.Generic.List[string]
        for ($i = 0; $i -lt $insertAt; $i++) { $output.Add($lines[$i]) }
        foreach ($line in $replacementLines) { $output.Add($line) }
        for ($i = $insertAt; $i -lt $lines.Count; $i++) { $output.Add($lines[$i]) }
        return (($output.ToArray()) -join "`n").TrimEnd() + "`n"
    }

    $end = $lines.Count
    for ($i = $start + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^[A-Za-z0-9_-]+:\s*') {
            $end = $i
            break
        }
    }

    $output = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $start; $i++) { $output.Add($lines[$i]) }
    foreach ($line in $replacementLines) { $output.Add($line) }
    for ($i = $end; $i -lt $lines.Count; $i++) { $output.Add($lines[$i]) }
    return (($output.ToArray()) -join "`n").TrimEnd() + "`n"
}

function Get-ClashProxyNames {
    param([string]$Yaml)

    $lines = [regex]::Split($Yaml, "\r?\n")
    $insideProxies = $false
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
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
            if ($proxy.name) { $names.Add([string]$proxy.name) }
        }
        catch {
            throw "无法解析订阅节点以生成分流组"
        }
    }
    if ($names.Count -eq 0) { throw "订阅 YAML 中没有可用节点" }
    return $names.ToArray()
}

function Expand-RoutingNodeMarkers {
    param(
        [string]$TemplateYaml,
        [string[]]$ProxyNames
    )

    $output = New-Object System.Collections.Generic.List[string]
    foreach ($line in [regex]::Split($TemplateYaml, "\r?\n")) {
        $marker = [regex]::Match($line, '^(?<indent>\s*)-\s+["'']?__ALL_NODES__["'']?\s*$')
        if (-not $marker.Success) {
            $output.Add($line)
            continue
        }

        $indent = $marker.Groups['indent'].Value
        foreach ($name in $ProxyNames) {
            $escapedName = $name.Replace("'", "''")
            $output.Add("$indent- '$escapedName'")
        }
    }
    return ($output.ToArray()) -join "`n"
}

function Apply-ClashRoutingTemplate {
    param(
        [string]$ClashYaml,
        [string]$TemplatePath
    )

    if (-not (Test-Path -LiteralPath $TemplatePath -PathType Leaf)) {
        throw "分流模板不存在: $TemplatePath"
    }

    $proxyNames = @(Get-ClashProxyNames $ClashYaml)
    $templateYaml = Get-Content -Raw -LiteralPath $TemplatePath
    $expandedTemplate = Expand-RoutingNodeMarkers $templateYaml $proxyNames
    $resultYaml = $ClashYaml
    foreach ($key in @('dns', 'sniffer', 'proxy-groups', 'rule-providers', 'rules')) {
        if ($key -eq 'sniffer' -and $expandedTemplate -notmatch '(?m)^sniffer:\s*(?:#.*)?$') {
            continue
        }
        $section = Get-YamlTopLevelSection $expandedTemplate $key
        $resultYaml = Set-YamlTopLevelSection $resultYaml $key $section
    }

    $rulesSection = Get-YamlTopLevelSection $expandedTemplate 'rules'
    $providersSection = Get-YamlTopLevelSection $expandedTemplate 'rule-providers'
    $ruleCount = @([regex]::Matches($rulesSection, '(?m)^[ \t]*-[ \t]+')).Count
    $providerCount = @([regex]::Matches($providersSection, '(?m)^  [A-Za-z0-9_-]+:\s*$')).Count
    return [pscustomobject]@{
        Yaml = $resultYaml
        ProxyCount = $proxyNames.Count
        ProviderCount = $providerCount
        RuleCount = $ruleCount
        TemplatePath = (Resolve-Path -LiteralPath $TemplatePath).Path
    }
}
