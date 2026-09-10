"""Export Protocol X connections using LeapVPN 1.5.8 settings.

Default: offline cache export. --fetch-all uses the existing client session.
Neither mode executes the client nor modifies its settings or system proxy.
The .yaml output uses JSON syntax, which is also valid YAML.
"""

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import quote, urlencode, urlsplit
import uuid


# Literal bytes loaded by manager.init.2, not a call to a random generator.
SETTINGS_KEY = b"randBytes(256/8)"
MAX_SETTINGS_BYTES = 16 * 1024 * 1024
NODE_NAME = "LeapVPN-current"
APP_ID = "56828068-3069-4db9-a9f3-c25e636636f0"


class ExportError(ValueError):
    """An input cannot be safely converted to the observed client format."""


def decode_settings(data):
    if len(data) > MAX_SETTINGS_BYTES:
        raise ExportError("配置文件超过 16 MiB，停止读取。")
    plain = None
    if len(data) >= 28:
        try:
            from Crypto.Cipher import AES
        except ImportError as exc:
            raise ExportError("缺少 pycryptodome；请安装 leapvpn/requirements.txt。") from exc
        try:
            cipher = AES.new(SETTINGS_KEY, AES.MODE_GCM, nonce=data[:12])
            plain = cipher.decrypt_and_verify(data[12:-16], data[-16:])
        except ValueError:
            pass
    # ReadFromFile also accepts an actual plaintext JSON settings file.
    try:
        settings = json.loads(plain if plain is not None else data)
    except (ValueError, UnicodeError) as exc:
        raise ExportError("GCM 校验失败或文件不是配置 JSON；请核对文件和客户端版本。") from exc
    if not isinstance(settings, dict) or not isinstance(settings.get("sessionToken"), dict):
        raise ExportError("文件缺少 LeapVPN sessionToken 配置结构。")
    if not isinstance(settings.get("privateKey"), dict):
        raise ExportError("文件缺少 LeapVPN privateKey 配置结构。")
    return settings


def summarize(settings):
    token = settings.get("sessionToken") or {}
    connection = settings.get("privateKey") or {}
    locations = settings.get("locations")
    protocol = settings.get("protocolType")
    session_expiry = token.get("expiredAt")
    connection_expiry = connection.get("expireAt")
    return {
        "format_basis": "LeapVPN Windows 1.5.8",
        "protocol_type": protocol if type(protocol) is int else None,
        "cached_location_count": len(locations) if isinstance(locations, list) else 0,
        "has_session_token": bool(token.get("id")),
        "has_cached_endpoint": bool(connection.get("host")),
        "session_expires_at_ms": session_expiry if type(session_expiry) is int else None,
        "connection_expires_at_ms": connection_expiry if type(connection_expiry) is int else None,
        "connectivity_verified": False,
    }


def _vless_id(value):
    if not isinstance(value, str) or not value or any(c.isspace() for c in value):
        raise ExportError("缺少可用的会话标识，请先登录并连接。")
    size = len(value.encode("utf-8"))
    if 1 <= size <= 30:
        # xray-core/common/uuid.ParseString: SHA-1(nil UUID || UTF-8 name).
        return str(uuid.uuid5(uuid.UUID(int=0), value))
    if 32 <= size <= 36:
        try:
            return str(uuid.UUID(value))
        except ValueError:
            pass
    raise ExportError("会话标识不符合该版本 Xray 的 ID 格式。")


def _endpoint(value):
    if not isinstance(value, str) or not value or "://" in value:
        raise ExportError("缺少有效的缓存服务器地址，请先用协议 X 连接一次。")
    if any(c.isspace() or ord(c) < 32 for c in value):
        raise ExportError("缓存服务器地址包含无效字符。")
    authority, separator, tail = value.partition("/")
    if any(c in authority for c in "@?#\\"):
        raise ExportError("缓存服务器地址格式不正确。")
    try:
        parsed = urlsplit("//" + authority)
        host = parsed.hostname
        port = parsed.port if parsed.port is not None else 443
    except ValueError as exc:
        raise ExportError("缓存服务器端口或地址格式不正确。") from exc
    if not host or not 1 <= port <= 65535:
        raise ExportError("缓存服务器端口或地址格式不正确。")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if not re.fullmatch(r"[A-Za-z0-9._-]+", host):
            raise ExportError("缓存服务器域名格式不正确。")
    return host, port, "/" + tail if separator else "/"


