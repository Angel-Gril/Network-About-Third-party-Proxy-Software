# 开发与验证

需要 Node.js 22+、Python 3.10+。飞鸟本地导出需要 Windows PowerShell 5.1 或 PowerShell 7；Nginx 和 systemd 检查面向 Linux。代码归属见 [架构说明](ARCHITECTURE.md)，修改约定见 [AGENTS.md](../AGENTS.md)。

## 准备环境

从仓库根目录执行。Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
npm ci --ignore-scripts
python -m pip install -r requirements-dev.txt
```

Linux/macOS：

```sh
python3 -m venv .venv
. .venv/bin/activate
npm ci --ignore-scripts
python -m pip install -r requirements-dev.txt
```

npm 只在根目录安装一次。飞跃以 editable 模式安装到虚拟环境；从其他工作目录也可运行 `python -m leapvpn.export`。不要依赖原开发机器相邻目录的依赖包或登录文件。

## 统一检查

```sh
npm run verify
npm run skill:pack
npm audit --audit-level=high
```

`verify` 依次运行所有 workspace Node 测试、四组 Python 测试、源码语法与公开内容/skill/文档链接检查，以及 Worker dry-run 和飞跃 Python wheel 打包。它不会发布 Worker，也不会部署 VPS。生成物位于忽略的 `dist/`；Python 打包可单独运行 `npm run build:python`。

按改动范围运行聚焦检查：

| 范围 | 命令 |
| --- | --- |
| 飞鸟 JavaScript | `npm test --workspace @proxy-toolkit/flybird` |
| Worker 应用入口 | `npm test --workspace @proxy-toolkit/cloudflare-worker` |
| 订阅服务 | `npm test --workspace @proxy-toolkit/subscription-server` |
| 发布文件与证据校验 | `node --test apps/subscription-server/tests/release-verification.test.mjs` |
| 飞鸟本地导出 | `python -B scripts/test_python.py --suite flybird` |
| 飞跃 Python 包 | `python -B scripts/test_python.py --suite leapvpn` |
| MonoCloud JavaScript | `npm test --workspace @proxy-toolkit/monocloud` |
| 服务部署工具 | `python -B scripts/test_python.py --suite server` |
| 仓库工具 | `python -B scripts/test_python.py --suite tooling` |
| 文档链接 | `python scripts/check_docs.py` |

没有 PowerShell 的环境会跳过飞鸟 PowerShell 测试；这不等于验证了该运行时。CI 的 Windows 作业负责 Windows PowerShell 与 PowerShell 7 路径，Linux 作业执行可用的 PowerShell 7 测试。

## CI 与依赖

[CI](../.github/workflows/ci.yml) 在 Windows、Linux 使用标准 checkout，运行 Node 22、Python 3.12 的完整检查。Linux 额外启动临时 Nginx，验证模板语法及含读取 token 的 URI 不进入访问/错误日志；同一作业生成 skill ZIP。

JavaScript 的 workspace 清单各自维护包入口与依赖，根 `package-lock.json` 是唯一锁文件。Python 运行依赖只在 [飞跃 pyproject.toml](../providers/leapvpn/pyproject.toml) 中维护，根 `requirements-dev.txt` 引用该包并添加测试依赖。

更新依赖后重新安装、检查 audit、执行受影响测试和真实构建。Wrangler 的 Miniflare 传递依赖暂将 `sharp` 固定到 0.35.4，以避开 [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)；上游升级到修复版后再移除 override，并重跑 build。

## 测试与现场验收

普通测试使用合成响应、临时目录及最小外部接口替身，不读取真实客户端会话，不注册设备，也不改变系统代理。服务刷新测试调用真实共享分流代码，并分别验证自动登录与已有会话两种 Python 模块入口。

真实验收另行记录输入哈希、核心版本、选用出口、命中规则和网络环境：

1. 校验配置解析、字段一致性和真实 DNS，识别 Fake-IP。
2. 用独立核心、临时端口验证协议握手、HTTP 转发和规则命中，避免第二个核心被现有 TUN 再次接管。
3. 分别报告订阅下载、DNS、连接、转发和规则匹配；一个出口成功不能推导全部线路可用。
4. 对已授权的部署，先备份和预发布，再检查正式缓存、原链接、拒绝路径及定时任务。

使用 [订阅服务的验收工具](../apps/subscription-server/README.md#绑定配置与实际测试记录) 将候选、最终 HTTPS 响应、同期源站响应与真实规则测试记录绑定。它检查文件和证据的一致性；网络验证、服务状态与实际业务可用性仍分别记录。上游内容变化后使用新快照重新测试，保留原始失败记录。

验收文件写到忽略的 `exports/`、`private/` 或明确的私有目录。公开提交仅保留脱敏结论。具体方法见 [验证与维护](../skills/extract-proxy-subscriptions/references/validation-and-maintenance.md)。

## 提交与维护

路径变化必须同时更新入口、包配置、相邻测试、README、CI 和迁移说明。提供者测试放在提供者目录，应用测试放在应用目录；根 `tests/` 只放仓库工具测试。

按明确路径暂存后检查：

```sh
git diff --check
python scripts/check_public_files.py --staged
git diff --cached --stat
git diff --cached
```

公开内容检查仅辅助发现常见泄露形式，仍需检查示例、文档和配置。账号、密码摘要、设备密码、完整订阅 URL、节点凭据、导出物和私有部署记录不进入提交。

skill 的唯一源码在 `skills/extract-proxy-subscriptions/`。修改后检查引用与行为场景，再由 `npm run skill:pack` 打包；不要在安装目录维护另一份实现。安装包不包含用户数据或厂商二进制。
