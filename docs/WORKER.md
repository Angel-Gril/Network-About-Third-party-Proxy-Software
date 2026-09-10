# 可选 Cloudflare Worker

`src/worker.js` 可以从 FlyingBird 账号、订阅 token 或已导出的 YAML 生成加密链接，并提供可选的 KV profile、缓存分发与规则资源代理。Worker 能否直接访问上游取决于上游当前策略。

## 本地与部署配置

```sh
npm ci
npx wrangler dev
```

本地使用 `.dev.vars` 保存自行生成的 `LINK_SECRET` 和 `ACCESS_KEY`。示例文件只有空值。线上通过 Wrangler secret 设置，使用不同的随机值：

```sh
npx wrangler secret put LINK_SECRET
npx wrangler secret put ACCESS_KEY
npx wrangler deploy
```

`LINK_SECRET` 用于加密链接中的认证资料，更换后旧链接会失效；`ACCESS_KEY` 用于保护 Worker 的使用范围。完整生成链接也属于凭据。

## 缓存模式

使用 profile 时先创建自己的 KV namespace，并在 `wrangler.toml` 加入 `SUB_CACHE` binding。定时刷新默认关闭，配置完成后再按需要启用。

如果 Worker 被上游拒绝而本机导出仍可用，可以上传本机导出的 YAML：

```powershell
.\sync_worker_cache.ps1 `
  -WorkerUrl 'https://worker.example.com' `
  -AccessKey '<YOUR_ACCESS_KEY>' `
  -YamlPath '.\fb_export\fb_clash.yaml'
```

后续使用相同 `ProfileId` 更新缓存。输出的 profile 链接包含访问能力，保存在自己的客户端中，不放到公开问题或仓库。

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

Worker 的分流是共享 renderer；根目录本地导出脚本的 `routing_template.yaml` 是另一个可选模板入口。VPS 的飞跃桥接复用 Worker renderer，而不会重新实现飞跃参数转换。

## 检查

```sh
npm test
node --check src/worker.js
```

测试使用合成账号和响应。现场检查应分别确认下载、解密、真实 DNS、转发与缓存，不能只看 HTTP 200。
