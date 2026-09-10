"""Unattended LeapVPN login, renewal and subscription export."""
import argparse
import json
from pathlib import Path
import sys

from auth_leapvpn import MAX_STATE_BYTES, RefreshBusy, fetch_authenticated, prepare_credentials
from export_leapvpn import ExportError, write_bundle


def main(argv=None):
    parser = argparse.ArgumentParser(description="飞跃自动登录、续期并导出订阅；凭据从私有文件读取。")
    parser.add_argument("--credentials", type=Path, required=True, help="邮箱与 password 或 passwordSha256 的 JSON 文件")
    parser.add_argument("--state", type=Path, required=True, help="可写的私有设备和会话状态文件；首次运行自动创建")
    parser.add_argument("--out-dir", type=Path, required=True, help="尚不存在的订阅输出目录")
    parser.add_argument("--renew-session", action="store_true", help="主动重新登录设备，验证或提前更新会话")
    args = parser.parse_args(argv)
    try:
        if args.out_dir.exists():
            raise ExportError("输出目录已经存在；请指定一个新目录。")
        with args.credentials.open("rb") as source:
            raw = source.read(MAX_STATE_BYTES + 1)
        if len(raw) > MAX_STATE_BYTES:
            raise ExportError("账号配置超过大小上限。")
        try:
            credentials = prepare_credentials(json.loads(raw))
        except (ValueError, UnicodeError) as exc:
            raise ExportError("账号配置无效。") from exc
        bundle = fetch_authenticated(credentials, args.state, force=args.renew_session)
        write_bundle(bundle, args.out_dir)
        metadata = json.loads(bundle["leap_meta.json"])
        print(json.dumps({"ok": True, "node_count": metadata["exported_node_count"],
                          "authentication": metadata["authentication"]}))
        return 0
    except RefreshBusy:
        print("飞跃自动刷新已在运行。", file=sys.stderr)
        return 75
    except ExportError as exc:
        print("自动刷新失败：" + str(exc), file=sys.stderr)
    except OSError as exc:
        print("自动刷新失败：文件操作错误（" + type(exc).__name__ + "）。", file=sys.stderr)
    return 2


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    raise SystemExit(main())
