"""Send minimal client state directly to the existing VPS over SSH stdin."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from leapvpn.export import decode_settings


def session_payload(settings, include_device_credentials=False):
    token, user = settings["sessionToken"], settings["user"]
    payload = {
        "baseURL": settings["baseURL"], "apiHosts": settings.get("apiHosts", []),
        "sessionToken": {"id": token["id"], "expiredAt": token.get("expiredAt")},
        "user": {"id": user["id"], "expiredAt": user.get("expiredAt")},
        "privateKey": {}, "protocolType": 1,
        "cloudyParameter": {"muxSize": settings.get("cloudyParameter", {}).get("muxSize", "0")},
    }
    if include_device_credentials:
        payload["deviceLogin"] = {"email": settings["email"], "password": settings["password"]}
        payload["user"].update({key: user[key] for key in ("groupEmail", "username", "osVersion") if key in user})
        if settings.get("cloudyParameter", {}).get("lvfilepath"):
            payload["cloudyParameter"]["lvfilepath"] = settings["cloudyParameter"]["lvfilepath"]
    return payload


def main():
    parser = argparse.ArgumentParser(description="同步现有飞跃登录态到美国 VPS；账号密码不会上传。")
    base = os.environ.get("ProgramW6432") or os.environ.get("ProgramFiles", r"C:\Program Files")
    parser.add_argument("--settings", type=Path, default=Path(base) / "LeapVPN/AppData/Settings/appsettings.json")
    parser.add_argument("--host", required=True, help="明确指定接收端 UID 为 0 的 SSH 目标，例如 root@host.example.com")
    parser.add_argument("--identity", type=Path, required=True, help="该目标使用的 SSH 私钥文件")
    parser.add_argument("--no-refresh", action="store_true", help="仅用于首次部署准备")
    parser.add_argument("--auto-login", action="store_true", help="同时同步客户端设备凭据，供已配置的 VPS 自动续期")
    args = parser.parse_args()
    if args.host.startswith("-") or any(c.isspace() for c in args.host):
        parser.error("无效的 SSH 目标")
    settings = decode_settings(args.settings.read_bytes())
    command = ["ssh", "-i", str(args.identity), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15", args.host]
    remote = "/opt/private-subscription/providers/leapvpn/.venv/bin/python -m leapvpn.receive"
    if args.no_refresh:
        remote += " --no-refresh"
    command.append(remote)
    result = subprocess.run(command, input=json.dumps(session_payload(settings, args.auto_login)).encode("utf-8"), check=False)
    return result.returncode


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError) as exc:
        print("同步失败：" + type(exc).__name__, file=sys.stderr)
        raise SystemExit(1)
