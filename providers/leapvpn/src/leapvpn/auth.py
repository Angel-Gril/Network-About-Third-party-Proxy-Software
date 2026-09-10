"""Persistent device login, account binding and session recovery for LeapVPN.

Account and device credentials are distinct. An already bound device renews via
/userLogin; /group/login is required when binding an unbound device. Neither
operation purchases or extends a paid membership.
"""
import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
from urllib.parse import urlsplit
import uuid

import requests

from leapvpn.export import ExportError, _ApiError, _api_request, _vless_id, fetch_all

MAX_STATE_BYTES = 1024 * 1024
RENEW_AHEAD_MS = 24 * 3600000
# Public discovery constants recovered from manager.UpdateBaseUrl in 1.5.8.
MANIFEST_KEY = b"7c023924006d47d4941e8e95ddc56112"
MANIFEST_NONCE = b"8e95ddc56112"
MANIFEST_ROOTS = (
    "https://lmufv.s3.ap-east-1.amazonaws.com/",
    "https://lmlvback.s3.ap-east-1.amazonaws.com/",
    "https://file.gbfra.com/lv/",
)


class RefreshBusy(ExportError):
    pass


def prepare_credentials(value):
    if not isinstance(value, dict):
        raise ExportError("账号配置必须是 JSON 对象。")
    email = value.get("email")
    if not isinstance(email, str) or not 3 <= len(email) <= 320 or "@" not in email or any(c.isspace() or ord(c) < 32 for c in email):
        raise ExportError("账号配置缺少有效的邮箱。")
    digest = value.get("passwordSha256")
    if digest is None:
        password = value.get("password")
        if not isinstance(password, str) or not 1 <= len(password) <= 4096:
            raise ExportError("账号配置缺少密码。")
        digest = hashlib.sha256(password.encode("utf-8")).hexdigest()
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
        raise ExportError("passwordSha256 必须是 64 位十六进制摘要。")
    return {"email": email, "passwordSha256": digest.lower()}


def _base(value):
    if not isinstance(value, str) or len(value) > 512 or any(c.isspace() or ord(c) < 32 for c in value):
        raise ExportError("API 地址无效。")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ExportError("API 地址无效。") from exc
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ("", "/")
            or (port is not None and not 1 <= port <= 65535) or "\\" in value):
        raise ExportError("API 地址必须是不含认证信息的 HTTPS 源站地址。")
    return value.rstrip("/")


def decode_api_manifest(raw):
    if len(raw) > MAX_STATE_BYTES:
        raise ExportError("API 地址文件超过大小上限。")
    try:
        from Crypto.Cipher import AES
        encrypted = base64.b64decode(b"".join(raw.split()), validate=True)
        cipher = AES.new(MANIFEST_KEY, AES.MODE_GCM, nonce=MANIFEST_NONCE)
        result = json.loads(cipher.decrypt_and_verify(encrypted[:-16], encrypted[-16:]))
        _base(result["baseURL"])
        if not isinstance(result.get("hosts"), list) or len(result["hosts"]) > 32:
            raise ValueError()
        for item in result["hosts"]:
            _base("https://" + item["host"])
        return {"baseURL": result["baseURL"], "hosts": result["hosts"]}
    except (ValueError, TypeError, KeyError) as exc:
        raise ExportError("API 地址文件解密校验或结构验证失败。") from exc


def _known_bases(state):
    values = [state.get("baseURL")]
    for host in state.get("apiHosts", [])[:32]:
        if isinstance(host, dict) and isinstance(host.get("host"), str):
            values.append("https://" + host["host"])
    result = []
    for value in values:
        if not value:
            continue
        base = _base(value)
        if base not in result:
            result.append(base)
    return result


