"""Offline checks for explicit destinations and portable receiver configuration."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from export_leapvpn import ExportError


class CatalogueBoundaryReached(Exception):
    pass


def receiver_module():
    spec = importlib.util.spec_from_file_location('receiver_subject', Path(__file__).with_name('receive_vps_session.py'))
    module = importlib.util.module_from_spec(spec)
    # The receiver's POSIX account lookups are outside these configuration tests.
    replacements = {name: types.ModuleType(name) for name in ('grp', 'pwd')} if os.name == 'nt' else {}
    with patch.dict(sys.modules, replacements):
        spec.loader.exec_module(module)
    return module


class PortableSessionToolsTests(unittest.TestCase):
    def test_sender_requires_explicit_host_and_identity_before_reading_state(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = str(Path(directory) / 'absent-settings.json')
            for extra in ([], ['--host', 'operator@host.example.invalid']):
                with self.subTest(arguments=extra):
                    result = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('sync_vps_session.py')),
                                             '--settings', missing, *extra], capture_output=True, text=True)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn('--identity', result.stderr)

    def run_receiver_until_catalogue(self, domain):
        subject = receiver_module()
        state = {'baseURL': 'https://api.example.invalid',
                 'sessionToken': {'id': 'synthetic-session', 'expiredAt': 4102444800000},
                 'user': {'id': 'synthetic-device'}}
        with patch.object(subject.argparse.ArgumentParser, 'parse_args', return_value=types.SimpleNamespace(no_refresh=True)), \
             patch.object(subject.os, 'geteuid', return_value=0, create=True), \
             patch.object(subject.Path, 'read_text', return_value='PUBLIC_DOMAIN=' + domain + '\n'), \
             patch.object(subject.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(state).encode()))), \
             patch.object(subject.requests, 'Session', side_effect=CatalogueBoundaryReached):
            subject.main()

    def test_receiver_accepts_operator_configured_domain(self):
        with self.assertRaises(CatalogueBoundaryReached):
            self.run_receiver_until_catalogue('subscriptions.example.invalid')

    def test_receiver_rejects_non_origin_configuration_before_api_access(self):
        for domain in ('', 'https://subscriptions.example.invalid/path', 'user@subscriptions.example.invalid',
                       'subscriptions.example.invalid/path', 'subscriptions.example.invalid?token=synthetic',
                       'two hosts.example.invalid'):
            with self.subTest(domain=domain), self.assertRaises(ValueError):
                self.run_receiver_until_catalogue(domain)

    def test_failed_first_sync_leaves_new_state_owned_by_the_service_account(self):
        subject = receiver_module()
        account = types.SimpleNamespace(pw_uid=12345, pw_gid=12345)
        ownership = {}
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'state/session.json'
            credential_file = Path(directory) / 'account.json'
            credential_file.write_text(json.dumps({'email': 'owner@example.invalid', 'passwordSha256': '0' * 64}))
            env = {'LEAPVPN_AUTH_STATE_FILE': str(target), 'LEAPVPN_CREDENTIAL_FILE': str(credential_file)}
            def set_owner(path, uid, gid):
                self.assertTrue(Path(path).exists())
                ownership[str(path)] = (uid, gid)
            with patch.object(subject.pwd, 'getpwnam', return_value=account, create=True), \
                 patch.object(subject.os, 'chown', side_effect=set_owner, create=True), \
                 patch('auth_leapvpn.import_client_session', side_effect=ExportError('Synthetic import failure')):
                with self.assertRaises(ExportError):
                    subject.synchronize_automatic({}, env)
            self.assertTrue(target.exists())
            self.assertEqual(ownership.get(str(target)), (account.pw_uid, account.pw_gid))


if __name__ == '__main__':
    unittest.main()
