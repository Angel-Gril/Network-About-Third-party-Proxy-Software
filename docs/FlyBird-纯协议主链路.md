# FlyBird 纯协议主链路

## 结论

当前生产方案不需要 Windows、Flutter、OpenWrt Go 客户端、network namespace 或进程内存提取。
它使用普通 Python 进程完成：

```text
API mTLS 登录
  → JWT
  → access-token
  → subscription mTLS 下载 APXS v2
  → AES-GCM tag 与 Ed25519 完整性校验
  → AES-CTR 等价数据流解密
  → 官方节点 DNS 查询或绑定身份的已验证入口缓存
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
[-80:-64] 16-byte GCM tag
[-64:]   64-byte signature field
```

当前构建的 AES 密钥通过部署配置传入实现。计数器为：

```text
nonce || 00 00 00 02
```

APXS 的尾部 16 字节是标准 GCM tag，AAD 为 `apex-sub-v2\0` 加信封前 25 字节。Ed25519 覆盖 `apex-sub-sign-v2\0` 加签名前全部字节。必须先验证 tag 和签名，再使用等价 CTR 数据流解密；不能把能解出 YAML 当成完整性通过。

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

- 上游的节点专用 DNS、启动解析器和 IPv6 设置保持原样；网站域名仍通过 `节点选择` 访问 Cloudflare/Google DoH。入口预解析由 `flybird-entries.mjs` 在渲染前完成，避免第三方导入器丢失 DNS 定义后无法引导。
- 国内 GeoSite 域名使用国内 DoH；`agentrouter.org`、`anyrouter.top` 显式使用代理 DoH，并在 GeoIP 规则前匹配 `AI服务`。
- 保留上游 `dns.ipv6`；没有上游设置时默认开启。可用 IPv4 优先，无 IPv4 时保留 IPv6 入口；后者要求客户端有 IPv6 连通性。节点认证、SNI、`ip-version` 和 TLS 参数保持原样。
- 启用 HTTP/TLS/QUIC 嗅探、纯 IP 解析和目标域名恢复；保留上游局域网、STUN 的 Fake-IP 排除项与嗅探排除项。

模板不启用宿主机 TUN，不修改本机系统 DNS。客户端更新订阅后应重新加载配置，才能应用新网络策略。
网站 TLS 证书验证保持开启；不能用跳过证书校验代替 DNS 修复。诊断时区分真实 DNS、Fake-IP 映射与代理节点入口解析。

Private Subscription 的 `private-subscription-refresh-flybird.timer` 每五分钟检查后台保存的开关和刷新间隔，到期时通过 trigger path 调用同一个 root `apex-fetch.service`。管理页手动刷新不受自动刷新开关限制。接入统一调度后停用固定六小时的 `apex-fetch.timer`，避免两套周期冲突；独立部署可继续使用该固定周期。

通过 `service.env` 的 `FLYBIRD_REFRESH_TRIGGER_FILE` 指定 trigger 文件的绝对路径（路径应位于服务可写的状态目录）。旧的 `FLYBIRD_OPENWRT_TRIGGER=1` 兼容保留，但不会运行旧客户端。外部 worker 使用 `.pending` 状态锁合并手动和定时请求，等待缓存的成功或失败记录更新；仅写入 trigger 不算刷新成功。超时记录失败并保留有效缓存；页面显示 `Refreshing…`，实际发布后才更新日期与下一次刷新时间。

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

## 节点入口解析与故障回退

root 服务入口的版本化包装器位于 `apps/subscription-server/deploy/apex-fetch.sh`，仍调用部署中现有的纯协议 Python 抓取器。包装器先调用 `flybird-entries.mjs`，再调用 renderer；定时任务和管理页手动刷新共用这条路径。没有新增客户端、TUN 或常驻 DNS 服务。

解析器优先使用订阅中的 HTTPS 节点 DNS，发送 RFC8484 GET，并在配置了 DoH 身份时提供客户端证书。必须验证 TLS、DNS 问题名/类型和实际 A/AAAA 答案；解析器主机名能解析不算节点解析成功。不会跟随重定向发送身份，也不允许 Fake-IP、本地或文档地址成为入口。

新地址不可得时，仅允许恢复同一原域名、相同整组节点认证/端口/SNI/传输指纹的近期缓存。缓存默认最长 24 小时，可用 `ENTRY_MAX_AGE_SECONDS` 配置，最多七天。失败不会更新地址观察时间；身份变化、缓存过期或缺失时拒绝发布并保留原订阅。可信管理员可以导入经实际客户端转发验证的地址，缓存位于私有状态文件，不进入源码。

部署可配置 `ENTRY_STATE`（默认 `/var/lib/apex-fetch/entry-addresses.json`）、`DOH_CERT` 和 `DOH_KEY`。身份文件缺失时不代表私有解析已验证；查询失败只能使用符合绑定与时限的缓存。`flybird.json` 的 `entryResolution` 明确区分实时解析、缓存恢复、观察日期及 IPv6-only 入口，`lastWarning` 报告降级状态。完整性验证、DNS 地址解析与实际代理转发仍分别验收。

仅复原 DNS 字段不能保证所有客户端工作：部分导入器只保留节点，部分节点区使用私有 DNS。发布的是本轮解析得到的字面入口地址，并保留原 TLS 主机名。上游无法提供新地址时，缓存回退不等于完成了新的上游 DNS 验证。

通用分发默认 `ENTRY_REQUIRE_IPV4=1`：每个入口必须取得可用格式的 IPv4 地址。仅有 IPv6 的候选会以独立错误拒绝发布并保留现有缓存，不能据此宣布普通 IPv4 设备恢复。仅为明确支持 IPv6 的独立分发环境测试时，才显式设置为 0；这不等于官方缺少 IPv4。候选地址的 DNS 验证和真实协议转发仍分开记录。