class ApiClient:
    """Fail over transport errors; never retry rejected credentials on hosts."""

    def __init__(self, state):
        self.state = state
        self.client = requests.Session()
        self.discovered = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.client.close()

    def discover(self):
        roots = self.state.get("cloudyParameter", {}).get("lvfilepath", "")
        roots = [root for root in roots.split(",") if root] if isinstance(roots, str) else []
        roots = list(dict.fromkeys(roots + list(MANIFEST_ROOTS)))[:6]
        for root in roots:
            parsed = urlsplit(root)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                continue
            try:
                # No API token or account credentials are sent to discovery URLs.
                response = self.client.get(root.rstrip("/") + "/lvfile.v2", timeout=(5, 10), allow_redirects=False)
                if response.status_code != 200:
                    continue
                manifest = decode_api_manifest(response.content)
            except (requests.RequestException, ExportError):
                continue
            self.state["apiHosts"] = manifest["hosts"]
            self.state["discoveredAt"] = int(time.time() * 1000)
            return list(dict.fromkeys([_base(manifest["baseURL"])] + _known_bases(self.state)))
        raise ExportError("无法获取有效的飞跃 API 地址文件。")

    def request(self, method, path, token="", body=None):
        if not path.startswith("/") or path.startswith("//"):
            raise ExportError("无效的 API 路径。")
        candidates = _known_bases(self.state)
        tried = set()
        last_error = None
        while True:
            for base in candidates:
                if base in tried:
                    continue
                tried.add(base)
                try:
                    result = _api_request(self.client, method, base + path, token, body)
                except _ApiError as exc:
                    if exc.code is not None or exc.status not in (502, 503, 504):
                        raise
                    last_error = exc
                except ExportError as exc:
                    if not isinstance(exc.__cause__, requests.RequestException):
                        raise
                    last_error = exc
                else:
                    self.state["baseURL"] = base
                    return result
            if self.discovered:
                raise last_error or ExportError("没有可用的飞跃 API 地址。")
            self.discovered = True
            try:
                candidates = self.discover()
            except ExportError:
                if last_error is not None:
                    raise last_error
                raise


