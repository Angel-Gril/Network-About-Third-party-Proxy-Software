import base64
import copy
import json
from pathlib import Path
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch
import hashlib
import requests

from leapvpn.export import (
    ExportError, build_bundle, decode_settings, fetch_all, summarize, write_bundle,
)

# Independently generated with Go crypto/aes + crypto/cipher.NewGCM.
# Synthetic data only; this is not a captured client profile.
GO_GCM_FIXTURE = base64.b64decode(
    'AAECAwQFBgcICQoL60yi+z2AucVDD0JZP2DIPyK3hgmpfPAJ+wMOG4VtXbeH7cWc'
    'eGvuvv4iUcIVsMTpyn2gsEtntkBn2XcwaAhAGpPbZYtwTFP4JyTfJhzOv6NFeMnfl2'
    'JHunjXXwxVj25BZkYbgasGHS7obx8ZjTaGBBZHzeOHlWCd3TBoddeqC26L9vlgIGJFL'
    'AHA5ak57PpFrN7HlRVFTHRJ6uOauMEY9wF/sEIPBrpkPWmIYoT0zmV78zgH3JR7NCg/'
    'DJk1HL/MyFTL/KJ316VodIhF93HC0o25rto935QxYzJncFMFNaHHVc3m0EqCWjntHwJn'
    'WO3CCAN/nogET/fX7bNl4MgJTnhV66lihJMP1TBixZ7R/h+uqv97DhlQeoAs8K89FdDa'
    'dzc0jJjeGyKL1KaZ5tVW0rogy5hP4dWJV4sIK5mzkVuOLhCFwc/g5V8LJ3uV/boj6d'
    'Bw7EWNShsgo4W2A4A='
)
NOW = 1800000000000
FUTURE = 4102444800000
SETTINGS = {
    'protocolType': 1,
    'sessionToken': {
        'id': '11111111-1111-4111-8111-111111111111',
        'expiredAt': FUTURE,
    },
    'privateKey': {
        'host': 'vpn.example.invalid:8443/ws?ed=2048',
        'expireAt': FUTURE,
    },
    'user': {'id': 'not-the-vless-id', 'email': 'private@example.invalid'},
    'password': 'not-for-export',
    'locations': [{'host': 'another.example.invalid'}],
}


