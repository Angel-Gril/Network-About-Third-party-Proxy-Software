# FlyingBird / 飞鸟云

本地导出器登录自己的账号，取得并解密完整订阅，生成 Mihomo/Clash 和 v2rayN 文件。JavaScript 实现以 `@proxy-toolkit/flybird` 包供 [Worker](../../apps/cloudflare-worker/README.md) 与 [订阅服务器](../../apps/subscription-server/README.md) 复用。

## 本地导出

需要 Windows PowerShell 5.1 或 PowerShell 7。以下命令从仓库根目录执行：

```powershell
.\providers\flybird\export.bat
pwsh -NoProfile -File .\providers\flybird\src\export.ps1 -Email 'you@example.com'

# 明确指定输出位置或自己的模板。
pwsh -NoProfile -File .\providers\flybird\src\export.ps1 -Email 'you@example.com' -OutDir '.\exports\flybird-second' -RoutingTemplatePath '.\private\mihomo.yaml'
```

不传密码时会安全提示输入。脚本从已安装客户端的首选项发现 API 地址，也支持 `-ApiBaseUrl` 显式覆盖；需要 HTTP 代理时使用 `-ProxyUrl`。

已适配 Windows 客户端 `3.1.8+2026071612`：识别 `enc1:` 加密的 API 地址首选项，按新版客户端标识下载订阅，并验证 AES-256-GCM 认证标签后解密。旧 AES-128-CBC 订阅继续兼容。Windows PowerShell 5.1 使用系统 CNG，PowerShell 7 使用 .NET 的 AES-GCM；无需额外密码学依赖。账号仍由参数或交互输入提供。

本机开启 TUN 时，如果系统 DNS 仅返回 Fake-IP，导出器通过 Google DNS-over-HTTPS 复核节点域名。只有取得真实 A/AAAA 地址才继续；正常 DNS 不调用外部复核，配置中的域名也不替换成查询结果。复核失败仍保留原导出文件。

已有 Python 工作流可调用薄启动器：

```sh
python providers/flybird/src/export.py --email you@example.com --outdir exports/flybird-second
```

Python 入口仅转发参数到同目录的 PowerShell 导出器，不实现另一套解密逻辑。

## 7.2.x 客户端态 bundle

Windows 客户端 7.2.x 的账号登录会经过官方客户端完成，云端刷新不应重复调用密码登录接口。登录成功后，可以在同一台 Windows 机器上导出一个只供私有传输的客户端态 bundle：

```powershell
pwsh -NoProfile -File .\providers\flybird\src\export_client_state.ps1
```

脚本使用当前 Windows 用户的 DPAPI 解开客户端 secure storage，只写出 7.2.x 的 `apex-url-v2` 加密订阅字段、profile key 和会话摘要。原始 secure storage、账号密码和明文订阅不会写入 bundle。Linux/Node 刷新器通过 `@proxy-toolkit/flybird/client-state` 解开 `APEX 02` AES-128-GCM envelope，再用订阅 token 拉取配置；它不会执行 FlyingBird 密码登录。

将 bundle 放在私有目录中，并通过受保护的管理通道传给订阅服务器。bundle 中的会话可能过期，重新登录后需要重新导出；不要把 bundle 提交到仓库或放进公开 Worker KV。

运行时内存证据可以另存为 `apex-client-state/v1` fixture，记录当前 API/订阅域名和路径改写表。此类 fixture 只有路由证据，没有 `access_key`，只能用于离线解析和路由测试；不能传给刷新任务当作在线凭据。

## 无 GUI 的 v2 协议客户端

服务器不需要运行 Flutter/GTK 客户端。Node.js 22+ 可以直接执行 v2 协议 CLI：

```sh
# 直接使用已经取得的 access_key
node providers/flybird/src/headless.mjs \
  --access-key "$FLYBIRD_ACCESS_KEY" \
  --out /var/lib/private-subscription/flybird/raw

# 或用已有的 xboard_token 换取 access_key
node providers/flybird/src/headless.mjs \
  --token "$FLYBIRD_XBOARD_TOKEN" \
  --out /var/lib/private-subscription/flybird/raw
```

CLI 只负责登录态交换、订阅下载和保存原始响应；`raw_body.bin` 需要交给 APXS v2 解密器，再经过节点校验后发布。当前上游 v2 域名返回 404 时，CLI 会失败并保留调用方的最后有效缓存，不会把错误页面当成订阅。

## 文件与路径

默认输出固定为仓库 `exports/flybird/`；显式相对输出路径以当前调用目录为准。脚本和模板按模块目录定位，因此从其他目录启动也能找到资源。

| 文件 | 内容 |
| --- | --- |
| `fb_clash.yaml` | 应用分流模板后的完整配置 |
| `fb_clash_nodes.yaml` | 节点配置 |
| `fb_v2rayn_links.txt` | 分享链接 |
| `fb_v2rayn_subscription_base64.txt` | Base64 订阅 |
| `fb_meta.json` | 导出摘要 |

重复导出到同一目录会更新文件。要保留上次结果，请使用新的输出目录。默认分流由 [templates/mihomo.yaml](templates/mihomo.yaml) 维护，自定义域名规则请改为自己的设置。

## 模块归属

- [src/export.ps1](src/export.ps1)：本机登录、下载、解密与文件输出。
- [src/profile_codec.ps1](src/profile_codec.ps1)：新版首选项、GCM 订阅和旧 CBC 格式的解码。
- [src/routing.ps1](src/routing.ps1)、[src/validation.ps1](src/validation.ps1)：本地模板应用与入口检查。
- [src/subscription.js](src/subscription.js)：JavaScript 订阅处理、共享分流、链接和缓存接口。
- [src/sync_worker_cache.ps1](src/sync_worker_cache.ps1)：上传已有 YAML。
- [src/update_worker_kv_cache.ps1](src/update_worker_kv_cache.ps1)：本地重新导出后更新 Worker 缓存。

Worker 的部署配置位于应用目录。缓存上传参数见 [Worker 说明](../../apps/cloudflare-worker/README.md)。

## 验证

在仓库开发环境中执行：

```sh
npm test --workspace @proxy-toolkit/flybird
python -B scripts/test_python.py --suite flybird
```

回归使用合成响应和临时输出，覆盖转换、缓存失败保护、错误脱敏、Fake-IP 和启动路径。订阅能下载、解密或解析，不代表入口仍有效；真实 DNS、握手、HTTP 转发与规则命中分别验收。分析依据见 [客户端模式](../../skills/extract-proxy-subscriptions/references/client-patterns.md)。
