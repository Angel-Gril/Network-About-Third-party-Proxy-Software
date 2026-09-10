# Cloudflare Worker

可选的 FlyingBird 分发应用。入口 [src/index.js](src/index.js) 导入 `@proxy-toolkit/flybird`；提供加密链接、KV profile、缓存分发与规则资源代理。能否直接访问上游取决于上游当前策略。

## 本地运行

从仓库根目录安装一次 npm 依赖：

```sh
npm ci --ignore-scripts
npm run dev --workspace @proxy-toolkit/cloudflare-worker
```

启动前将 [.dev.vars.example](.dev.vars.example) 复制为应用目录下的 `.dev.vars`，填入自行生成且互不相同的 `LINK_SECRET` 与 `ACCESS_KEY`。

`LINK_SECRET` 加密链接中的认证资料，更换后旧链接会失效；`ACCESS_KEY` 保护使用范围。完整生成链接也属于凭据。

## 部署

[wrangler.toml](wrangler.toml) 与入口都由本应用维护。在已配置自己的 Cloudflare 账号、域名和密钥后，从本应用目录执行：

```sh
npx wrangler secret put LINK_SECRET
npx wrangler secret put ACCESS_KEY
npm run deploy
```

使用 profile 时，先创建自己的 KV namespace，在 `wrangler.toml` 中加入 `SUB_CACHE` binding。定时任务默认关闭，设置好对应密钥和 KV 后再按需要启用。

## 缓存模式

如果 Worker 被上游拒绝而本机导出仍可用，可以从仓库根目录上传已有 YAML：

```powershell
.\providers\flybird\src\sync_worker_cache.ps1 `
  -WorkerUrl 'https://worker.example.com' `
  -AccessKey '<YOUR_ACCESS_KEY>' `
  -YamlPath '.\exports\flybird\fb_clash.yaml'
```

后续用相同 `ProfileId` 更新缓存；参数省略时会创建新的 profile。profile 链接包含访问能力，保存在自己的客户端中。

## 接口

| 路径 | 用途 |
| --- | --- |
| `GET /` | 链接生成页面 |
| `POST /api/links` | 账号方式生成链接 |
| `POST /api/token-links` | 已有 token 方式生成链接 |
| `POST /api/cache` | 上传并验证本地 YAML |
| `GET /sub` | Mihomo 增强订阅 |
| `GET /sub/base64` | v2rayN Base64 订阅 |
| `GET /p/<profileId>/sub` | KV profile 订阅 |
| `GET /rules/<asset>` | 允许列表内的规则数据 |

Worker 与订阅服务共用飞鸟包的 JavaScript 分流函数；本地 PowerShell 导出使用提供者自己的 [Mihomo 模板](../../providers/flybird/templates/mihomo.yaml)。

## 检查

从仓库根目录执行：

```sh
npm test --workspace @proxy-toolkit/cloudflare-worker
npm test --workspace @proxy-toolkit/flybird
npm run build --workspace @proxy-toolkit/cloudflare-worker
```

build 使用 Wrangler 的 `--dry-run`，只在 `dist/cloudflare-worker/` 生成 bundle，不部署线上应用。入口测试和提供者回归使用合成数据；现场验收分别确认下载、解密、真实 DNS、转发和缓存。
