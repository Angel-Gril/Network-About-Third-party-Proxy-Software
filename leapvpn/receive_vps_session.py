"""VPS-side receiver for a minimal LeapVPN session sent over SSH stdin."""
import argparse
import grp
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

import requests
from export_leapvpn import _api_request


def synchronize_automatic(state, env):
    from auth_leapvpn import (ApiClient, ensure_authenticated, import_client_session,
                              load_state, prepare_credentials, save_state, state_lock)
    target = Path(env["LEAPVPN_AUTH_STATE_FILE"])
    credentials = prepare_credentials(json.loads(Path(env["LEAPVPN_CREDENTIAL_FILE"]).read_text()))
    account = pwd.getpwnam("subsvc")
    with state_lock(target):
        os.chown(target.with_suffix(".lock"), account.pw_uid, account.pw_gid)
        current = load_state(target)
        # load_state may persist a new identity; it must remain readable by the
        # scheduled service even if import or authentication subsequently fails.
        os.chown(target, account.pw_uid, account.pw_gid)
        merged = import_client_session(current, state)
        with ApiClient(merged) as api:
            ensure_authenticated(merged, credentials, api)
        backup = target.with_name("session.previous.json")
        shutil.copy2(target, backup)
        os.chmod(backup, 0o600)
        save_state(target, merged)
        os.chown(target, account.pw_uid, account.pw_gid)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-refresh", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Session synchronization requires the VPS administrator")
    env_file = Path("/etc/private-subscription/service.env")
    env = dict(line.split("=", 1) for line in env_file.read_text().splitlines() if "=" in line and not line.startswith("#"))
    domain = env.get("PUBLIC_DOMAIN", "")
    service_uri = urlsplit("https://" + domain)
    if (not domain or any(character.isspace() for character in domain)
            or not service_uri.hostname or service_uri.netloc != domain
            or service_uri.username or service_uri.password
            or service_uri.path or service_uri.query or service_uri.fragment):
        raise ValueError("Configure a valid subscription service domain")
    raw = sys.stdin.buffer.read(131073)
    if len(raw) > 131072:
        raise ValueError("Session input is too large")
    state = json.loads(raw)
    uri = urlsplit(state["baseURL"])
    if uri.scheme != "https" or not uri.hostname or uri.username or uri.password or uri.query or uri.fragment:
        raise ValueError("Invalid API address")
    token = state["sessionToken"]
    user = state["user"]
    if not isinstance(token.get("id"), str) or not token["id"] or not isinstance(user.get("id"), str) or not user["id"]:
        raise ValueError("Incomplete client session")
    if token.get("expiredAt") and token["expiredAt"] <= time.time() * 1000:
        raise ValueError("Client session has expired")
    with requests.Session() as session:
        catalog = _api_request(session, "GET", state["baseURL"].rstrip("/") + "/vlcs", token["id"])
    if not isinstance(catalog.get("categories"), list):
        raise ValueError("API did not return a valid catalogue")
    safe = {
        "baseURL": state["baseURL"], "apiHosts": state.get("apiHosts", []),
        "sessionToken": {"id": token["id"], "expiredAt": token.get("expiredAt")},
        "user": {"id": user["id"], "expiredAt": user.get("expiredAt")},
        "privateKey": {}, "protocolType": 1,
        "cloudyParameter": {"muxSize": state.get("cloudyParameter", {}).get("muxSize", "0")},
    }
    automatic = bool(env.get("LEAPVPN_AUTH_STATE_FILE"))
    if automatic:
        synchronize_automatic(state, env)
    else:
        if state.get("deviceLogin") is not None:
            raise ValueError("Configure automatic login on the VPS before synchronizing device credentials")
        target = Path("/etc/private-subscription/leapvpn.json")
        if target.exists():
            backup = target.with_name("leapvpn.previous.json")
            shutil.copy2(target, backup)
            os.chmod(backup, 0o600)
        descriptor, temporary = tempfile.mkstemp(prefix=".leapvpn-", dir=target.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(safe, output)
                output.flush()
                os.fsync(output.fileno())
                os.fchown(output.fileno(), 0, grp.getgrnam("subsvc").gr_gid)
                os.fchmod(output.fileno(), 0o640)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    if not args.no_refresh:
        subprocess.run(["systemctl", "start", "private-subscription-refresh@leapvpn.service"], check=True)
    print(json.dumps({"ok": True, "session_synced": True, "refresh_requested": not args.no_refresh,
                      "automatic_login": automatic,
                      "session_expires_at_ms": safe["sessionToken"].get("expiredAt")}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error_type": type(exc).__name__}))
        raise SystemExit(1)