def _check_expiry(record, field, label, now_ms):
    expires = record.get(field)
    if expires is None or expires == 0:
        return
    if type(expires) is not int or expires < 0:
        raise ExportError(label + "有效期格式不正确。")
    if expires <= now_ms:
        raise ExportError(label + "已经过期，请重新登录并连接后导出。")


def _json(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def build_bundle(settings, *, now_ms=None, node_name=NODE_NAME):
    if type(settings.get("protocolType")) is not int or settings["protocolType"] != 1:
        raise ExportError("缓存对应协议 W 或未知协议。请在官方客户端选择协议 X 并连接后导出。")
    token, connection = settings.get("sessionToken"), settings.get("privateKey")
    if not isinstance(token, dict) or not isinstance(connection, dict):
        raise ExportError("配置缺少会话或连接字段。")
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    _check_expiry(token, "expiredAt", "会话", now_ms)
    _check_expiry(connection, "expireAt", "连接凭据", now_ms)
    identifier = _vless_id(token.get("id"))
    host, port, path = _endpoint(connection.get("host"))
    node = {
        "name": node_name, "type": "vless", "server": host, "port": port,
        "uuid": identifier, "network": "ws", "tls": True,
        "skip-cert-verify": True, "ws-opts": {"path": path},
    }
    clash = {
        "mixed-port": 7890, "allow-lan": False, "mode": "rule",
        "log-level": "warning", "proxies": [node],
        "proxy-groups": [{"name": "PROXY", "type": "select", "proxies": [node_name, "DIRECT"]}],
        "rules": ["MATCH,PROXY"],
    }
    authority = "[" + host + "]" if ":" in host else host
    query = urlencode({"encryption": "none", "security": "tls", "type": "ws", "path": path, "allowInsecure": "1"})
    link = "vless://" + quote(identifier, safe="") + "@" + authority + ":" + str(port) + "?" + query + "#" + quote(node_name, safe="") + "\n"
    parameters = settings.get("cloudyParameter") or {}
    try:
        mux = max(0, int(parameters.get("muxSize") or 0))
    except (TypeError, ValueError):
        mux = 0
    xray = {
        "log": {"loglevel": "warning"},
        "inbounds": [
            {"listen": "127.0.0.1", "port": 10808, "protocol": "socks", "settings": {"udp": True}},
            {"listen": "127.0.0.1", "port": 10809, "protocol": "http", "settings": {}},
        ],
        "outbounds": [{
            "tag": node_name, "protocol": "vless",
            "settings": {"vnext": [{"address": host, "port": port, "users": [{"id": identifier, "encryption": "none"}]}]},
            "streamSettings": {
                "network": "ws", "security": "tls",
                "tlsSettings": {"allowInsecure": True, "serverName": ""},
                "wsSettings": {"path": path},
            },
            "mux": {"enabled": mux > 0, "concurrency": mux},
        }],
    }
    metadata = summarize(settings)
    metadata.update({
        "exported_node_count": 1,
        "scope": "cached_current_endpoint_only",
        "tls_certificate_verification": False,
        "tls_setting_source": "client v2ray.vlessConfigFile template",
    })
    return {
        "leap_vless.txt": link,
        "leap_clash.yaml": _json(clash),
        "leap_xray.json": _json(xray),
        "leap_meta.json": _json(metadata),
    }


def write_bundle(bundle, destination):
    destination = Path(destination)
    try:
        destination.mkdir(parents=True, exist_ok=False)
    except FileExistsError as exc:
        raise ExportError("输出目录已经存在；请指定一个新目录，以保留上次结果。") from exc
    with (destination / ".gitignore").open("x", encoding="utf-8", newline="\n") as output:
        output.write("*\n")
    for name, content in bundle.items():
        with (destination / name).open("x", encoding="utf-8", newline="\n") as output:
            output.write(content)


class _ApiError(ExportError):
    def __init__(self, status, code=None):
        code = str(code) if code is not None and str(code).isdigit() else None
        self.status, self.code = status, code
        # The observed API returns an empty HTTP 500 for an invalid session.
        # Recovery is bounded by the authentication runner; this is not proof
        # that every empty 500 is an authentication error.
        self.retry_session = status == 401 or (status == 500 and code is None)
        self.stop_batch = self.retry_session or status == 429 or code in ("10001", "10004", "10006", "10009")
        super().__init__("API HTTP " + str(status) + ("，业务代码 " + code if code else ""))


def _api_request(client, method, url, token, body=None):
    import requests

    request_id = str(uuid.uuid4())
    digest = hashlib.sha256(("lc" + APP_ID + "@" + request_id).encode()).hexdigest()[-8:]
    headers = {
        "Content-Type": "application/json", "X-ML-AppId": APP_ID,
        "X-ML-ReqId": request_id, "X-ML-ReqHash": digest, "X-ML-Token": token,
        "User-Agent": "LeapVPN/1.5.8 (Windows 11; amd64)",
    }
    try:
        response = client.request(method, url, headers=headers, json=body,
                                  timeout=(10, 20), allow_redirects=False)
    except requests.RequestException as exc:
        raise ExportError("API 连接失败（" + type(exc).__name__ + "）。") from exc
    if len(response.content) > MAX_SETTINGS_BYTES:
        raise ExportError("API 响应超过大小上限。")
    try:
        data = response.json()
    except ValueError as exc:
        if not response.ok:
            raise _ApiError(response.status_code) from exc
        raise ExportError("API 响应不是 JSON。") from exc
    code = data.get("errorCode") if isinstance(data, dict) else None
    if not response.ok or code not in (None, 0, "0", ""):
        raise _ApiError(response.status_code, code)
    if not isinstance(data, dict):
        raise ExportError("API 响应不是预期对象。")
    return data


def fetch_all(settings, progress=None, *, api=None):
    token, user = settings.get("sessionToken"), settings.get("user")
    if not isinstance(token, dict) or not isinstance(token.get("id"), str) or not token["id"]:
        raise ExportError("没有客户端登录会话，请先在官方客户端登录。")
    if not isinstance(user, dict) or not isinstance(user.get("id"), str) or not user["id"]:
        raise ExportError("缺少客户端设备用户标识。")
    _check_expiry(token, "expiredAt", "会话", int(time.time() * 1000))
    base = settings.get("baseURL")
    if not isinstance(base, str):
        raise ExportError("客户端没有保存 API 地址。请打开官方客户端刷新后重试。")
    parsed = urlsplit(base)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ExportError("客户端 API 地址格式无效。")
    base = base.rstrip("/")
    try:
        import requests
    except ImportError as exc:
        raise ExportError("缺少 requests；请安装 leapvpn/requirements.txt。") from exc
    candidates, seen_hosts = [], set()
    nodes, outbounds, links, failed = [], [], [], []
    first = None
    with requests.Session() as client:
        def request(method, path, body=None):
            if api is not None:
                return api.request(method, path, token["id"], body)
            return _api_request(client, method, base + path, token["id"], body)

        catalog = request("GET", "/vlcs")
        categories = catalog.get("categories")
        if not isinstance(categories, list):
            raise ExportError("线路目录缺少 categories。")
        for category in categories:
            if not isinstance(category, dict) or not isinstance(category.get("locations"), list):
                continue
            for location in category["locations"]:
                if not isinstance(location, dict):
                    continue
                host = location.get("host")
                if not isinstance(host, str) or not host or host in seen_hosts:
                    continue
                seen_hosts.add(host)
                candidates.append((category, location))
        if not candidates:
            raise ExportError("服务器没有返回可请求的线路。")
        seen_names = set()
        for index, (category, location) in enumerate(candidates, 1):
            labels = [category.get("categoryNameCn") or category.get("categoryName"),
                      location.get("locationNameCn") or location.get("locationName")]
            name = " · ".join(str(label).strip() for label in labels if label)[:120] or "LeapVPN-" + str(index)
            while name in seen_names:
                name += "-" + str(index)
            seen_names.add(name)
            try:
                connection = request(
                    "POST", "/privateKey?base64=true&retry=false&restart=false",
                    {"userId": user["id"], "host": location["host"], "p": "x"},
                )
                snapshot = {**settings, "protocolType": 1, "privateKey": connection}
                part = build_bundle(snapshot, node_name=name)
                nodes.extend(json.loads(part["leap_clash.yaml"])["proxies"])
                outbounds.extend(json.loads(part["leap_xray.json"])["outbounds"])
                links.append(part["leap_vless.txt"])
                if first is None:
                    first = part
            except _ApiError as exc:
                if exc.stop_batch:
                    raise
                failed.append({"name": name, "error": str(exc)})
            except ExportError as exc:
                failed.append({"name": name, "error": str(exc)})
            if progress:
                progress(index, len(candidates), len(nodes), len(failed))
    if first is None:
        raise ExportError("未获得可导出的线路，请在官方客户端确认账号状态。")
    clash = json.loads(first["leap_clash.yaml"])
    clash["proxies"] = nodes
    clash["proxy-groups"][0]["proxies"] = [node["name"] for node in nodes] + ["DIRECT"]
    xray = json.loads(first["leap_xray.json"])
    xray["outbounds"] = outbounds
    metadata = summarize(settings)
    metadata.update({
        "scope": "client_session_api", "exported_protocol_type": 1,
        "catalog_host_count": len(candidates), "exported_node_count": len(nodes),
        "failed_node_count": len(failed), "failed_nodes": failed,
        "tls_certificate_verification": False,
        "tls_setting_source": "client v2ray.vlessConfigFile template",
        "fetched_at_unix": int(time.time()),
    })
    return {"leap_vless.txt": "".join(links), "leap_clash.yaml": _json(clash),
            "leap_xray.json": _json(xray), "leap_meta.json": _json(metadata)}


def main(argv=None):
    parser = argparse.ArgumentParser(description="离线读取 LeapVPN 1.5.8 缓存；默认仅显示脱敏摘要。")
    program_files = os.environ.get("ProgramW6432") or os.environ.get("ProgramFiles", r"C:\Program Files")
    default = Path(program_files) / "LeapVPN" / "AppData" / "Settings" / "appsettings.json"
    parser.add_argument("--settings", type=Path, default=default, help="appsettings.json 路径")
    parser.add_argument("--out-dir", type=Path, help="写入一个尚不存在的目录；省略时仅检查")
    parser.add_argument("--fetch-all", action="store_true", help="使用已有登录态向客户端当前 API 请求全部线路的协议 X 参数")
    args = parser.parse_args(argv)
    if args.fetch_all and not args.out_dir:
        parser.error("--fetch-all 需要同时指定 --out-dir。")
    try:
        if args.out_dir and args.out_dir.exists():
            raise ExportError("输出目录已经存在；请指定一个新目录。")
        with args.settings.open("rb") as source:
            settings = decode_settings(source.read(MAX_SETTINGS_BYTES + 1))
        summary = summarize(settings)
        if args.out_dir:
            def progress(done, total, success, errors):
                if done == 1 or done % 10 == 0 or done == total:
                    print(f"线路 {done}/{total}：成功 {success}，失败 {errors}", flush=True)
            bundle = fetch_all(settings, progress) if args.fetch_all else build_bundle(settings)
            write_bundle(bundle, args.out_dir)
            print("已导出 " + str(json.loads(bundle["leap_meta.json"])["exported_node_count"]) + " 条线路：" + str(args.out_dir))
        else:
            print(_json(summary), end="")
        return 0
    except FileNotFoundError:
        print("未找到配置文件。请先安装官方客户端、登录并用协议 X 连接一次，或用 --settings 指定已有配置。", file=sys.stderr)
    except PermissionError:
        print("没有读取配置或写入输出的权限。请把可读取的配置副本放到工作目录后重试。", file=sys.stderr)
    except (ExportError, OSError) as exc:
        print("导出失败：" + str(exc), file=sys.stderr)
    return 2


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    raise SystemExit(main())
