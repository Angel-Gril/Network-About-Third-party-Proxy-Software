# MonoCloud

实现基于 Windows 客户端 `1.0.1`，样本 SHA-256 为 `2a082057e660602e6b61e977287f4b461bbc472427c558e8fb1b6f872bc455f1`。通过账号登录取得套餐目录，再按套餐取得完整连接字段。目前实际账号仅验证 Shadowsocks 套餐；未验证的 VPN 套餐会明确停止，不会套用猜测的转换。

## 本地导出

从仓库根目录创建私有账号文件，例如 `private/monocloud.json`：

```json
{"email":"you@example.invalid","password":"your-password"}
```

运行：

```sh
node providers/monocloud/src/export.mjs \
  --credentials private/monocloud.json \
  --out-dir exports/monocloud-first
```

输出目录必须不存在。生成 `monocloud_clash.yaml`、明文分享链接 `monocloud_ss.txt`、可导入 v2rayN/v2rayNG 的 Base64 订阅 `monocloud_v2rayn.txt`，以及脱敏的 `monocloud_meta.json`。前三个文件包含真实连接凭据，已由根 `.gitignore` 排除。

## 已确认的数据链

```text
POST /oauth/token
  -> GET /api/service
  -> GET /api/bandwidth/<service-record-id>
  -> GET /api/shadowsocks/<service-record-id>
  -> Clash ss 节点、ss:// 链接与 Base64 订阅
```

导出在读取节点前检查套餐截止时间和 `/api/bandwidth/<id>` 的上传、下载与额度。套餐过期或流量用尽时明确失败，VPS 保留最后有效缓存，不把仍能解析但已无法转发的旧节点标成刷新成功。认证请求需要客户端版本头；账号 token 与 VPS 的订阅读取 token 是两类不同凭据。

服务端可通过 `apps/subscription-server` 定时刷新。服务器使用独立账号文件和读取 token，失败保留最后有效缓存。

## 验证

```sh
npm test --workspace @proxy-toolkit/monocloud
npm run check --workspace @proxy-toolkit/monocloud
```

合成测试覆盖认证字段、备用 API、限流停止、错误脱敏、套餐日期、流量额度、节点转换和 CLI 私有输出。真实验证另行报告 DNS、选定出口转发与规则命中；一个出口成功不代表全部节点可用。
