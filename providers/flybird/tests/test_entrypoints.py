import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

PROVIDER = Path(__file__).resolve().parents[1]


class FlyingBirdEntrypointTests(unittest.TestCase):
    def invoke(self, arguments):
        spec = importlib.util.spec_from_file_location("flybird_export", PROVIDER / "src/export.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        original = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                with patch.object(sys, "argv", ["export.py", *arguments]), \
                     patch.object(module.shutil, "which", return_value="pwsh"), \
                     patch.object(module.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)) as run:
                    self.assertEqual(module.main(), 0)
                    return run.call_args.args[0]
            finally:
                os.chdir(original)

    def test_default_delegates_to_the_real_powershell_entry_from_any_directory(self):
        command = self.invoke([])
        entry = Path(command[command.index("-File") + 1])
        self.assertEqual(entry, PROVIDER / "src/export.ps1")
        self.assertTrue(entry.is_file())
        self.assertNotIn("-OutDir", command)

    def test_explicit_output_directory_is_forwarded_without_reinterpreting_it(self):
        command = self.invoke(["--outdir", "my-output"])
        self.assertEqual(command[command.index("-OutDir") + 1], "my-output")


if __name__ == "__main__":
    unittest.main()
