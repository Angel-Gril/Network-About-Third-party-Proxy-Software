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
    def test_missing_ipv4_never_calls_renderer_or_replaces_last_good_output(self):
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
            cache = root / "cache"
            cache.mkdir()
            (cache / "flybird.yaml").write_text("last-good-cache")
            (cache / "flybird.json").write_text("{}")
            fetcher = root / "fetch.py"
            fetcher.write_text("import pathlib,sys\npathlib.Path(sys.argv[sys.argv.index('--out')+1]).write_text('synthetic raw')\n")
            node = root / "node.sh"
            node.write_bytes(b'''#!/usr/bin/env bash
case "$1" in
  *flybird-entries.mjs) exit 4 ;;
  --input-type=module) printf '%s' "${@: -1}" > "$TRACE"; cat >/dev/null; exit 0 ;;
  *) printf 'unexpected-renderer' > "$TRACE"; exit 99 ;;
esac
''')
            node.chmod(0o755)
            values = {"PYTHON": Path(sys.executable).as_posix(), "FETCHER": fetcher.as_posix(),
                      "NODE": node.as_posix(), "OUT": output.as_posix(), "LOGDIR": (root / "logs").as_posix(),
                      "RENDERER": (project / "src/render-flybird.mjs").as_posix(),
                      "PRIVATE_CACHE_DIR": cache.as_posix(), "PUBLIC_DOMAIN": "sub.example.invalid",
                      "PUBLISH_PRIVATE_SUBSCRIPTION": "1"}
            conf = root / "config"
            conf.write_bytes("\n".join(f"{k}={shlex.quote(v)}" for k, v in values.items()).encode())
            trace = root / "trace"
            result = subprocess.run([bash, "-c", 'flock() { return 0; }; export -f flock; exec bash "$1" run',
                                     "--", (project / "deploy/apex-fetch.sh").as_posix()],
                                    env={**os.environ, "APEX_CONF": conf.as_posix(), "TRACE": trace.as_posix()},
                                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertEqual(output.read_text(), "last-good-output")
            self.assertEqual((cache / "flybird.yaml").read_text(), "last-good-cache")
            self.assertIn("no validated IPv4", trace.read_text())
            self.assertEqual(list(root.glob("sub.yaml.refresh.*")), [])


if __name__ == "__main__":
    unittest.main()
