import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from Crypto.Cipher import AES
import requests

from export_leapvpn import ExportError, _ApiError
from auth_leapvpn import (
    ApiClient, MANIFEST_KEY, MANIFEST_NONCE, decode_api_manifest,
    ensure_authenticated, fetch_authenticated, load_state, prepare_credentials,
    save_state, state_lock,
)

NOW = int(time.time() * 1000)
FUTURE = NOW + 365 * 86400000
USER_ID = "11111111-1111-4111-8111-111111111111"
OLD_TOKEN = "22222222-2222-4222-8222-222222222222"
NEW_TOKEN = "33333333-3333-4333-8333-333333333333"
ACCOUNT = {"email": "owner@example.invalid", "password": "test-account-password"}
STATE = {
    "baseURL": "https://api.example.invalid", "apiHosts": [],
    "email": "44444444-4444-4444-8444-444444444444",
    "password": "55555555-5555-4555-8555-555555555555",
    "user": {"id": USER_ID, "groupEmail": ACCOUNT["email"], "expiredAt": FUTURE,
             "username": "Subscription VPS", "osVersion": "Windows 11"},
    "sessionToken": {"id": OLD_TOKEN, "userId": USER_ID, "expiredAt": FUTURE},
    "privateKey": {}, "protocolType": 1,
}


def renewed(bound=True):
    user = copy.deepcopy(STATE["user"])
    if not bound:
        user["groupEmail"] = ""
    return {"user": user, "sessionToken": {"id": NEW_TOKEN, "userId": USER_ID, "expiredAt": FUTURE}}


class FakeApi:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def request(self, method, path, token="", body=None):
        self.calls.append((method, path, token, body))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return copy.deepcopy(reply)


