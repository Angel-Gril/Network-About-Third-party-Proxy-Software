# 变更记录

## 未发布

- 私有订阅服务器新增 Clash YAML、明文 URI 与 v2rayN Base64 三种读取格式；原 `.yaml` 链接和 provider token 保持有效。
- 管理页新增逐 provider 自动刷新开关和 5 分钟至 30 天的间隔设置，systemd 每五分钟检查一次到期状态，默认仍为六小时。
- MonoCloud 导出在读取节点前检查套餐截止时间和流量额度；流量用尽或套餐过期时明确失败并保留最后有效缓存，本地 CLI 增加 v2rayN Base64 文件。
- 飞鸟刷新在入口域名轮换或 DNS 传播期间自动重新拉取并短暂重试；修复 release 软链接导致调度器空操作的问题，刷新失败改用 5 分钟退避，成功后更新最后有效缓存。

- 新增 MonoCloud 1.0.1 账号认证和 Shadowsocks 套餐导出，提供 Clash、`ss://`、备用 API、限流停止与错误脱敏回归。
- 私有订阅服务器新增 MonoCloud 独立凭据、读取 token、定时刷新、最后有效缓存和管理入口；未验证的 VPN 套餐明确拒绝发布。

- 适配飞鸟 Windows 3.1.8 的订阅客户端标识、AES-256-GCM 响应与 `enc1:` 地址首选项，保留旧 CBC 格式；Windows PowerShell 5.1 通过系统 CNG 验证认证标签。
- 本地导出遇到 TUN Fake-IP 时用 DNS-over-HTTPS 复核真实节点入口；失败继续保留旧文件。补充新版加密、篡改拒绝、旧格式兼容和服务器缓存保护回归。

- 新增订阅发布证据校验器，将候选、公网文件、源站快照与实际规则测试记录按哈希绑定，拒绝旧证据、失败用例和不完整覆盖。
- 补充校验器的 CLI、证据格式和回归测试；严格拒绝 YAML 解析警告，避免私有源文本通过 stderr 泄露。

- 将飞鸟和飞跃平级归入 `providers/`，把 Worker 与 VPS 服务归入 `apps/`，源码、测试、模板和部署文件各自归属模块。
- 使用 npm workspaces 与根目录唯一锁文件；Worker 和 VPS 导入同一个飞鸟包，移除按另一个应用文件路径导入的依赖。
- 将飞跃整理为可安装的 Python src 包，提供 `python -m leapvpn.export/refresh/sync` 入口；飞鸟默认输出改为仓库 `exports/flybird/`。
- 修复 PowerShell 切换当前目录后，相对导出路径和缓存上传路径可能指向进程启动目录的问题。
- 修复 Windows PowerShell 5.1 缓存上传时序列化文件元数据导致停顿的问题，并覆盖无 BOM UTF-8 中文节点名。
- 增加跨目录入口、真实分流函数与两种 Python 调用模式的回归，统一开发验证与构建入口，恢复标准 Windows/Linux CI checkout。
- 补全两家使用说明、架构、迁移与贡献文档，同步 skill 路径，增加 Markdown 链接检查及编辑器格式约定。
- 此次调整包含脚本和部署路径变化；升级方式见 [迁移说明](docs/MIGRATION.md)，现有 VPS 不会自动迁移。

## 1.0.0 — 2026-09-10

- 整理 FlyingBird 本地导出、可选 Worker、LeapVPN 协议 X 提取与自动续期，以及 VPS 缓存分发源码。
- 新增 `extract-proxy-subscriptions` skill，记录客户端分析、协议差异、认证状态、实际转发验证与维护方法。
- 将部署域名、SSH 目标和内网规则转换为公开示例或显式参数，保留实际运行数据在原环境。
- 增加公开内容检查、skill 校验和打包、跨平台 CI 及开发约定。
- 补充缓存有效性、错误脱敏、Fake-IP、同步目标和初始化不覆盖现有认证的回归保护。
