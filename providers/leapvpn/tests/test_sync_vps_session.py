import json
import unittest

from leapvpn.sync import session_payload
from leapvpn.auth import import_client_session
from leapvpn.export import ExportError


class SessionSyncTests(unittest.TestCase):
    def test_minimal_sync_preserves_renewal_credentials_and_rejects_device_switch(self):
        current = {"email": "11111111-1111-4111-8111-111111111111",
                   "password": "22222222-2222-4222-8222-222222222222",
                   "user": {"id": "same-device", "groupEmail": "owner@example.invalid"}}
        incoming = {"user": {"id": "same-device"}, "sessionToken": {"id": "new-token"}}
        result = import_client_session(current, incoming)
        self.assertEqual(result["password"], current["password"])
        self.assertEqual(result["user"]["groupEmail"], current["user"]["groupEmail"])
        incoming["user"]["id"] = "other-device"
        with self.assertRaises(ExportError):
            import_client_session(current, incoming)

    def test_automatic_sync_explicitly_includes_device_login(self):
        source = {"baseURL": "https://api.example.invalid", "apiHosts": [],
                  "email": "11111111-1111-4111-8111-111111111111",
                  "password": "22222222-2222-4222-8222-222222222222",
                  "user": {"id": "device", "groupEmail": "owner@example.invalid"},
                  "sessionToken": {"id": "session"}, "privateKey": {"privateKey": "never-sync"},
                  "cloudyParameter": {"muxSize": "8", "lvfilepath": "https://discovery.example.invalid/"}}
        result = session_payload(source, True)
        self.assertEqual(result["deviceLogin"], {"email": source["email"], "password": source["password"]})
        self.assertEqual(result["user"]["groupEmail"], source["user"]["groupEmail"])
        self.assertNotIn("never-sync", json.dumps(result))

    def test_sends_only_required_session_fields(self):
        source = {
            "baseURL": "https://api.example.invalid", "apiHosts": [],
            "email": "private@example.invalid", "password": "account-password",
            "sessionToken": {"id": "test-session", "expiredAt": 4102444800000, "extra": "omit-token-extra"},
            "user": {"id": "test-device", "expiredAt": 4102444800000, "email": "private@example.invalid"},
            "privateKey": {"privateKey": "omit-tunnel-private-key"},
            "cloudyParameter": {"muxSize": "8", "websitePath": "omit-website"},
        }
        result = session_payload(source)
        text = json.dumps(result)
        self.assertEqual(result["sessionToken"]["id"], "test-session")
        self.assertEqual(result["user"]["id"], "test-device")
        self.assertEqual(result["privateKey"], {})
        for private in ("private@example.invalid", "account-password", "omit-token-extra", "omit-tunnel-private-key", "omit-website"):
            self.assertNotIn(private, text)


if __name__ == "__main__":
    unittest.main()