class AuthenticationTests(unittest.TestCase):
    def test_password_is_hashed_once_and_never_trimmed(self):
        result = prepare_credentials({"email": ACCOUNT["email"], "password": " secret "})
        self.assertEqual(result, {"email": ACCOUNT["email"], "passwordSha256": hashlib.sha256(b" secret ").hexdigest()})
        self.assertEqual(prepare_credentials(result), result)
        with self.assertRaises(ExportError):
            prepare_credentials({"email": ACCOUNT["email"], "passwordSha256": "not-a-hash"})

    def test_expired_session_uses_device_password_and_keeps_account_binding(self):
        state = copy.deepcopy(STATE)
        state["sessionToken"]["expiredAt"] = NOW - 1
        api = FakeApi([renewed(), STATE["user"]])
        result = ensure_authenticated(state, prepare_credentials(ACCOUNT), api, now_ms=NOW)
        self.assertTrue(result["session_renewed"])
        self.assertEqual(state["sessionToken"]["id"], NEW_TOKEN)
        self.assertEqual(api.calls[0], ("POST", "/userLogin", "", {"email": STATE["email"], "password": STATE["password"]}))
        self.assertEqual(api.calls[1][2], NEW_TOKEN)
        self.assertFalse(any(call[1] == "/group/login" for call in api.calls))

    def test_renews_before_next_scheduled_refresh(self):
        state = copy.deepcopy(STATE)
        state["sessionToken"]["expiredAt"] = NOW + 6 * 3600000
        api = FakeApi([renewed(), STATE["user"]])
        self.assertTrue(ensure_authenticated(state, prepare_credentials(ACCOUNT), api, now_ms=NOW)["session_renewed"])

    def test_valid_session_is_checked_without_another_login(self):
        state = copy.deepcopy(STATE)
        api = FakeApi([STATE["user"]])
        self.assertFalse(ensure_authenticated(state, prepare_credentials(ACCOUNT), api, now_ms=NOW)["session_renewed"])
        self.assertEqual(len(api.calls), 1)
        self.assertEqual(api.calls[0][:2], ("PUT", "/users/" + USER_ID))

    def test_revoked_session_with_observed_empty_500_is_recovered_once(self):
        state = copy.deepcopy(STATE)
        api = FakeApi([_ApiError(500), renewed(), STATE["user"]])
        self.assertTrue(ensure_authenticated(state, prepare_credentials(ACCOUNT), api, now_ms=NOW)["session_renewed"])
        self.assertEqual([c[1] for c in api.calls], ["/users/" + USER_ID, "/userLogin", "/users/" + USER_ID])

    def test_repeated_authentication_failure_is_bounded(self):
        api = FakeApi([_ApiError(401), renewed(), _ApiError(401)])
        with self.assertRaises(_ApiError):
            ensure_authenticated(copy.deepcopy(STATE), prepare_credentials(ACCOUNT), api, now_ms=NOW)
        self.assertEqual(len(api.calls), 3)

    def test_account_login_binds_one_persistent_device(self):
        state = copy.deepcopy(STATE)
        state["user"] = {}
        state["sessionToken"] = {}
        unbound = renewed(False)["user"]
        api = FakeApi([renewed(False), unbound, {"email": ACCOUNT["email"]}, STATE["user"]])
        result = ensure_authenticated(state, prepare_credentials(ACCOUNT), api, now_ms=NOW)
        self.assertTrue(result["account_login"])
        self.assertEqual(api.calls[0][1], "/registerUser")
        login = [c for c in api.calls if c[1] == "/group/login"]
        self.assertEqual(len(login), 1)
        self.assertEqual(login[0][3], {"email": ACCOUNT["email"], "password": hashlib.sha256(ACCOUNT["password"].encode()).hexdigest()})
        self.assertEqual(state["email"], STATE["email"])

    def test_lost_registration_reply_reuses_the_saved_device(self):
        state = copy.deepcopy(STATE)
        state["user"] = {}
        state["sessionToken"] = {}
        api = FakeApi([_ApiError(409), renewed(), STATE["user"]])
        ensure_authenticated(state, prepare_credentials(ACCOUNT), api, now_ms=NOW)
        self.assertEqual([c[1] for c in api.calls], ["/registerUser", "/userLogin", "/users/" + USER_ID])
        self.assertEqual(api.calls[0][3]["email"], api.calls[1][3]["email"])

    def test_wrong_password_and_device_limit_do_not_create_another_device(self):
        for code in ("10001", "10006", "10009"):
            with self.subTest(code=code):
                state = copy.deepcopy(STATE)
                state["user"]["groupEmail"] = ""
                api = FakeApi([state["user"], _ApiError(500, code)])
                with self.assertRaises(_ApiError):
                    ensure_authenticated(state, prepare_credentials(ACCOUNT), api, now_ms=NOW)
                self.assertEqual(len(api.calls), 2)
                self.assertFalse(any(c[1] == "/registerUser" for c in api.calls))

    def test_rate_limit_does_not_trigger_login_or_failover(self):
        api = FakeApi([_ApiError(429)])
        with self.assertRaises(_ApiError):
            ensure_authenticated(copy.deepcopy(STATE), prepare_credentials(ACCOUNT), api, now_ms=NOW)
        self.assertEqual(len(api.calls), 1)

    def test_unexpected_user_or_token_binding_is_rejected(self):
        for field in ("user", "sessionToken"):
            state = copy.deepcopy(STATE)
            state["sessionToken"]["expiredAt"] = 1
            result = renewed()
            if field == "user":
                result["user"]["id"] = OLD_TOKEN
            else:
                result["sessionToken"]["userId"] = OLD_TOKEN
            api = FakeApi([result])
            with self.subTest(field=field), self.assertRaises(ExportError):
                ensure_authenticated(state, prepare_credentials(ACCOUNT), api, now_ms=NOW)
            self.assertEqual(state["sessionToken"]["id"], OLD_TOKEN)

    def test_membership_expiry_is_refreshed_then_reported_without_retrying_password(self):
        user = {**STATE["user"], "expiredAt": NOW - 1}
        api = FakeApi([user])
        with self.assertRaisesRegex(ExportError, "会员"):
            ensure_authenticated(copy.deepcopy(STATE), prepare_credentials(ACCOUNT), api, now_ms=NOW)
        self.assertEqual(len(api.calls), 1)

    def test_failed_state_replace_keeps_previous_session(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "session.json"
            save_state(target, STATE)
            before = target.read_bytes()
            changed = copy.deepcopy(STATE)
            changed["sessionToken"] = renewed()["sessionToken"]
            with patch("auth_leapvpn.os.replace", side_effect=OSError("disk unavailable")):
                with self.assertRaises(OSError):
                    save_state(target, changed)
            self.assertEqual(target.read_bytes(), before)
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_missing_state_generates_identity_once_and_refuses_corrupt_state(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "session.json"
            first = load_state(target)
            self.assertEqual(load_state(target)["email"], first["email"])
            target.write_text("invalid JSON")
            with self.assertRaises(ExportError):
                load_state(target)

    def test_concurrent_refresh_is_rejected_and_lock_releases(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "session.json"
            with state_lock(target):
                with self.assertRaises(ExportError):
                    with state_lock(target):
                        self.fail("second refresh acquired the lock")
            with state_lock(target):
                pass


class DiscoveryTests(unittest.TestCase):
    def test_authenticated_manifest_and_tamper_detection(self):
        document = {"baseURL": "https://api.example.invalid", "hosts": [{"host": "backup.example.invalid", "ips": []}]}
        cipher = AES.new(MANIFEST_KEY, AES.MODE_GCM, nonce=MANIFEST_NONCE)
        ciphertext, tag = cipher.encrypt_and_digest(json.dumps(document).encode())
        raw = base64.b64encode(ciphertext + tag)
        self.assertEqual(decode_api_manifest(raw + b"\r\n"), document)
        with self.assertRaises(ExportError):
            decode_api_manifest(base64.b64encode(ciphertext[:-1] + bytes([ciphertext[-1] ^ 1]) + tag))
        with self.assertRaises(ExportError):
            decode_api_manifest(b"<html>bad gateway</html>")

    @patch("auth_leapvpn._api_request")
    def test_network_failure_uses_known_backup_and_remembers_success(self, request):
        state = copy.deepcopy(STATE)
        state["apiHosts"] = [{"host": "backup.example.invalid"}]
        network_error = ExportError("API network failed")
        network_error.__cause__ = requests.ConnectionError()
        request.side_effect = [network_error, {"ok": True}]
        with ApiClient(state) as api:
            self.assertEqual(api.request("GET", "/vlcs", OLD_TOKEN), {"ok": True})
        self.assertEqual(state["baseURL"], "https://backup.example.invalid")
        self.assertEqual(request.call_count, 2)

    @patch("auth_leapvpn._api_request")
    def test_wrong_password_does_not_spray_other_api_hosts(self, request):
        state = copy.deepcopy(STATE)
        state["apiHosts"] = [{"host": "backup.example.invalid"}]
        request.side_effect = _ApiError(500, "10001")
        with ApiClient(state) as api, self.assertRaises(_ApiError):
            api.request("POST", "/group/login", OLD_TOKEN, {"password": "secret"})
        self.assertEqual(request.call_count, 1)


class RefreshTests(unittest.TestCase):
    def test_binding_failure_preserves_registered_identity_for_next_run(self):
        unbound = renewed(False)["user"]
        api = FakeApi([renewed(False), unbound, _ApiError(500, "10001")])
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "state.json"
            with patch("auth_leapvpn.ApiClient") as client:
                client.return_value.__enter__.return_value = api
                with self.assertRaises(_ApiError):
                    fetch_authenticated(prepare_credentials(ACCOUNT), target, now_ms=NOW)
            saved = load_state(target)
            self.assertEqual(saved["user"]["id"], USER_ID)
            self.assertEqual(saved["sessionToken"]["id"], NEW_TOKEN)

    @patch("auth_leapvpn.fetch_all")
    def test_mid_batch_revocation_discards_partial_work_and_restarts_once(self, fetch):
        bundle = {"leap_meta.json": "{}", "leap_clash.yaml": "{\"proxies\": []}"}
        fetch.side_effect = [_ApiError(401), bundle]
        api = FakeApi([STATE["user"], renewed(), STATE["user"]])
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "state.json"
            save_state(target, STATE)
            with patch("auth_leapvpn.ApiClient") as client:
                client.return_value.__enter__.return_value = api
                result = fetch_authenticated(prepare_credentials(ACCOUNT), target, now_ms=NOW)
            self.assertEqual(fetch.call_count, 2)
            self.assertEqual(json.loads(target.read_text())["sessionToken"]["id"], NEW_TOKEN)
            meta = json.loads(result["leap_meta.json"])
            self.assertTrue(meta["authentication"]["session_renewed"])
            for secret in (ACCOUNT["email"], ACCOUNT["password"], STATE["password"], NEW_TOKEN):
                self.assertNotIn(secret, result["leap_meta.json"])


if __name__ == "__main__":
    unittest.main()
