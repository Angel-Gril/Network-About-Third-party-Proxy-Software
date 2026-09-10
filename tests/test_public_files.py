import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from scripts.check_public_files import findings_for, scan_repository


class PublicationChecksTests(unittest.TestCase):
    def test_reports_secret_location_without_echoing_value(self):
        token = 'ghp_' + 'x' * 36
        findings = findings_for('notes.md', ('credential: ' + token).encode())
        self.assertEqual(findings[0]['rule'], 'github-token')
        self.assertNotIn(token, json.dumps(findings))

    def test_rejects_private_paths_even_if_their_contents_look_harmless(self):
        for name in ('exports/subscription.yaml', '.env', 'private/session.json', 'key.pem', '.vps-work/result.json'):
            with self.subTest(name=name):
                self.assertTrue(findings_for(name, b'synthetic'))

    def test_allows_reviewed_examples_and_public_api_addresses(self):
        content = b'API=https://api.feiyue66.app/vlcs\nACCESS_KEY=""\n'
        self.assertEqual(findings_for('.dev.vars.example', content), [])

    def test_flags_complete_connection_urls_to_non_example_hosts(self):
        link = 'vless://' + '11111111-1111-4111-8111-111111111111' + '@edge.vendor.tld:443'
        self.assertEqual(findings_for('notes.md', link.encode())[0]['rule'], 'credential-bearing-url')
        self.assertEqual(findings_for('notes.md', link.replace('edge.vendor.tld', 'edge.example.invalid').encode()), [])

    def test_supports_private_markers_without_printing_them(self):
        marker = 'synthetic-deployment-marker'
        findings = findings_for('README.md', marker.encode(), [marker])
        self.assertEqual(findings[0]['rule'], 'private-publication-marker')
        self.assertNotIn(marker, json.dumps(findings))

    def test_uri_builders_are_not_mistaken_for_materialized_credentials(self):
        for template in ('vless://${userinfo}@${host}:${port}', 'trojan://$userinfo@$hostPart'):
            with self.subTest(template=template):
                self.assertEqual(findings_for('builder.py', template.encode()), [])

    def test_staged_scan_reads_the_index_even_if_working_copy_was_cleaned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True, capture_output=True)
            secret = 'ghp_' + 'a' * 36
            (root / 'notes.md').write_text(secret)
            subprocess.run(['git', 'add', '--', 'notes.md'], cwd=root, check=True, capture_output=True)
            (root / 'notes.md').write_text('clean working copy')
            self.assertEqual(scan_repository(root)[1], [])
            staged = scan_repository(root, staged=True)[1]
            self.assertEqual(staged[0]['rule'], 'github-token')
            self.assertNotIn(secret, json.dumps(staged))


if __name__ == '__main__':
    unittest.main()
