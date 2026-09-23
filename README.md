# 第三方代理软件订阅工具

[![Validate and package](https://github.com/Angel-Gril/Network-About-Third-party-Proxy-Software/actions/workflows/ci.yml/badge.svg)](https://github.com/Angel-Gril/Network-About-Third-party-Proxy-Software/actions/workflows/ci.yml)

从自己有权使用的账号或客户端配置中提取代理参数，转换为标准订阅，并提供可选的缓存分发服务。包含 FlyingBird（飞鸟云）、LeapVPN（飞跃）和 MonoCloud 三家实现，以及可迁移到同类客户端的分析 skill。

## 支持情况

| 提供者 | 已实现 | 运行入口 |
| --- | --- | --- |
| [FlyingBird / 飞鸟云](providers/flybird/README.md) | 账号登录、完整订阅解密、Mihomo 分流、v2rayN 导出；可选 Worker 和 VPS 分发 | PowerShell 本地导出、JavaScript 共享包 |
| [LeapVPN / 飞跃](providers/leapvpn/README.md) | 协议 X 的逐线路提取、Clash/Xray/VLESS 导出、设备身份持久化与会话续期 | 可安装的 Python 包 |
| [MonoCloud](providers/monocloud/README.md) | 账号登录、套餐与流量检查、Shadowsocks 节点、Clash、`ss://` 与 v2rayN 导出 | JavaScript 共享包与 CLI |

飞跃实现基于已分析的 1.5.8 Windows 客户端；协议 X 为 VLESS + WebSocket + TLS，协议 W 的第三方核心兼容性尚未验证。软件升级或上游变化后，需要重新确认适用范围。

## 项目结构

```text
providers/                   提供者实现
  flybird/                   源码、测试、本地导出模板
  leapvpn/                   Python 包与测试
  monocloud/                 JavaScript 账号导出与测试
apps/                        可部署应用
  cloudflare-worker/         Worker 入口与 Wrangler 配置
  subscription-server/       VPS 服务、管理页、Nginx/systemd 模板
skills/
  extract-proxy-subscriptions/
scripts/                     仓库检查、测试调度、skill 打包
tests/                       仓库工具测试
docs/                        架构、开发与迁移说明
```

三个提供者平级放在 `providers/`；应用复用提供者代码。JavaScript 使用 npm workspaces，依赖由根目录唯一的 lockfile 管理。详见 [架构说明](docs/ARCHITECTURE.md)；旧版本用户先看 [迁移说明](docs/MIGRATION.md)。

## 快速开始

以下命令从仓库根目录执行。普通提取无需部署 Worker 或 VPS。

### 飞鸟：Windows 本地导出

需要 Windows PowerShell 5.1 或 PowerShell 7；无需先安装 npm 依赖。

```powershell
.\providers\flybird\export.bat

# 指定邮箱，密码由交互提示输入。
pwsh -NoProfile -File .\providers\flybird\src\export.ps1 -Email 'you@example.com'
```

默认写入仓库 `exports/flybird/`，包含 Mihomo YAML、节点 YAML、分享链接、Base64 订阅和摘要。指定 `-OutDir` 时，相对路径以调用目录为准。API 地址发现、自定义模板和 Python 启动器见 [飞鸟说明](providers/flybird/README.md)。

### 飞跃：安装后导出

在 Python 3.10+ 的虚拟环境中执行：

```sh
python -m pip install ./providers/leapvpn
python -m leapvpn.export
python -m leapvpn.export --fetch-all --out-dir exports/leap-first
```

默认读取已登录 Windows 客户端的配置；其他平台或配置副本使用 `--settings` 指定文件。在线模式会请求当前线路参数，输出目录必须尚不存在。自动续期和同步用法见 [飞跃说明](providers/leapvpn/README.md)。

### 可选分发服务

- [Cloudflare Worker](apps/cloudflare-worker/README.md)：加密链接、KV 缓存与规则资源代理。
- [私有订阅服务器](apps/subscription-server/README.md)：三家独立读取 token、定时刷新、最后有效缓存和管理入口。

### MonoCloud：账号导出

需要 Node.js 22+。账号保存在忽略的私有 JSON 文件中：

```sh
node providers/monocloud/src/export.mjs \
  --credentials private/monocloud.json \
  --out-dir exports/monocloud-first
```

当前实现绑定 Windows 客户端 1.0.1，已实际验证 Shadowsocks 套餐；本地输出包含 Clash YAML、明文 `ss://` 列表和 v2rayN Base64 订阅。详情见 [MonoCloud 说明](providers/monocloud/README.md)。

导出文件与完整订阅链接包含连接凭据，应保存在本地私有目录。仓库提供示例域名和配置，不包含可直接使用的账号或订阅。

## 安装 skill

唯一源码为 [skills/extract-proxy-subscriptions](skills/extract-proxy-subscriptions/SKILL.md)。复制整个目录到 Agent 技能目录，例如 Codex 的 `~/.codex/skills/`，或直接指定仓库中的 `SKILL.md`。

> 使用 $extract-proxy-subscriptions 分析这个客户端的订阅来源，确认协议、身份和加密格式，导出并验证实际转发。

skill 总结完整订阅与逐线路接口、认证状态、Fake-IP 排错、原子续期、分流验收和发布边界，不复制提取算法。CI 提供安装 ZIP；本地可在开发环境中运行 `npm run skill:pack`。

## 开发与验证

按 [开发说明](docs/DEVELOPMENT.md) 创建并激活 Python 虚拟环境后：

```sh
npm ci --ignore-scripts
python -m pip install -r requirements-dev.txt
npm run verify
```

统一检查覆盖 Node/Python 回归、文档链接、公开内容、skill，以及 Worker 和 Python wheel 打包。CI 在 Windows、Linux 上执行，Linux 另检查 Nginx。测试使用合成数据；真实出口和规则命中需要 [独立验收](skills/extract-proxy-subscriptions/references/validation-and-maintenance.md)。

参与修改请读 [贡献说明](CONTRIBUTING.md)、[开发约定](AGENTS.md) 和 [变更记录](CHANGELOG.md)。
