"""Offline regressions for PowerShell error handling and endpoint validation."""

import base64
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1] / "src"
SHELLS = list(dict.fromkeys(path for name in ("pwsh", "powershell") if (path := shutil.which(name))))
MARKER = "SENTINEL"


def ps_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def proxy_yaml(hosts):
    return "proxies:\n" + "".join(
        "  - " + json.dumps({"name": "Synthetic " + str(index), "server": host}) + "\n"
        for index, host in enumerate(hosts)
    )


def mock_web_request(body):
    return """
function Invoke-WebRequest {
    param($Uri, $Method, $Headers, $Body, $ContentType, $TimeoutSec,
          [switch]$UseBasicParsing, [switch]$NoProxy)
    $global:SyntheticRequestCount++
""" + body + "\n}\n"


@unittest.skipUnless(SHELLS, "PowerShell is not installed")
class PowerShellRegressionTests(unittest.TestCase):
    def run_script(self, shell, script, cwd=None):
        preamble = """
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$ProgressPreference = 'SilentlyContinue'
"""
        encoded = base64.b64encode((preamble + script).encode("utf-16-le")).decode("ascii")
        result = subprocess.run(
            [shell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-OutputFormat", "Text", "-EncodedCommand", encoded],
            cwd=cwd or ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=45, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout.strip().splitlines()[-1]), result.stdout + result.stderr

    def assert_export_failure_is_private(self, mock_body):
        with tempfile.TemporaryDirectory(prefix="flybird-errors-test-") as temporary:
            for shell in SHELLS:
                with self.subTest(shell=Path(shell).name):
                    script = "$global:SyntheticRequestCount = 0\n" + mock_web_request(mock_body) + """
$failed = $false
$message = ''
try {
    & './export.ps1' -Email 'owner@example.invalid' -Password 'synthetic-password' `
        -ApiBaseUrl 'https://api.example.invalid/api/v1' -OutDir """ + ps_literal(Path(temporary) / "output") + """
} catch {
    $failed = $true
    $message = $_.Exception.Message
}
[pscustomobject]@{ failed = $failed; error = $message; requests = $global:SyntheticRequestCount } | ConvertTo-Json -Compress
"""
                    result, output = self.run_script(shell, script)
                    self.assertTrue(result["failed"])
                    self.assertEqual(result["requests"], 1)
                    self.assertNotIn(MARKER, output)
                    self.assertFalse((Path(temporary) / "output").exists())

    def test_exporter_does_not_echo_failed_http_response_or_transport_error(self):
        self.assert_export_failure_is_private("""
    $exception = [System.Net.WebException]::new('SENTINEL')
    $record = [System.Management.Automation.ErrorRecord]::new(
        $exception, 'SyntheticUpstreamFailure', [System.Management.Automation.ErrorCategory]::ConnectionError, $null)
    $record.ErrorDetails = [System.Management.Automation.ErrorDetails]::new('body=SENTINEL')
    throw $record
""")

    def test_exporter_does_not_echo_rejected_login_payload(self):
        body = json.dumps({"status": "error", "message": MARKER})
        self.assert_export_failure_is_private("    [pscustomobject]@{ Content = " + ps_literal(body) + " }")

    def test_exporter_does_not_echo_invalid_login_json(self):
        self.assert_export_failure_is_private("    [pscustomobject]@{ Content = 'SENTINEL is not JSON' }")

    def test_subscription_info_errors_are_private_while_export_continues(self):
        login = json.dumps({"status": "success", "data": {"token": "synthetic-token", "auth_data": "synthetic-auth"}})
        yaml = 'proxies:\n  - {"name":"Synthetic","type":"vless","server":"203.0.113.10","port":443,"uuid":"11111111-1111-4111-8111-111111111111"}\n'
        replies = (json.dumps({"status": "error", "message": MARKER}), "SENTINEL is not JSON")
        for shell in SHELLS:
            for index, reply in enumerate(replies):
                with self.subTest(shell=Path(shell).name, response=index), tempfile.TemporaryDirectory(prefix="flybird-export-test-") as temporary:
                    destination = Path(temporary) / "output"
                    mock = mock_web_request(
                        "if ($Uri -like '*auth/login') { [pscustomobject]@{ Content = " + ps_literal(login) + " }; return }\n" +
                        "if ($Uri -like '*getSubscribe') { [pscustomobject]@{ Content = " + ps_literal(reply) + " }; return }\n" +
                        "if ($Uri -like '*client/subscribe*') { [pscustomobject]@{ Content = " + ps_literal(yaml) + " }; return }\n" +
                        "throw 'Unexpected synthetic API request'"
                    )
                    script = mock + "& './export.ps1' -Email 'owner@example.invalid' -Password 'synthetic-password' " + \
                        "-ApiBaseUrl 'https://api.example.invalid/api/v1' -OutDir " + ps_literal(destination) + "\n" + \
                        "[pscustomobject]@{ completed = $true } | ConvertTo-Json -Compress"
                    result, output = self.run_script(shell, script)
                    self.assertTrue(result["completed"])
                    self.assertNotIn(MARKER, output)
                    self.assertIn('"name":"Synthetic"', (destination / "fb_clash.yaml").read_text(encoding="utf-8-sig"))
                    self.assertNotIn(MARKER, (destination / "fb_meta.json").read_text(encoding="utf-8-sig"))

    def test_export_from_another_directory_resolves_resources_and_output_locations(self):
        login = json.dumps({"status": "success", "data": {"token": "synthetic-token", "auth_data": "synthetic-auth"}})
        subscription = 'proxies:\n  - {"name":"Synthetic","type":"vless","server":"203.0.113.10","port":443,"uuid":"11111111-1111-4111-8111-111111111111"}\n'
        mock = mock_web_request(
            "if ($Uri -like '*auth/login') { [pscustomobject]@{ Content = " + ps_literal(login) + " }; return }\n" +
            "if ($Uri -like '*getSubscribe') { [pscustomobject]@{ Content = '{\"status\":\"error\"}' }; return }\n" +
            "if ($Uri -like '*client/subscribe*') { [pscustomobject]@{ Content = " + ps_literal(subscription) + " }; return }\n" +
            "throw 'Unexpected synthetic API request'"
        )
        for shell in SHELLS:
            for explicit_output in (False, True):
                with self.subTest(shell=Path(shell).name, explicit_output=explicit_output), \
                     tempfile.TemporaryDirectory(prefix="flybird-layout-test-") as temporary:
                    repository = Path(temporary) / "repository with spaces"
                    provider = repository / "providers/flybird"
                    source = provider / "src"
                    source.mkdir(parents=True)
                    for name in ("export.ps1", "routing.ps1", "validation.ps1", "profile_codec.ps1"):
                        shutil.copy2(ROOT / name, source / name)
                    shutil.copytree(ROOT.parent / "templates", provider / "templates")
                    caller = Path(temporary) / "unrelated working directory"
                    caller.mkdir()
                    script = "Set-Location -LiteralPath " + ps_literal(caller) + "\n" + mock + "& " + ps_literal(source / "export.ps1") + \
                        " -Email 'owner@example.invalid' -Password 'synthetic-password'" + \
                        " -ApiBaseUrl 'https://api.example.invalid/api/v1'"
                    if explicit_output:
                        script += " -OutDir 'my-output'"
                    script += "\n[pscustomobject]@{ completed = $true } | ConvertTo-Json -Compress"
                    result, _ = self.run_script(shell, script, cwd=repository)
                    self.assertTrue(result["completed"])
                    destination = caller / "my-output" if explicit_output else repository / "exports/flybird"
                    self.assertTrue(destination.is_dir(), "Export must follow the PowerShell location after Set-Location")
                    config = yaml.safe_load((destination / "fb_clash.yaml").read_text(encoding="utf-8-sig"))
                    metadata = json.loads((destination / "fb_meta.json").read_text(encoding="utf-8-sig"))
                    self.assertEqual(config["proxies"][0]["name"], "Synthetic")
                    self.assertTrue(config["rules"])
                    self.assertTrue(any("Synthetic" in group.get("proxies", []) for group in config["proxy-groups"]))
                    self.assertEqual(Path(metadata["routing_template"]).resolve(), (provider / "templates/mihomo.yaml").resolve())
                    self.assertTrue((destination / "fb_v2rayn_links.txt").read_text(encoding="utf-8-sig").startswith("vless://"))
                    self.assertFalse((caller / "exports").exists())

    def test_cache_upload_uses_the_powershell_location_after_set_location(self):
        subscription = 'proxies:\n  - {"name":"Caller 节点","type":"vless","server":"203.0.113.10","port":443,"uuid":"11111111-1111-4111-8111-111111111111"}\n'
        for shell in SHELLS:
            with self.subTest(shell=Path(shell).name), tempfile.TemporaryDirectory(prefix="flybird-cache-path-") as temporary:
                launcher = Path(temporary) / "launcher"
                caller = Path(temporary) / "caller"
                launcher.mkdir()
                caller.mkdir()
                (launcher / "subscription.yaml").write_text(subscription.replace("Caller", "Launcher"), encoding="utf-8")
                (caller / "subscription.yaml").write_text(subscription, encoding="utf-8")
                script = "Set-Location -LiteralPath " + ps_literal(caller) + "\n" + """
function Invoke-RestMethod {
    param($Uri, $Method, $ContentType, $Body)
    $global:UploadedYaml = ($Body | ConvertFrom-Json).clashYaml
    [pscustomobject]@{
        profile = [pscustomobject]@{ id = 'synthetic-profile'; cacheOnly = $true; nodeCount = 1 }
        links = [pscustomobject]@{ clash = 'https://worker.example.invalid/synthetic-subscription' }
    }
}
""" + "& " + ps_literal(ROOT / "sync_worker_cache.ps1") + \
                    " -WorkerUrl 'https://worker.example.invalid' -AccessKey 'synthetic-key' -YamlPath './subscription.yaml'\n" + \
                    "[pscustomobject]@{ yaml = $global:UploadedYaml } | ConvertTo-Json -Compress"
                result, _ = self.run_script(shell, script, cwd=launcher)
                self.assertEqual(result["yaml"].replace("\r\n", "\n"), subscription)

    def test_routing_parse_failure_does_not_echo_node_credentials(self):
        for shell in SHELLS:
            with self.subTest(shell=Path(shell).name):
                result, output = self.run_script(shell, """
. './routing.ps1'
$yaml = 'proxies:
  - {"name":"Invalid","password":"SENTINEL",
'
$failed = $false
try { Get-ClashProxyNames $yaml | Out-Null }
catch { $failed = $true; $message = $_.Exception.Message }
[pscustomobject]@{ failed = $failed; error = $message } | ConvertTo-Json -Compress
""")
                self.assertTrue(result["failed"])
                self.assertNotIn(MARKER, output)

    def test_fake_ip_literals_are_not_counted_as_valid_proxy_endpoints(self):
        yaml = proxy_yaml([
            "198.18.0.1", "198.19.255.254", "::ffff:198.18.1.2",
            "fdfe:dcba:9876::1", "FDFE:DCBA:9876::2", "203.0.113.10", "2001:db8::10",
        ])
        for shell in SHELLS:
            with self.subTest(shell=Path(shell).name):
                result, _ = self.run_script(shell, ". './validation.ps1'\n" +
                    "Get-ClashProxyServerResolutionSummary -Yaml " + ps_literal(yaml) + " | ConvertTo-Json -Compress")
                self.assertEqual(result["ResolvableServerCount"], 2)
                self.assertEqual(result["UnresolvableServerCount"], 5)

    def test_dns_validation_requires_a_real_answer_and_accepts_mixed_answers(self):
        yaml = proxy_yaml(["fake4.example", "fake6.example", "mapped.example", "mixed.example", "real.example", "missing.example"])
        for shell in SHELLS:
            with self.subTest(shell=Path(shell).name):
                result, _ = self.run_script(shell, """
. './validation.ps1'
if (-not (Get-Command Get-ClashProxyServerResolutionSummary).Parameters.ContainsKey('ResolveHost')) {
    throw 'Offline DNS resolver is unavailable; refusing a real DNS request'
}
$answers = @{
    'fake4.example' = @('198.18.0.1', '198.19.0.1')
    'fake6.example' = @('fdfe:dcba:9876::1')
    'mapped.example' = @('::ffff:198.18.1.2')
    'mixed.example' = @('198.18.0.1', '203.0.113.10')
    'real.example' = @('2001:db8::10')
    'missing.example' = @()
}
$resolver = { param($server) $answers[$server] }
Get-ClashProxyServerResolutionSummary -ResolveHost $resolver -Yaml """ + ps_literal(yaml) + " | ConvertTo-Json -Compress")
                self.assertEqual(result["ResolvableServerCount"], 2)
                self.assertEqual(result["UnresolvableServerCount"], 4)

    def test_fake_ip_is_rechecked_but_only_real_dns_records_are_accepted(self):
        for shell in SHELLS:
            with self.subTest(shell=Path(shell).name):
                result, _ = self.run_script(shell, """
. './validation.ps1'
$global:Queries = 0
$lookup = { param($name) [Net.IPAddress]::Parse('198.18.0.1') }
$query = {
    param($name, $type)
    $global:Queries++
    [pscustomobject]@{ Status = 0; Answer = @(
        [pscustomobject]@{ type = 5; data = '203.0.113.7' },
        [pscustomobject]@{ type = 1; data = '198.18.0.2' },
        [pscustomobject]@{ type = 1; data = '203.0.113.8' }
    ) }
}
$addresses = @(Resolve-ClashServerAddresses 'entry.example' -SystemLookup $lookup -DnsQuery $query)
[pscustomobject]@{ addresses = @($addresses | ForEach-Object { $_.ToString() }); queries = $global:Queries } | ConvertTo-Json -Compress
""")
                self.assertEqual(result["addresses"], ["203.0.113.8"])
                self.assertEqual(result["queries"], 1)

    def test_fake_ip_dns_recheck_failures_still_reject_the_endpoint(self):
        for shell in SHELLS:
            with self.subTest(shell=Path(shell).name):
                result, _ = self.run_script(shell, """
. './validation.ps1'
$lookup = { param($name) [Net.IPAddress]::Parse('198.18.0.1') }
$failed = @(Resolve-ClashServerAddresses 'entry.example' -SystemLookup $lookup -DnsQuery { throw 'Synthetic network failure' })
$missing = @(Resolve-ClashServerAddresses 'entry.example' -SystemLookup $lookup -DnsQuery { [pscustomobject]@{ Status = 3 } })
$fake = @(Resolve-ClashServerAddresses 'entry.example' -SystemLookup $lookup -DnsQuery {
    [pscustomobject]@{ Status = 0; Answer = @([pscustomobject]@{ type = 1; data = '198.18.0.2' }) }
})
[pscustomobject]@{ failed = $failed.Count; missing = $missing.Count; fake = $fake.Count } | ConvertTo-Json -Compress
""")
                self.assertEqual(result, {"failed": 0, "missing": 0, "fake": 0})

    def test_real_system_dns_does_not_call_an_external_resolver(self):
        for shell in SHELLS:
            with self.subTest(shell=Path(shell).name):
                result, _ = self.run_script(shell, """
. './validation.ps1'
$global:Queried = $false
$addresses = @(Resolve-ClashServerAddresses 'entry.example' -SystemLookup { [Net.IPAddress]::Parse('203.0.113.8') } -DnsQuery { $global:Queried = $true })
[pscustomobject]@{ count = $addresses.Count; queried = $global:Queried } | ConvertTo-Json -Compress
""")
                self.assertEqual(result, {"count": 1, "queried": False})


if __name__ == "__main__":
    unittest.main()
