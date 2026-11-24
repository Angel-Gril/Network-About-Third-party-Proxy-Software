"""Exercise the root wrapper's publication gate with isolated command doubles."""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest


class ApexPublishGateTests(unittest.TestCase):
    def test_failed_enhancement_preserves_raw_and_publishes_current_domain_configuration(self):
        if os.name == "nt":
            candidate = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
            bash = str(candidate) if candidate.is_file() else None
        else:
            bash = shutil.which("bash")
        if not bash:
            self.skipTest("Bash is required")
        project = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix="apex-gate-") as temporary:
            root = Path(temporary)
            output = root / "sub.yaml"
            output.write_text("last-good-output")
            enhanced = root / "enhanced.yaml"
            enhanced.write_text("last-good-enhanced")
            cache = root / "cache"
            cache.mkdir()
            (cache / "flybird.yaml").write_text("last-good-cache")
            (cache / "flybird.json").write_text("{}")
            fetcher = root / "fetch.py"
            raw = ('proxies:\n  - {name: Japan-01, type: anytls, server: entry.example.invalid, '
                   'port: 443, password: synthetic-password, sni: tls.example.invalid}\n'
                   'proxy-groups:\n  - {name: UPSTREAM, type: select, proxies: [Japan-01]}\nrules: [MATCH,UPSTREAM]\n')
            fetcher.write_text("import pathlib,sys\npathlib.Path(sys.argv[sys.argv.index('--out')+1]).write_text(" + repr(raw) + ")\n")
            node = root / "node.sh"
            node.write_bytes(b'''#!/usr/bin/env bash
case "$1" in
  *flybird-entries.mjs) exit 4 ;;
  *) exec "$REAL_NODE" "$@" ;;
esac
''')
            node.chmod(0o755)
            values = {"PYTHON": Path(sys.executable).as_posix(), "FETCHER": fetcher.as_posix(),
                      "NODE": node.as_posix(), "OUT": output.as_posix(), "LOGDIR": (root / "logs").as_posix(),
                      "RENDERER": (project / "src/render-flybird.mjs").as_posix(),
                      "RAW_OUT": (root / "raw.yaml").as_posix(), "ENHANCED_OUT": enhanced.as_posix(),
                      "PRIVATE_CACHE_DIR": cache.as_posix(), "PUBLIC_DOMAIN": "sub.example.invalid",
                      "PUBLISH_PRIVATE_SUBSCRIPTION": "0"}
            conf = root / "config"
            conf.write_bytes("\n".join(f"{k}={shlex.quote(v)}" for k, v in values.items()).encode())
            trace = root / "trace"
            result = subprocess.run([bash, "-c", 'flock() { return 0; }; export -f flock; exec bash "$1" run',
                                     "--", (project / "deploy/apex-fetch.sh").as_posix()],
                                    env={**os.environ, "APEX_CONF": conf.as_posix(), "TRACE": trace.as_posix(),
                                         "REAL_NODE": Path(shutil.which("node")).as_posix()},
                                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("entry.example.invalid", output.read_text(encoding="utf-8"))
            self.assertEqual((root / "raw.yaml").read_text(), raw)
            self.assertEqual(enhanced.read_text(), "last-good-enhanced")
            self.assertEqual((cache / "flybird.yaml").read_text(), "last-good-cache")
            import json
            metadata = json.loads((root / "sub.yaml.json").read_text())
            self.assertEqual(metadata["publicationMode"], "client-dns")
            self.assertEqual(metadata["enhancement"]["status"], "unavailable")
            self.assertEqual(list(root.glob("sub.yaml.refresh.*")), [])


if __name__ == "__main__":
    unittest.main()