class ExportTests(unittest.TestCase):
    def test_reads_independent_go_ciphertext(self):
        self.assertEqual(decode_settings(GO_GCM_FIXTURE), SETTINGS)

    def test_detects_modified_nonce_ciphertext_and_tag(self):
        for offset in (0, 24, len(GO_GCM_FIXTURE) - 1):
            with self.subTest(offset=offset):
                changed = bytearray(GO_GCM_FIXTURE)
                changed[offset] ^= 1
                with self.assertRaises(ExportError):
                    decode_settings(bytes(changed))

    def test_reads_plain_json_as_the_client_does(self):
        self.assertEqual(decode_settings(json.dumps(SETTINGS).encode()), SETTINGS)

    def test_rejects_wrong_documents_and_truncation(self):
        for data in (b'{}', b'[]', b'<html>login</html>', b'abc', GO_GCM_FIXTURE[:25]):
            with self.subTest(length=len(data)):
                with self.assertRaises(ExportError):
                    decode_settings(data)

    def test_exports_cached_endpoint_and_session_token(self):
        bundle = build_bundle(SETTINGS, now_ms=NOW)
        clash = json.loads(bundle['leap_clash.yaml'])
        node = clash['proxies'][0]
        self.assertEqual(len(clash['proxies']), 1)
        self.assertEqual(node['server'], 'vpn.example.invalid')
        self.assertEqual(node['port'], 8443)
        self.assertEqual(node['uuid'], SETTINGS['sessionToken']['id'])
        self.assertEqual(node['ws-opts']['path'], '/ws?ed=2048')
        self.assertTrue(node['tls'])
        self.assertTrue(node['skip-cert-verify'])
        xray = json.loads(bundle['leap_xray.json'])
        outbound = xray['outbounds'][0]
        self.assertEqual(outbound['settings']['vnext'][0]['users'][0]['id'], node['uuid'])
        self.assertEqual(outbound['streamSettings']['wsSettings']['path'], '/ws?ed=2048')
        self.assertTrue(all(i['listen'] == '127.0.0.1' for i in xray['inbounds']))
        self.assertNotIn('another.example.invalid', '\n'.join(bundle.values()))

    def test_link_preserves_nested_query_in_websocket_path(self):
        bundle = build_bundle(SETTINGS, now_ms=NOW)
        link = urlsplit(bundle['leap_vless.txt'].strip())
        self.assertEqual(link.scheme, 'vless')
        self.assertEqual(link.username, SETTINGS['sessionToken']['id'])
        self.assertEqual(parse_qs(link.query)['path'], ['/ws?ed=2048'])
        self.assertEqual(link.port, 8443)

    def test_uses_default_tls_port_and_ipv6_authority(self):
        for endpoint, host, port in (
            ('vpn.example.invalid/path', 'vpn.example.invalid', 443),
            ('[2001:db8::1]:9443/path', '2001:db8::1', 9443),
        ):
            with self.subTest(endpoint=endpoint):
                settings = copy.deepcopy(SETTINGS)
                settings['privateKey']['host'] = endpoint
                bundle = build_bundle(settings, now_ms=NOW)
                node = json.loads(bundle['leap_clash.yaml'])['proxies'][0]
                self.assertEqual((node['server'], node['port']), (host, port))
                self.assertEqual(urlsplit(bundle['leap_vless.txt']).hostname, host)

    def test_short_xray_id_uses_nil_namespace_uuid_v5(self):
        settings = copy.deepcopy(SETTINGS)
        settings['sessionToken']['id'] = 'test'
        node = json.loads(build_bundle(settings, now_ms=NOW)['leap_clash.yaml'])['proxies'][0]
        self.assertEqual(node['uuid'], 'e8b764da-5fe5-51ed-8af8-c5c6eca28d7a')

    def test_refuses_wireguard_and_missing_connection(self):
        settings = copy.deepcopy(SETTINGS)
        settings['protocolType'] = 0
        with self.assertRaises(ExportError):
            build_bundle(settings, now_ms=NOW)
        settings['protocolType'] = 1
        settings['privateKey']['host'] = ''
        with self.assertRaises(ExportError):
            build_bundle(settings, now_ms=NOW)

    def test_refuses_expired_token_or_connection(self):
        for field, expires in (('sessionToken', 'expiredAt'), ('privateKey', 'expireAt')):
            settings = copy.deepcopy(SETTINGS)
            settings[field][expires] = NOW - 1
            with self.subTest(field=field), self.assertRaises(ExportError):
                build_bundle(settings, now_ms=NOW)

    def test_rejects_url_or_invalid_port_in_cached_host(self):
        for endpoint in ('https://vpn.example.invalid/path', 'x:70000/ws', 'user@host/ws', 'x:abc/ws'):
            settings = copy.deepcopy(SETTINGS)
            settings['privateKey']['host'] = endpoint
            with self.subTest(endpoint=endpoint), self.assertRaises(ExportError):
                build_bundle(settings, now_ms=NOW)

    def test_summary_and_metadata_do_not_expose_account_secrets(self):
        summary = json.dumps(summarize(SETTINGS))
        bundle = build_bundle(SETTINGS, now_ms=NOW)
        for value in ('private@example.invalid', 'not-for-export', 'not-the-vless-id'):
            self.assertNotIn(value, summary)
            self.assertNotIn(value, '\n'.join(bundle.values()))
        self.assertNotIn(SETTINGS['sessionToken']['id'], summary)
        self.assertNotIn(SETTINGS['sessionToken']['id'], bundle['leap_meta.json'])
        self.assertFalse(json.loads(bundle['leap_meta.json'])['connectivity_verified'])

    def test_summary_never_echoes_non_numeric_metadata(self):
        settings = copy.deepcopy(SETTINGS)
        settings['protocolType'] = 'private@example.invalid'
        settings['sessionToken']['expiredAt'] = settings['sessionToken']['id']
        settings['privateKey']['expireAt'] = {'password': 'not-for-export'}
        summary = json.dumps(summarize(settings))
        for value in ('private@example.invalid', SETTINGS['sessionToken']['id'], 'not-for-export'):
            self.assertNotIn(value, summary)

    def test_creates_private_outputs_and_refuses_existing_directory(self):
        with tempfile.TemporaryDirectory() as work:
            destination = Path(work) / 'out'
            bundle = build_bundle(SETTINGS, now_ms=NOW)
            write_bundle(bundle, destination)
            self.assertEqual((destination / '.gitignore').read_text().strip(), '*')
            for name, content in bundle.items():
                self.assertEqual((destination / name).read_text(encoding='utf-8'), content)
            with self.assertRaises(ExportError):
                write_bundle(bundle, destination)
            self.assertEqual((destination / 'leap_vless.txt').read_text(), bundle['leap_vless.txt'])


