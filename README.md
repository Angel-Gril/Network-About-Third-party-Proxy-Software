# 第三方代理软件订阅提取

把自己账号或客户端中的代理配置转换为标准订阅，并验证参数、入口和实际转发。包含 FlyingBird（飞鸟云）、LeapVPN（飞跃）的实现，以及可迁移到同类客户端的分析 skill。

| 内容 | 位置 |
| --- | --- |
| 飞鸟本地登录、解密、导出 | [export_fb_all.ps1](export_fb_all.ps1) |
| 可选 Cloudflare Worker | [src/worker.js](src/worker.js)、[使用说明](docs/WORKER.md) |
| 飞跃提取、自动登录与续期 | [leapvpn/](leapvpn/README.md) |
| 私有 VPS 分发、分流与缓存 | [vps-service/](vps-service/README.md) |
| 可复用提取方法 skill | [extract-proxy-subscriptions](skills/extract-proxy-subscriptions/SKILL.md) |
| 开发、测试和公开提交规则 | [AGENTS.md](AGENTS.md)、[开发说明](docs/DEVELOPMENT.md) |

运行时使用你自己的有效账号或已授权客户端会话。导出文件包含连接凭据，默认输出目录已加入 Git 忽略规则。

## 飞鸟：本机导出

Windows 上使用 PowerShell 7 或 Windows PowerShell 5.1：

```powershell
.\run_export_fb_all.bat

# 指定邮箱，密码由交互提示安全输入。
pwsh -NoProfile -File .\export_fb_all.ps1 -Email 'you@example.com'
```

导出器从客户端首选项发现当前 API 地址，也可用 `-ApiBaseUrl` 明确覆盖。输出放在 `fb_export/`，包含 Mihomo/Clash 配置和 v2rayN 可导入内容。它登录官方账号接口并解密订阅，使用 [routing_template.yaml](routing_template.yaml) 生成本地分流。

当下载或解密成功但节点超时时，继续检查真实 DNS 与连接层；Fake-IP 地址不能作为真实入口有效的证据。

## 飞跃：检查或批量导出

```sh
python -m pip install -r leapvpn/requirements.txt
python -B leapvpn/export_leapvpn.py
python -B leapvpn/export_leapvpn.py --fetch-all --out-dir exports/leap-first
```

默认从已登录 Windows 客户端读取配置。使用配置副本或其他平台时，通过 `--settings` 指定文件。输出目录必须尚不存在。

当前导出的是协议 X，即 VLESS + WebSocket + TLS，提供 Clash YAML、Xray JSON 和 VLESS 分享链接。协议 W 含自定义 WireGuard 扩展，第三方核心兼容性需要另行验证。具体用法、自动续期和状态边界见 [飞跃说明](leapvpn/README.md)。

## 安装 skill

skill 的唯一源码为 `skills/extract-proxy-subscriptions/`。复制整个目录到你的 Agent 技能目录，例如 Codex 的 `~/.codex/skills/`，再以 `$extract-proxy-subscriptions` 调用。也可以在仓库中直接指定该 `SKILL.md`。

示例请求：

> 使用 $extract-proxy-subscriptions 分析这个客户端的订阅来源，先确认协议、身份和加密格式，再导出并验证实际转发。

本地打包：

```sh
python -m pip install -r requirements-dev.txt
python scripts/check_skill.py
python scripts/package_skill.py --out-dir dist
```

CI 会生成同一份安装 ZIP。skill 包只包含入口、UI 元数据和参考资料；其中记录了完整订阅与逐线路接口的差异、账号与设备身份、Fake-IP 排错、原子续期、分流验证和公开发布边界。

## 开发与验证

```sh
npm ci
npm ci --prefix vps-service
python -m pip install -r requirements-dev.txt
npm test
npm run test:vps
npm run check
python -B -m unittest discover -s leapvpn -p 'test_*.py'
python -B -m unittest discover -s tests -p 'test_*.py'
python scripts/check_public_files.py
```

这些测试使用合成数据，不登录真实账号。真实出口与规则命中需要独立核心验收，详见 [开发说明](docs/DEVELOPMENT.md) 和 skill 的 [验证与维护](skills/extract-proxy-subscriptions/references/validation-and-maintenance.md)。

## 公开版本与部署

这里提供可移植的源码、示例配置和测试。部署地址使用 `sub.example.com`，自定义内网规则使用 `intranet.example`、`office.example`；部署前替换为自己的设置。普通提取不要求部署 Worker 或 VPS。

VPS 服务复用原有提取器，按 provider 使用独立读取 token，并在验证失败时保留上次有效缓存。初始化和后续升级分开；已有服务不能重跑初始化来更新代码。完整目录布局、权限和启动前检查见 [VPS 说明](vps-service/README.md)。
