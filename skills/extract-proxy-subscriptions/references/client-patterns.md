# FlyingBird 与 LeapVPN 的已知模式

这是两类实现的参考，不能按软件名称盲目复用。实际客户端、接口和传输可能升级；先用版本、核心哈希与当前响应确认适用范围。

## FlyingBird：完整加密订阅

典型链路为账号登录 → 得到或解析订阅 token → 下载加密订阅 → 解密 → 完整 Clash/Mihomo 节点列表。

已分析实现使用 Base64 → AES-128-CBC → Base64 → YAML。key 和 IV 来自对应客户端实现；应检查实际字节长度和编码。不能借此推断其他软件或新版客户端采用相同常量。

本项目导出器优先读取客户端的 API 地址首选项，允许显式 API 覆盖，并保留已知客户端默认地址作为后备。订阅格式候选优先尝试 `flag=meta`，但以有效结构和真实入口校验作为成功条件。

需要特别区分：

- 本地登录下载与已安装客户端 profile 导出是不同入口。
- Cloudflare Worker 上游被拒绝，不等于本地解密算法失败。可在已授权的本地环境导出，再交给只分发缓存的服务。
- 订阅返回 200 且解密正确，仍可能把全部节点指向已失效的同一个入口域名。此时先查 DNS 和连接层。

在本仓库中，算法由 `providers/flybird/src/export.ps1` 与 `providers/flybird/src/subscription.js` 维护；Python 启动器不另写一套密码学实现。Worker 和 VPS 通过 `@proxy-toolkit/flybird` 包复用 JavaScript 代码。

## LeapVPN 1.5.8：按线路取得连接参数

已分析样本使用 Electron UI 和 Go 核心。UI 协议选项与实际协议的关系：

| 选项 | 已确认实现 | 转换边界 |
| --- | --- | --- |
| 协议 X | VLESS + WebSocket + TLS | 可转换为 Mihomo、Xray 和 VLESS 分享链接 |
| 协议 W | WireGuard 分支，含自定义传输扩展 | 不能仅凭名称保证标准 WireGuard/Mihomo 兼容 |

同一组 X 协议参数的三个输出格式不代表三种代理协议。在线请求明确选择 X 时，不依赖 UI 当前选择了 W 还是 X。

本地设置文件的已知布局为 `12 字节 nonce | AES-GCM 密文 | 16 字节 tag`。该样本使用字面量 ASCII `randBytes(256/8)` 作为 16 字节密钥，实际是 AES-128-GCM。该字符串是客户端通用协议常量，不是账户密码。

缓存与在线批量要分开：缓存可能只有上次使用的一条连接，`locations` 只是目录。在线模式先读取 `categories[].locations[]`，再按线路请求连接参数。

核心链路：

```text
持久化设备身份 → /registerUser 或 /userLogin
邮箱账号绑定   → /group/login
线路目录       → /vlcs
协议 X 参数    → /privateKey，选择 p=x
配置转换       → Mihomo / Xray / vless://
```

重要字段映射：

| 标准连接字段 | 来源 |
| --- | --- |
| 地址、端口、WebSocket path | `privateKey.host` 的实际拆分逻辑 |
| VLESS ID | `sessionToken.id`，不能误用 `user.id` |
| 非 UUID 的短 ID | 对照核心的 UUID v5 规则，不能随意补齐 |
| TLS、证书校验、传输 | 对照核心生成模板，明确与标准核心的差异 |
| 多路复用 | 客户端对应参数及目标核心支持情况 |
| 时效 | 会话或连接参数的有效期与真实服务端响应 |

已知请求签名根据客户端 appId 和每次请求的 reqId 计算，认证仍依赖有效 token。应从对应版本确认计算及取值范围；不要把公开签名算法误当成可绕过身份认证的手段。

## 账号与设备的差别

网页登录和客户端账号关联可能使用密码的 SHA-256，但设备登录使用独立的随机身份和密码。密码按原文计算一次，保留内部空格；散列值本身也必须私密保存。

已分析版本在初始化设备时生成随机 UUID。设备身份必须先持久化，再注册或绑定。注册成功但后续绑定失败时，重试应继续使用同一身份。

错误码需按实际响应判断。已见版本中的 `10001` 表示凭据被拒绝，`10006` 表示设备名额限制；遇到这些情况不能不停切换地址、注册新身份或删除其他设备。会话续期不会延长付费会员。

当前 API 地址可能来自配置和官方 `lvfile.v2` 发现文件，后者使用带认证的 AES-GCM 包装。验证发现文件后再更新备用地址，不把一次响应中的 IP 固化为长期入口。

在本仓库中，`providers/leapvpn/src/leapvpn/export.py` 是转换实现，同包的 `auth.py` 管理身份与续期，`refresh.py` 负责无人值守调用。安装 `providers/leapvpn/` 后使用 `python -m leapvpn.export` 或 `python -m leapvpn.refresh`；应用调用同一包，不复制算法。
