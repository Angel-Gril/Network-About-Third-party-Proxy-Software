"""Offline regressions for PowerShell error handling and endpoint validation."""

import base64
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
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
    def run_script(self, shell, script):
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
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
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
    & './export_fb_all.ps1' -Email 'owner@example.invalid' -Password 'synthetic-password' `
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
                    script = mock + "& './export_fb_all.ps1' -Email 'owner@example.invalid' -Password 'synthetic-password' " + \
                        "-ApiBaseUrl 'https://api.example.invalid/api/v1' -OutDir " + ps_literal(destination) + "\n" + \
                        "[pscustomobject]@{ completed = $true } | ConvertTo-Json -Compress"
                    result, output = self.run_script(shell, script)
                    self.assertTrue(result["completed"])
                    self.assertNotIn(MARKER, output)
                    self.assertIn('"name":"Synthetic"', (destination / "fb_clash.yaml").read_text(encoding="utf-8-sig"))
                    self.assertNotIn(MARKER, (destination / "fb_meta.json").read_text(encoding="utf-8-sig"))

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
                result, _ = self.run_script(shell, ". './subscription_validation.ps1'\n" +
                    "Get-ClashProxyServerResolutionSummary -Yaml " + ps_literal(yaml) + " | ConvertTo-Json -Compress")
                self.assertEqual(result["ResolvableServerCount"], 2)
                self.assertEqual(result["UnresolvableServerCount"], 5)

    def test_dns_validation_requires_a_real_answer_and_accepts_mixed_answers(self):
        yaml = proxy_yaml(["fake4.example", "fake6.example", "mapped.example", "mixed.example", "real.example", "missing.example"])
        for shell in SHELLS:
            with self.subTest(shell=Path(shell).name):
                result, _ = self.run_script(shell, """
. './subscription_validation.ps1'
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


if __name__ == "__main__":
    unittest.main()
