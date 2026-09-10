# 目录迁移说明

本次将提供者、应用和仓库工具分开。原有脚本路径会改变；协议转换、会话身份、缓存失败保护和订阅读取 token 的语义保持不变。

## 路径对应

| 旧位置 | 新位置或调用方式 |
| --- | --- |
| `export_fb_all.ps1` | `providers/flybird/src/export.ps1` |
| `export_fb_all.py` | `providers/flybird/src/export.py` |
| `run_export_fb_all.bat` | `providers/flybird/export.bat` |
| `routing.ps1`、`subscription_validation.ps1` | `providers/flybird/src/routing.ps1`、`validation.ps1` |
| `routing_template.yaml` | `providers/flybird/templates/mihomo.yaml` |
| `sync_worker_cache.ps1`、`update_worker_kv_cache.ps1` | `providers/flybird/src/` 中的同名脚本 |
| `src/worker.js` | `providers/flybird/src/subscription.js`，由 `@proxy-toolkit/flybird` 导出 |
| `wrangler.toml`、`.dev.vars` | `apps/cloudflare-worker/` |
| `docs/WORKER.md` | `apps/cloudflare-worker/README.md` |
| `leapvpn/export_leapvpn.py` | 安装包后调用 `python -m leapvpn.export` |
| `leapvpn/refresh_leapvpn.py` | `python -m leapvpn.refresh` |
| `leapvpn/sync_vps_session.py` | `python -m leapvpn.sync` |
| `leapvpn/receive_vps_session.py` | `python -m leapvpn.receive` |
| `vps-service/` | `apps/subscription-server/` |
| `test/` 和提供者测试 | 各模块自己的 `tests/` |
| `scripts/check_nginx_templates.py` | `apps/subscription-server/scripts/check_nginx.py` |

根目录保留唯一 npm lockfile，旧应用 lockfile 已删除。请从完整仓库根目录安装依赖，不能仅复制应用目录运行。

## 本地工作流

1. 按 [开发说明](DEVELOPMENT.md) 重新安装根 npm 依赖与飞跃 Python 包。
2. 更新快捷方式、计划任务及脚本中的旧入口。安装后使用 `python -m leapvpn.*`，不按文件路径调用包内文件。
3. 飞鸟默认输出由 `fb_export/` 改为仓库 `exports/flybird/`。已有导出不会自动移动；如需继续写入旧位置，显式传入 `-OutDir`。
4. 将 Worker 的私有 `.dev.vars` 放到 `apps/cloudflare-worker/`，核对 KV、密钥和实际域名；本次源码整理不会修改云端配置。

`skills/extract-proxy-subscriptions/` 位置保持不变。使用目录链接安装的环境无需改链接；复制安装的环境更新整个 skill 目录。

## 已有 VPS 安装

新模板使用完整仓库路径 `/opt/private-subscription/`。既有环境的升级步骤如下；不要把新安装的初始化脚本当作升级脚本。

1. 记录现有代码版本、单元、运行配置和原订阅链接，并在私有位置备份代码、`/etc/private-subscription/` 与 `/var/lib/private-subscription/`。
2. 在隔离候选目录准备新源码，运行 `npm ci --omit=dev --ignore-scripts`，创建飞跃虚拟环境并安装 `./providers/leapvpn`。先验证模块可导入、服务源码可检查、路径可读，随后按已有授权范围做预发布验收。
3. 在维护窗口暂停两家刷新 timer，等待正在执行的刷新结束。切换源码后更新下表中的路径，保留原缓存、读取 token、账号文件和设备状态。
4. 以 `subsvc` 核对所需文件权限，运行 `nginx -t`、带单元路径的 `systemd-analyze verify` 与 `systemctl daemon-reload`，再重启 HTTP 服务并恢复 timer。
5. 验证健康接口、两家原读取链接、错误和跨 provider token、未认证管理入口、刷新与 timer；将最终 HTTPS 配置和已验收候选按哈希绑定。

| 项目 | 新配置 |
| --- | --- |
| HTTP 和刷新单元 `WorkingDirectory` | `/opt/private-subscription/apps/subscription-server` |
| HTTP `ExecStart` 的源码 | `/opt/private-subscription/apps/subscription-server/src/server.mjs` |
| 刷新 `ExecStart` 的源码 | `/opt/private-subscription/apps/subscription-server/src/refresh-provider.mjs` |
| `LEAPVPN_PYTHON` | `/opt/private-subscription/providers/leapvpn/.venv/bin/python` |
| `FLYBIRD_WORKER_MODULE` | 删除；应用直接导入 workspace 包 |
| 默认 `LEAPVPN_EXPORT_SCRIPT` | 删除；默认按认证模式调用 `leapvpn.refresh` 或 `leapvpn.export` |
| 自定义 `LEAPVPN_EXPORT_SCRIPT` | 仅在确需覆盖命令文件时保留，并验证参数兼容 |
| systemd 模板 | `apps/subscription-server/deploy/systemd/` |
| Nginx 模板 | `apps/subscription-server/deploy/nginx/` |

Node 可执行文件路径仍需根据服务器实际安装位置核对。`LEAPVPN_CREDENTIAL_FILE`、`LEAPVPN_AUTH_STATE_FILE`、`LEAPVPN_SESSION_FILE` 和缓存/token 路径使用原有私有数据，不重新初始化设备或读取 token。默认 SSH 接收命令也要求远端安装上述飞跃包。

验收失败时恢复之前的代码、运行配置和单元，再检查旧链接与健康状态；不得通过重建身份或覆盖有效缓存掩盖迁移失败。详细布局与新安装步骤见 [订阅服务器说明](../apps/subscription-server/README.md)。

本次 GitHub 目录整理只更新源码与部署模板，不会自动执行现有服务器迁移。
