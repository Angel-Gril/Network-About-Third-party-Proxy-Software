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
                             '/etc/private-subscription/monocloud.json',
                             '/var/lib/private-subscription/read-tokens/flybird',
                             '/var/lib/private-subscription/read-tokens/leapvpn',
                             '/var/lib/private-subscription/read-tokens/monocloud',
                             '/var/lib/private-subscription/state/subscription-server/refresh-settings.json',
                             '/etc/nginx/private-subscription.htpasswd'):
                with self.subTest(existing=existing):
                    trace.write_text('')
                    result = subprocess.run([bash, '-c', harness, '--', script.as_posix()],
                        env={**os.environ, 'EXISTING_FILE': existing, 'CALLS_LOG': trace.as_posix()},
                        capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertEqual(trace.read_text(), '')

    def test_systemd_units_use_the_configurable_scheduler_and_writable_state(self):
        systemd = Path(__file__).resolve().parents[1] / 'deploy/systemd'
        service = (systemd / 'private-subscription-refresh@.service').read_text()
        web = (systemd / 'private-subscription.service').read_text()
        self.assertIn('src/scheduled-refresh.mjs %i', service)
        self.assertIn('/var/lib/private-subscription/state/subscription-server', service)
        self.assertIn('/var/lib/private-subscription/state/subscription-server', web)
        for name in ('flybird', 'leapvpn', 'monocloud'):
            timer = (systemd / f'private-subscription-refresh-{name}.timer').read_text()
            self.assertIn('/5:00', timer)
            self.assertIn(f'Unit=private-subscription-refresh@{name}.service', timer)


if __name__ == '__main__':
    unittest.main()
