"""Exercise initialization's no-overwrite boundary without touching system files."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class ProvisioningTests(unittest.TestCase):
    def test_existing_installation_stops_before_generating_or_writing_secrets(self):
        if os.name == 'nt':
            bash = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/bin/bash.exe'
            bash = str(bash) if bash.is_file() else None
        else:
            bash = shutil.which('bash')
        if not bash:
            self.skipTest('Bash is required for the Linux provisioning guard test')
        script = Path(__file__).resolve().parents[1] / 'deploy/provision-secrets.sh'
        harness = r'''
test() {
  if [ "$1" = "-e" ] || [ "$1" = "-L" ]; then
    [ "$2" = "$EXISTING_FILE" ]
  else
    builtin test "$@"
  fi
}
openssl() { printf 'openssl\n' >> "$CALLS_LOG"; return 92; }
install() { printf 'install\n' >> "$CALLS_LOG"; return 93; }
htpasswd() { printf 'htpasswd\n' >> "$CALLS_LOG"; return 94; }
. "$1"
'''
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / 'calls.txt'
            for existing in ('/etc/private-subscription/service.env',
                             '/var/lib/private-subscription/read-tokens/flybird',
                             '/var/lib/private-subscription/read-tokens/leapvpn',
                             '/etc/nginx/private-subscription.htpasswd'):
                with self.subTest(existing=existing):
                    trace.write_text('')
                    result = subprocess.run([bash, '-c', harness, '--', script.as_posix()],
                        env={**os.environ, 'EXISTING_FILE': existing, 'CALLS_LOG': trace.as_posix()},
                        capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertEqual(trace.read_text(), '')


if __name__ == '__main__':
    unittest.main()
