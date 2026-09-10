# LeapVPN 提取与续期

实现基于已分析的 LeapVPN 1.5.8 Windows 客户端。支持读取配置缓存、在线按线路获取协议 X 参数，以及使用持久化设备身份自动登录和续期。客户端升级后需重新核对字段、签名、加密与传输；版本名称本身不能证明兼容。

## 运行

```sh
python -m pip install -r leapvpn/requirements.txt

# 只读检查，显示脱敏摘要。
python -B leapvpn/export_leapvpn.py

# 使用已登录客户端的会话在线获取参数。
python -B leapvpn/export_leapvpn.py --fetch-all --out-dir exports/leap-first

# 使用自己保存的配置副本。
python -B leapvpn/export_leapvpn.py --settings private/appsettings.json --fetch-all --out-dir exports/leap-second
```

Windows 默认设置路径从 Program Files 位置推导。这个 `.json` 文件可能是 AES-GCM 二进制；不要直接当成明文解析。仅离线导出时通常只有当前缓存的一条连接，完整目录还需逐线路请求参数。输出目录必须不存在，脚本不会覆盖已有导出。

输出为 `leap_clash.yaml`、`leap_xray.json`、`leap_vless.txt` 和脱敏的 `leap_meta.json`。前三者包含真实连接凭据；导出目录自带忽略规则。

## 协议边界

- 协议 X：VLESS + WebSocket + TLS。Clash、Xray 和分享链接只是不同输出格式。
- 协议 W：带自定义传输扩展的 WireGuard 分支，标准核心兼容性尚需验证。
- `locations` 是线路目录，不足以生成全部连接。脚本为每条线路请求当前参数。
- VLESS ID 来自会话 ID，设备 `user.id` 不是同一字段。短 ID 按客户端的 UUID v5 规则转换。
- 当前导出保留原客户端的证书验证设置，包括 `skip-cert-verify`；启用证书验证前需检查实际入口证书和名称。

协议和加密依据见 skill 的 [客户端模式](../skills/extract-proxy-subscriptions/references/client-patterns.md)。

## 自动登录与续期

```sh
python -B leapvpn/refresh_leapvpn.py \
  --credentials private/leapvpn-account.json \
  --state private/device/session.json \
  --out-dir exports/leap-automatic
```

账号文件使用 `email` 与 `password` 或 `passwordSha256`。通过本地私有文件准备，密码中的空格必须保留；摘要本身也能用于登录，应按凭据保护。

首次运行会保存固定设备身份，再注册和关联账号，需要可用的设备名额。后续复用该身份，提前检查会话期限并在失效时做有边界的恢复。状态原子写入，失败不会反复生成设备；限流、设备上限、错误密码及异常账号不会无限重试。续期不延长会员期限。

`auth_leapvpn.py` 管理认证，`export_leapvpn.py` 管理参数转换，`refresh_leapvpn.py` 组合两者。VPS 调用同一实现。

## 可选会话同步

已有同步需求且已授权具体服务器时：

```sh
python -B leapvpn/sync_vps_session.py \
  --host root@host.example.com \
  --identity private/subscription-vps_ed25519 \
  --settings private/appsettings.json
```

必须明确传入 SSH 目标和 key。当前接收端要求 UID 0，调用不会自动执行 sudo；使用已授权的 root SSH 身份。接收端是 Linux 上的 `receive_vps_session.py`，从服务配置读取自己的域名，不绑定某个开发者的主机。

默认同步不携带设备密码，也不允许静默替换另一设备身份；显式 `--auto-login` 才同步指定客户端的设备凭据。采用独立 VPS 设备自动续期时，日常无需桌面同步。

## 测试

```sh
python -B -m unittest discover -s leapvpn -p 'test_*.py'
```

测试涵盖加密认证、ID 转换、字段对应、摘要脱敏、逐线路请求、续期状态、并发锁、错误停止及同步边界。实际线路可用性与第三方客户端导入需要单独验收。
