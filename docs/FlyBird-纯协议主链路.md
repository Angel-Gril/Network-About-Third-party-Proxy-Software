# FlyBird 纯协议主链路

## 结论

当前生产方案不需要 Windows、Flutter、OpenWrt Go 客户端、network namespace 或进程内存提取。
它使用普通 Python 进程完成：

```text
API mTLS 登录
  → JWT
  → access-token
  → subscription mTLS 下载 APXS v2
  → AES-256-CTR 解密
  → 原始 YAML 校验
  → FlyBird 分组/规则 renderer
  → 分发 YAML 校验
  → 原子发布
```

## APXS v2 当前格式

```text
[0:4]    APXS
[4]      0x02
[5:9]    big-endian AES key id
[9:13]   big-endian signature key id
[13:25]  12-byte nonce
[25:-80] AES-CTR ciphertext
[-80:-64] legacy 16-byte trailer field
[-64:]   64-byte signature field
```

当前构建的 AES 密钥通过部署配置传入实现。计数器为：

```text
nonce || 00 00 00 02
```

APXS 的 16 字节尾部字段不是可用的标准 GCM tag；解密使用 AES-CTR。完整性校验应在签名覆盖范围明确后再启用，不能把 CTR 解密成功当成签名验证成功。

## 证书用途

API 和订阅使用两套独立的 mTLS 身份：

- API 证书：登录和 access-token
- subscription 证书：feed/download

缺少对应证书或混用证书时，上游会返回伪装的 404。

## 生产服务

服务器入口由 `apex-fetch.service` 调用纯协议抓取器，输出：

```text
/var/lib/apex-fetch/sub.yaml
/var/lib/private-subscription/cache/flybird.yaml
/var/lib/private-subscription/cache/flybird.json
```

纯协议抓取器拿到的是上游原始 YAML。发布到 Private Subscription 前必须调用
`apps/subscription-server/src/render-flybird.mjs`，由现有 `enhanceMihomoConfig`
补齐完整的 15 个策略组、21 条规则和 GeoX URL；不能把原始 APXS 解密结果直接
作为最终分发文件。renderer 会检查每个分组和规则的目标都能解析到节点、策略组
或 Mihomo 内置目标。渲染失败时保留上一份有效缓存。

### TUN 下的 DNS 与嗅探

发布阶段应用 [网络模板](../apps/subscription-server/templates/flybird-network.yaml)：

- 节点入口使用直连的国内加密 DNS，网站域名默认通过 `节点选择` 访问 Cloudflare/Google DoH，避免 DNS 解析依赖循环。
- 国内 GeoSite 域名使用国内 DoH；`agentrouter.org`、`anyrouter.top` 显式使用代理 DoH，并在 GeoIP 规则前匹配 `AI服务`。
- `dns.ipv6` 关闭，避免异常 AAAA 记录进入客户端连接；节点本身的 `ip-version`、认证和 TLS 参数保持原样。
- 启用 HTTP/TLS/QUIC 嗅探、纯 IP 解析和目标域名恢复；保留上游局域网、STUN 的 Fake-IP 排除项与嗅探排除项。

模板不启用宿主机 TUN，不修改本机系统 DNS。客户端更新订阅后应重新加载配置，才能应用新网络策略。
网站 TLS 证书验证保持开启；不能用跳过证书校验代替 DNS 修复。诊断时区分真实 DNS、Fake-IP 映射与代理节点入口解析。

`apex-fetch.timer` 负责周期刷新；Private Subscription 管理页的 FlyBird 刷新按钮通过 trigger path 触发同一个 root service。失败时保留最后有效缓存。

## 已废弃的路线

官方 OpenWrt 客户端 + netns + `/proc/<pid>/mem` 提取曾用于验证协议和绕过未知密钥，但不再是生产依赖。服务器已删除客户端二进制、geodata、netns 运行资产和内存提取器；回滚文件不放入生产目录。

## 失败门禁

- API 登录失败：不发布
- mTLS 下载失败：不发布
- APXS 头/版本/长度不合法：不发布
- AES-CTR 解密失败：不发布
- YAML 解析失败：不发布
- 节点数低于阈值：不发布
- 分组或规则目标无效：不发布
- 发布使用临时文件 + `fsync`/`os.replace` 或等价原子替换

## 本地验证

```sh
npm test --workspace @proxy-toolkit/flybird
npm test --workspace @proxy-toolkit/subscription-server
npm run test:apxs-fixtures
python scripts/check_public_files.py --staged
```

真实账号、mTLS 私钥、APXS 实例和节点 YAML 只能保存在私有部署环境，不能进入仓库。
