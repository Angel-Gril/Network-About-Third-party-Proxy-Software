# 项目开发约定

先读 `README.md`、`docs/ARCHITECTURE.md` 和 `docs/DEVELOPMENT.md`，再定位当前任务的实现和相邻测试。这里是公开源码仓库，具体账号、订阅、服务器和现场记录不属于仓库内容。

## 代码归属

- 飞鸟实现：`providers/flybird/src/`；Node 模块由 `@proxy-toolkit/flybird` 导出，Python 文件只启动本地 PowerShell 导出器。
- 飞跃实现：`providers/leapvpn/src/leapvpn/`；运行依赖只在提供者 `pyproject.toml` 中维护。
- MonoCloud 实现：`providers/monocloud/src/`；Node 模块由 `@proxy-toolkit/monocloud` 导出，本地和 VPS 共用。
- Worker 部署入口：`apps/cloudflare-worker/`。
- VPS 分发、缓存和访问控制：`apps/subscription-server/`。
- 可复用方法：`skills/extract-proxy-subscriptions/`；客户端差异放在其 references 中。

优先复用这些实现。不要为 VPS 或 skill 再复制一套提取、解密或认证算法。

提供者和应用的测试放在各自 `tests/`；根 `tests/` 只放仓库工具测试。根目录不增加提供者专用脚本或部署配置。路径变化同步入口、包配置、文档和 CI，迁移期间不保留重复源码副本。

## 改动和验证

- 确认实际行为和影响范围，再修改源码；修复错误先取得可复现证据。
- 稳定行为变化增加有意义的测试；已有测试能覆盖问题时复用它。纯文档修改做针对性检查。
- 测试使用合成配置和临时目录。默认测试不能读取已安装客户端的真实登录态、请求真实账号或修改系统代理。
- 实际 API、代理转发和部署检查与离线测试分别报告。测试通过不能证明所有出口可用。
- 保留最后有效缓存、设备身份和原有订阅读取 token 的语义；任何改变都需要对应的失败或状态测试。
- 文档、示例参数和 CI 随实际行为更新。完整检查命令见 `docs/DEVELOPMENT.md`。

## 公开提交

- 仅提交明确的源码、合成测试、示例配置和公开文档。使用 `.example` 域名和示例路径。
- 账号密码、密码摘要、设备密码、会话 token、完整订阅 URL、节点凭据、导出文件、安装包及私有部署记录都留在本地。
- 客户端内置的通用协议常量与账号凭据分开判断；不要删除必要的协议实现，也不要把账号数据当作示例。
- 提交前运行公开内容检查并检查暂存内容；按明确路径暂存。不得强推或改写他人的历史来处理发布问题。
- 修改源码或发布仓库不自动授权登录真实账号、同步设备、部署服务器或重置读取链接；沿用当前任务已有的明确授权范围。

本文件是仓库的 AI 入口；开发命令与维护流程由 `docs/DEVELOPMENT.md` 统一维护。
