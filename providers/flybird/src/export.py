#!/usr/bin/env python3
"""Launch the local FlyingBird exporter with script-relative resources."""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="在本机登录 FlyingBird 并导出 Clash + v2rayN")
    parser.add_argument("-e", "--email", help="FlyingBird 登录邮箱")
    parser.add_argument("-p", "--password", help="FlyingBird 登录密码；不提供时安全提示输入")
    parser.add_argument(
        "--api-base-url",
        help="强制使用指定 FlyingBird API；默认自动检测",
    )
    parser.add_argument("--proxy", help="可选 HTTP 代理，例如 http://127.0.0.1:7897")
    parser.add_argument("--routing-template", help="可选自定义 Mihomo 分流模板")
    parser.add_argument("-o", "--outdir", help="输出目录；默认使用仓库 exports/flybird")
    args = parser.parse_args()

    powershell = shutil.which("pwsh") or shutil.which("powershell")
    if not powershell:
        print("[-] 未找到 PowerShell，无法运行本地解密脚本", file=sys.stderr)
        return 1

    script = Path(__file__).with_name("export.ps1").resolve()
    command = [
        powershell,
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(script),
    ]
    if args.outdir:
        command.extend(["-OutDir", args.outdir])
    if args.email:
        command.extend(["-Email", args.email])
    if args.password:
        command.extend(["-Password", args.password])
    if args.api_base_url:
        command.extend(["-ApiBaseUrl", args.api_base_url])
    if args.proxy:
        command.extend(["-ProxyUrl", args.proxy])
    if args.routing_template:
        command.extend(["-RoutingTemplatePath", args.routing_template])

    return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    raise SystemExit(main())
