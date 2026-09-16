"""Synthetic current-client protocol regressions for both PowerShell runtimes."""
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad
import yaml

import test_exporter as exporter_tests
from test_exporter import ROOT, SHELLS, mock_web_request, ps_literal

SECRET = b"fd53c838dbceff962d5d2aed5cdc548e"
KEY = hashlib.sha256(SECRET).digest()
NODE = {"name": "Synthetic 节点", "type": "vless", "server": "203.0.113.10", "port": 443,
        "uuid": "11111111-1111-4111-8111-111111111111", "tls": True, "servername": "tls.example",
        "flow": "xtls-rprx-vision", "network": "tcp", "skip-cert-verify": False}
YAML = "proxies:\n  - " + json.dumps(NODE, ensure_ascii=False, separators=(",", ":")) + "\n"


def envelope(text):
    nonce = bytes(range(12))
    cipher = AES.new(KEY, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(text.encode("utf-8"))
    return nonce + ciphertext + tag


@unittest.skipUnless(SHELLS, "PowerShell is not installed")
class CurrentProfileTests(unittest.TestCase):
    run_script = exporter_tests.PowerShellRegressionTests.run_script

    def export(self, shell, directory, response):
        directory = Path(directory)
        preferences = directory / "appdata/FlyingBird/FlyingBird"
        preferences.mkdir(parents=True)
        encrypted_api = "enc1:" + base64.urlsafe_b64encode(envelope("https://prefs.example.invalid/api/v1")).decode()
        (preferences / "shared_preferences.json").write_text(json.dumps({"flutter.api_base_url": encrypted_api}), encoding="utf-8")
        output = directory / "output"
        output.mkdir()
        (output / "fb_clash.yaml").write_text("last-good-sentinel", encoding="utf-8")
        login = json.dumps({"status": "success", "data": {"token": "synthetic-token", "auth_data": "synthetic-auth"}})
        mock = mock_web_request(
            "$global:LastApi = ([Uri]$Uri).Host\n"
            "if ($Uri -like '*auth/login') { [pscustomobject]@{ Content = " + ps_literal(login) + " }; return }\n"
            "if ($Uri -like '*getSubscribe') { [pscustomobject]@{ Content = '{\"status\":\"error\"}' }; return }\n"
            "if ($Uri -like '*client/subscribe*') {\n"
            " if ($Headers['User-Agent'] -ne 'securitynet/v3.1.8 clash-verge Platform/windows') { throw 'Old client rejected' }\n"
            " [pscustomobject]@{ Content = " + ps_literal(response) + " }; return }\n"
            "throw 'Unexpected request'"
        )
        script = "$env:APPDATA = " + ps_literal(directory / "appdata") + "\n$env:FLYBIRD_API_BASE_URL = $null\n" + mock
        script += "\n$failed = $false\ntry { & " + ps_literal(ROOT / "export.ps1")
        script += " -Email 'owner@example.invalid' -Password 'synthetic-password' -OutDir " + ps_literal(output)
        script += " } catch { $failed = $true }\n[pscustomobject]@{ failed = $failed; api = $global:LastApi } | ConvertTo-Json -Compress"
        result, logs = self.run_script(shell, script)
        return result, output, logs

    def test_encrypted_api_discovery_and_current_subscription_preserve_proxy_fields(self):
        for shell in SHELLS:
            with self.subTest(shell=Path(shell).name), tempfile.TemporaryDirectory() as directory:
                result, output, _ = self.export(shell, directory, base64.b64encode(envelope(YAML)).decode())
                self.assertFalse(result["failed"])
                self.assertEqual(result["api"], "prefs.example.invalid")
                config = yaml.safe_load((output / "fb_clash.yaml").read_text(encoding="utf-8-sig"))
                self.assertEqual(config["proxies"], [NODE])
                self.assertTrue((output / "fb_v2rayn_links.txt").read_text(encoding="utf-8-sig").startswith("vless://"))

    def test_tampered_current_subscription_cannot_replace_last_good_export(self):
        for shell in SHELLS:
            for offset in (0, 12, -1):
                with self.subTest(shell=Path(shell).name, offset=offset), tempfile.TemporaryDirectory() as directory:
                    bad = bytearray(envelope(YAML))
                    bad[offset] ^= 1
                    result, output, logs = self.export(shell, directory, base64.b64encode(bad).decode())
                    self.assertTrue(result["failed"])
                    self.assertEqual((output / "fb_clash.yaml").read_text(), "last-good-sentinel")
                    self.assertFalse((output / "fb_meta.json").exists())
                    self.assertNotIn(base64.b64encode(bad).decode(), logs)

    def test_legacy_encryption_remains_compatible(self):
        inner = base64.b64encode(YAML.encode())
        cipher = AES.new(b"14f521a32997b257", AES.MODE_CBC, iv=b"d217125f4b9cc9c8")
        legacy = base64.b64encode(cipher.encrypt(pad(inner, AES.block_size))).decode()
        for shell in SHELLS:
            with self.subTest(shell=Path(shell).name), tempfile.TemporaryDirectory() as directory:
                result, output, _ = self.export(shell, directory, legacy)
                self.assertFalse(result["failed"])
                self.assertEqual(yaml.safe_load((output / "fb_clash.yaml").read_text(encoding="utf-8-sig"))["proxies"], [NODE])


if __name__ == "__main__":
    unittest.main()