def save_state(path, state):
    path = Path(path)
    data = (json.dumps(state, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if len(data) > MAX_STATE_BYTES:
        raise ExportError("自动登录状态超过大小上限。")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, name = tempfile.mkstemp(prefix=".leapvpn-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(name, 0o600)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def load_state(path):
    path = Path(path)
    if not path.exists():
        state = {"email": str(uuid.uuid4()), "password": str(uuid.uuid4()),
                 "baseURL": "", "apiHosts": [], "user": {}, "sessionToken": {},
                 "privateKey": {}, "protocolType": 1}
        # Save before registration so a crash cannot create another identity.
        save_state(path, state)
        return state
    try:
        with path.open("rb") as source:
            raw = source.read(MAX_STATE_BYTES + 1)
        if len(raw) > MAX_STATE_BYTES:
            raise ValueError()
        state = json.loads(raw)
        if not isinstance(state, dict) or not isinstance(state.get("user"), dict) or not isinstance(state.get("sessionToken"), dict):
            raise ValueError()
        _device_credentials(state)
        _known_bases(state)
        return state
    except (ValueError, TypeError, KeyError) as exc:
        raise ExportError("自动登录状态损坏或缺少设备凭据；保留原文件，停止刷新。") from exc


@contextmanager
def state_lock(path):
    path = Path(path).with_suffix(".lock")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    locked = False
    try:
        try:
            if os.name == "nt":
                import msvcrt
                if os.fstat(descriptor).st_size == 0:
                    os.write(descriptor, b"0")
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except OSError as exc:
            raise RefreshBusy("飞跃自动刷新已在运行。") from exc
        yield
    finally:
        if locked:
            if os.name == "nt":
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _device_credentials(state):
    try:
        for name in ("email", "password"):
            uuid.UUID(state[name])
    except (ValueError, TypeError, AttributeError, KeyError) as exc:
        raise ExportError("缺少有效的设备登录凭据。") from exc
    return {"email": state["email"], "password": state["password"]}


def import_client_session(current, incoming):
    """Merge an explicitly synchronized client without dropping renewal keys."""
    result = dict(current)
    device = incoming.get("deviceLogin")
    same_device = current.get("user", {}).get("id") == incoming["user"]["id"]
    if device is not None:
        result.update(_device_credentials(device))
    elif not same_device:
        raise ExportError("客户端设备已变化；请使用 --auto-login 同步设备登录凭据。")
    for key in ("baseURL", "apiHosts", "sessionToken"):
        if key in incoming:
            result[key] = incoming[key]
    fields = ("id", "expiredAt", "groupEmail", "username", "osVersion")
    result["user"] = {**(current.get("user", {}) if same_device else {}),
                      **{key: incoming["user"][key] for key in fields if key in incoming["user"]}}
    result["cloudyParameter"] = {**current.get("cloudyParameter", {}),
                                **{key: incoming.get("cloudyParameter", {})[key] for key in ("muxSize", "lvfilepath")
                                   if key in incoming.get("cloudyParameter", {})}}
    result.update(privateKey={}, protocolType=1)
    _device_credentials(result)
    return result


def _user(state, value):
    if not isinstance(value, dict) or not isinstance(value.get("id"), str) or not value["id"]:
        raise ExportError("登录接口未返回有效设备用户。")
    known_id = state.get("user", {}).get("id")
    if known_id and value["id"] != known_id:
        raise ExportError("登录接口返回的设备身份发生变化，停止更新。")
    try:
        uuid.UUID(value["id"])
    except (ValueError, AttributeError) as exc:
        raise ExportError("登录接口返回的设备标识格式无效。") from exc
    return dict(value)


def _device_metadata(state):
    user = state.get("user", {})
    return {"username": user.get("username") or "Subscription VPS",
            "osVersion": user.get("osVersion") or "Windows 11", "timeZone": "CST"}


def _login_device(state, api, now_ms):
    credentials = _device_credentials(state)
    if state.get("user", {}).get("id"):
        result = api.request("POST", "/userLogin", "", credentials)
    else:
        try:
            result = api.request("POST", "/registerUser", "", {**credentials, **_device_metadata(state), "countryCode": "US"})
        except _ApiError as exc:
            if exc.status == 429:
                raise
            # A previous registration may have succeeded before its reply was
            # lost. Reuse the same identity; never generate another one here.
            result = api.request("POST", "/userLogin", "", credentials)
    user = _user(state, result.get("user"))
    token = result.get("sessionToken")
    if (not isinstance(token, dict) or token.get("userId") != user["id"]
            or type(token.get("expiredAt")) is not int or token["expiredAt"] <= now_ms):
        raise ExportError("登录接口未返回有效的新会话。")
    _vless_id(token.get("id"))
    state.update(user=user, sessionToken=dict(token), privateKey={}, protocolType=1, lastLoginAt=now_ms)


def _refresh_user(state, api):
    user_id = state["user"]["id"]
    value = api.request("PUT", "/users/" + user_id, state["sessionToken"]["id"], _device_metadata(state))
    state["user"] = _user(state, value)


def ensure_authenticated(state, credentials, api, *, now_ms=None, force=False):
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    token = state.get("sessionToken", {})
    expiry = token.get("expiredAt")
    renew = (force or not token.get("id") or not state.get("user", {}).get("id")
             or type(expiry) is not int or expiry <= now_ms + RENEW_AHEAD_MS)
    if renew:
        _login_device(state, api, now_ms)
    try:
        _refresh_user(state, api)
    except _ApiError as exc:
        if renew or not exc.retry_session:
            raise
        _login_device(state, api, now_ms)
        renew = True
        _refresh_user(state, api)
    bound_email = state["user"].get("groupEmail")
    bound = False
    if bound_email and bound_email.casefold() != credentials["email"].casefold():
        raise ExportError("设备绑定账号与配置邮箱不一致，停止刷新。")
    if not bound_email:
        result = api.request("POST", "/group/login", state["sessionToken"]["id"],
                             {"email": credentials["email"], "password": credentials["passwordSha256"]})
        if not isinstance(result.get("email"), str) or result["email"].casefold() != credentials["email"].casefold():
            raise ExportError("账号绑定接口未返回预期账号。")
        _refresh_user(state, api)
        if str(state["user"].get("groupEmail", "")).casefold() != credentials["email"].casefold():
            raise ExportError("账号绑定尚未生效，停止发布订阅。")
        bound = True
    membership_expiry = state["user"].get("expiredAt")
    if type(membership_expiry) is int and membership_expiry > 0 and membership_expiry <= now_ms:
        raise ExportError("飞跃会员已到期；会话续期不能延长付费会员。")
    return {"session_renewed": bool(renew), "account_login": bound,
            "session_expires_at_ms": state["sessionToken"].get("expiredAt"),
            "mode": "device_credentials"}


def fetch_authenticated(credentials, state_path, progress=None, *, force=False, now_ms=None):
    credentials = prepare_credentials(credentials)
    with state_lock(state_path):
        state = load_state(state_path)
        with ApiClient(state) as api:
            try:
                auth = ensure_authenticated(state, credentials, api, now_ms=now_ms, force=force)
                save_state(state_path, state)
                try:
                    bundle = fetch_all(state, progress, api=api)
                except _ApiError as exc:
                    if auth["session_renewed"] or not exc.retry_session:
                        raise
                    # Restart all nodes so one bundle uses one final session.
                    auth = ensure_authenticated(state, credentials, api, now_ms=now_ms, force=True)
                    save_state(state_path, state)
                    bundle = fetch_all(state, progress, api=api)
                metadata = json.loads(bundle["leap_meta.json"])
                metadata["authentication"] = auth
                bundle["leap_meta.json"] = json.dumps(metadata, ensure_ascii=False, indent=2) + "\n"
                return bundle
            finally:
                # Retain successful device registration/login even when later
                # account binding or node fetching fails. No public cache is
                # replaced on these failures.
                save_state(state_path, state)
