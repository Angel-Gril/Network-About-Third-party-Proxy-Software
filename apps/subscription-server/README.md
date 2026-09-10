# 私有订阅分发服务

Node.js 服务从最后有效缓存分发 FlyingBird 和 LeapVPN 订阅。每家使用独立读取 token；Nginx 保护管理入口，Node 后台仅监听回环地址。服务通过 `@proxy-toolkit/flybird` workspace 包调用飞鸟实现，飞跃自动登录和导出由 `providers/leapvpn/` 中的 Python 包完成。

## 源码与运行布局

需要 Node.js 22+、Python 3.10+、Nginx、systemd；初始化另需 OpenSSL 和 `htpasswd`。下面是模板默认布局，所有域名和账号均需换成自己的设置。

```text
/opt/private-subscription/                        ← 完整仓库
  package.json / package-lock.json                ← npm workspaces 与唯一锁文件
  node_modules/                                  ← 根目录安装的依赖与 workspace 链接
  providers/flybird/                              ← 飞鸟包源码
  providers/leapvpn/src/leapvpn/                  ← 飞跃 Python 包源码
  providers/leapvpn/.venv/                        ← 安装飞跃包的 Python 环境
  apps/subscription-server/                      ← 本应用
/etc/private-subscription/service.env             ← 运行配置
/etc/private-subscription/flybird.json             ← 私有账号文件
/etc/private-subscription/leapvpn-account.json     ← 私有账号文件
/var/lib/private-subscription/state/leapvpn/       ← 持久化设备状态
/var/lib/private-subscription/cache/               ← 最后有效配置与规则数据
/var/lib/private-subscription/read-tokens/         ← 两家独立读取 token
```

从完整仓库根目录安装依赖：

```sh
cd /opt/private-subscription
npm ci --omit=dev --ignore-scripts
python3 -m venv providers/leapvpn/.venv
providers/leapvpn/.venv/bin/python -m pip install ./providers/leapvpn
```

应用从根目录的 workspace 依赖解析飞鸟包；Python 运行依赖由飞跃包的 `pyproject.toml` 维护。若 Node 的实际路径不同于 `/usr/local/bin/node`，修改 [systemd 单元](deploy/systemd/private-subscription.service) 和 [刷新单元](deploy/systemd/private-subscription-refresh@.service) 的 `ExecStart`。模块关系见 [架构说明](../../docs/ARCHITECTURE.md)。

## 新安装

1. 创建无交互登录的 `subsvc` 用户和组，将完整仓库放到 `/opt/private-subscription`，按上文安装依赖。
2. 确认 `/etc/private-subscription` 中没有需要保留的账号或运行配置，再从仓库根目录以管理员运行 `sh apps/subscription-server/deploy/provision-secrets.sh`。脚本会在发现已有配置、token、设备状态或管理口令文件时停止。
3. 在私有终端保存初始化结果。脚本创建缓存、token 和状态目录，生成两家读取 token 及管理密码；这些输出不要进入 CI、日志收集或公开文档。
4. 修改 `service.env` 的 `PUBLIC_DOMAIN`，准备自己有效的账号文件，并确认所有路径和权限。默认 `LEAPVPN_PYTHON` 为 `/opt/private-subscription/providers/leapvpn/.venv/bin/python`，服务通过 `-m leapvpn.refresh` 调用其中已安装的包。飞跃首次独立登录会占用一个设备名额。
5. 配置自己的 DNS 和 TLS 证书，将 [HTTPS 模板](deploy/nginx/subscription.conf) 和按需使用的 [HTTP 过渡模板](deploy/nginx/acme.conf) 中的 `sub.example.com`、证书和 TLS options 路径改成实际值。证书相关 include 与 DH 参数文件必须存在；也可按证书管理方式调整这些 TLS 指令。
6. 将 `apps/subscription-server/deploy/systemd/` 下的单元安装到 `/etc/systemd/system/`，运行 `systemctl daemon-reload`。启动前运行 `nginx -t`、带单元路径的 `systemd-analyze verify`，并以 `subsvc` 验证代码、目录和私有文件可读写范围。首次刷新成功后再向客户端分发读取链接。

账户配置与 `service.env` 通常为 `root:subsvc 0640`；设备状态和 token 为 `subsvc:subsvc 0600`，状态目录为 0700。不要向公网暴露 Node 的 3100 端口。

自动续期使用 `LEAPVPN_CREDENTIAL_FILE` 和 `LEAPVPN_AUTH_STATE_FILE`。使用已有会话文件时，取消这两项并设置 `LEAPVPN_SESSION_FILE`，服务改为调用 `-m leapvpn.export --fetch-all`。只有需要自定义命令文件时才设置可选的 `LEAPVPN_EXPORT_SCRIPT`；它会替换模块入口，并接收对应模式的参数。默认初始化不设置此覆盖项。

## 刷新与分流

```sh
systemctl start private-subscription-refresh@flybird.service
systemctl start private-subscription-refresh@leapvpn.service
systemctl enable --now private-subscription.service private-subscription-refresh-flybird.timer private-subscription-refresh-leapvpn.timer
```

timer 模板每六小时执行，时间按服务器时区。管理页面 `/admin/` 也提供逐 provider 的复制、下载、刷新和显式重置功能。读取链接形如 `/s/<READ_TOKEN>/leapvpn.yaml`。

LeapVPN 导出后应用 FlyingBird 的共享分流 renderer，保持节点连接参数，检查策略引用，再发布缓存。默认含 15 个策略组和 19 条规则，前两个内网后缀为公开占位示例；GeoX 更新周期为 24 小时。实际节点数随上游目录变化。

FlyBird 入口恢复只在新入口无真实 DNS、旧入口仍有效且连接身份匹配时替换 server。失败保留最后有效缓存；DNS 正常也不表示每个出口都可用。

订阅 URI 含读取 token，因此 Nginx 的 HTTP 过渡配置、重定向入口和 HTTPS 订阅路径关闭相应请求日志；订阅路径也关闭会带出完整 URI 的 upstream error 日志。故障诊断使用服务状态、脱敏刷新错误和健康接口。

## 升级与回滚

升级时不重跑初始化。按明确文件清单准备完整仓库快照，保存原应用、缓存和配置，更新根 npm 依赖与虚拟环境中的飞跃包；在隔离目录以真实服务用户运行预发布，再切换应用并验证正式刷新。旧布局的服务路径和环境配置对应关系见 [迁移说明](../../docs/MIGRATION.md)。

至少检查健康接口、正确读取 token、错误及跨 provider token、未认证管理页面、原链接有效性和两个 timer。将最终 HTTPS 文件与已验证候选按哈希绑定。失败时恢复备份并重新验证；不静默重置 token 或设备。

## 开发检查

```sh
# 从仓库根目录执行。
npm ci
npm test --workspace @proxy-toolkit/subscription-server
npm run check --workspace @proxy-toolkit/subscription-server
python -B -m unittest discover -s apps/subscription-server/tests -p 'test_*.py'

# Linux 上安装 Nginx 和 OpenSSL 后，可检查模板语法和读取 URI 的日志保护。
python apps/subscription-server/scripts/check_nginx.py
```

依赖统一在仓库根目录安装。从应用目录可直接执行 `npm test` 与 `npm run check`。刷新测试使用真实飞鸟分流函数、合成导出器与临时目录，覆盖缓存、token 隔离和失败路径；不会访问真实 provider。