def response(status, data):
    result = requests.Response()
    result.status_code = status
    result._content = json.dumps(data).encode()
    return result


class FetchTests(unittest.TestCase):
    def settings(self):
        result = copy.deepcopy(SETTINGS)
        result['baseURL'] = 'https://api.example.invalid'
        result['protocolType'] = 0
        result['privateKey'] = {}
        return result

    def locations(self):
        return {'categories': [{'categoryName': 'Region', 'locations': [
            {'host': 'location-one', 'locationName': 'One'},
            {'host': 'location-two', 'locationName': 'Two'},
        ]}]}

    @patch('requests.Session')
    def test_fetches_each_location_with_its_own_returned_endpoint(self, factory):
        client = factory.return_value.__enter__.return_value
        client.request.side_effect = [
            response(200, self.locations()),
            response(200, {'status': 0, 'host': 'one.example.invalid:443/a'}),
            response(200, {'status': 0, 'host': 'two.example.invalid:8443/b'}),
        ]
        bundle = fetch_all(self.settings())
        nodes = json.loads(bundle['leap_clash.yaml'])['proxies']
        self.assertEqual([n['server'] for n in nodes], ['one.example.invalid', 'two.example.invalid'])
        self.assertEqual([n['ws-opts']['path'] for n in nodes], ['/a', '/b'])
        self.assertEqual(len(bundle['leap_vless.txt'].splitlines()), 2)
        self.assertEqual(len({n['name'] for n in nodes}), 2)
        calls = client.request.call_args_list
        self.assertEqual(calls[0].args, ('GET', 'https://api.example.invalid/vlcs'))
        for call, host in zip(calls[1:], ['location-one', 'location-two']):
            self.assertEqual(call.args[0], 'POST')
            self.assertEqual(call.kwargs['json'], {'userId': SETTINGS['user']['id'], 'host': host, 'p': 'x'})
            self.assertFalse(call.kwargs['allow_redirects'])
            self.assertIn('restart=false', call.args[1])
            headers = call.kwargs['headers']
            self.assertEqual(headers['X-ML-Token'], SETTINGS['sessionToken']['id'])
            expected = hashlib.sha256(('lc' + headers['X-ML-AppId'] + '@' + headers['X-ML-ReqId']).encode()).hexdigest()[-8:]
            self.assertEqual(headers['X-ML-ReqHash'], expected)
        self.assertEqual(json.loads(bundle['leap_meta.json'])['exported_node_count'], 2)

    @patch('requests.Session')
    def test_reports_denied_locations_without_leaking_server_message(self, factory):
        client = factory.return_value.__enter__.return_value
        client.request.side_effect = [
            response(200, self.locations()),
            response(403, {'message': 'private@example.invalid', 'errorCode': 'denied'}),
            response(200, {'status': 0, 'host': 'two.example.invalid:443/b'}),
        ]
        bundle = fetch_all(self.settings())
        meta = json.loads(bundle['leap_meta.json'])
        self.assertEqual(meta['exported_node_count'], 1)
        self.assertEqual(meta['failed_node_count'], 1)
        self.assertNotIn('private@example.invalid', '\n'.join(bundle.values()))

    @patch('requests.Session')
    def test_stops_batch_on_rate_limit(self, factory):
        client = factory.return_value.__enter__.return_value
        client.request.side_effect = [response(200, self.locations()), response(429, {})]
        with self.assertRaises(ExportError):
            fetch_all(self.settings())
        self.assertEqual(client.request.call_count, 2)

    @patch('requests.Session')
    def test_refuses_expired_session_before_network(self, factory):
        settings = self.settings()
        settings['sessionToken']['expiredAt'] = 1
        with self.assertRaises(ExportError):
            fetch_all(settings)
        factory.assert_not_called()


if __name__ == '__main__':
    unittest.main()
