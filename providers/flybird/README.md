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

已有 Python 工作流可调用薄启动器：

```sh
python providers/flybird/src/export.py --email you@example.com --outdir exports/flybird-second
```

Python 入口仅转发参数到同目录的 PowerShell 导出器，不实现另一套解密逻辑。

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
