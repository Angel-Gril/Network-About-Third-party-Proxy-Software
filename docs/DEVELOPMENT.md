# 开发与验证

运行环境为 Node.js 22+、Python 3.10+；飞鸟本地导出还需要 Windows PowerShell 5.1 或 PowerShell 7。VPS 的 systemd 与 Nginx 部分面向 Linux。

## 本地检查

```sh
npm ci
npm ci --prefix vps-service
python -m pip install -r requirements-dev.txt
npm test
npm run test:vps
npm run check
python -B -m unittest discover -s leapvpn -p 'test_*.py'
python -B -m unittest discover -s tests -p 'test_*.py'
python scripts/check_public_files.py
python scripts/check_skill.py
```

Node.js 两个目录分别保留自己的 package 和 lockfile。不要依赖原开发机器上相邻目录的依赖包。Python 的测试依赖统一由 `requirements-dev.txt` 引用。

CI 在 Windows 和 Linux 上运行合成数据测试、源码语法检查、公开内容检查及 skill 校验。Windows 额外解析 PowerShell 脚本。发布的 skill ZIP 由同一 CI 打包，不能把本地运行数据放进包里。

## 测试边界

普通测试禁止访问真实客户端设置、读取账号文件、注册设备或调用机场 API。外部接口通过最低必要边界的测试替身表示，密码、UUID 和主机名都是合成值。

真实验收另行进行，并记录输入文件哈希、核心版本、选用出口、命中规则和网络环境：

1. 确认当前目录和作用于该任务的授权。
2. 校验配置能解析，参数与原始导出一致，入口域名具有真实 DNS 结果。
3. 用独立代理核心和临时端口检查实际转发与规则命中。避免第二个核心被现有 TUN 再次接管。
4. 分别报告订阅下载、DNS、协议连接、HTTP 转发和规则命中；不能用其中一项代替其他项。
5. 已授权部署时，先备份和预发布，检查正式缓存、原订阅链接、拒绝路径与定时任务。

真实验收文件写到忽略的 `exports/`、`private/` 或明确的私有目录。公开提交只保留脱敏结论。

## 公开发布

首次导入或打包采用明确的文件清单，检查原配置中的个人域名、服务器 IP、账号字段和本机绝对路径。公开示例使用 `example.com`、`.example` 及文档网段。

```sh
git diff --check
python scripts/check_public_files.py --staged
git diff --cached --stat
git diff --cached
```

公开内容检查是针对常见泄露形式的补充，仍须人工检查真实配置和文档。发现敏感内容时修正当前候选；已发布秘密需另行处理凭据和历史，不能靠新增 `.gitignore` 消除泄露。

skill 以 `skills/extract-proxy-subscriptions/` 为唯一源码。安装时复制或链接整个目录；修改后校验引用、检查使用场景，并重新打包。重要协议判断应保留样本版本和证据边界。

## 当前范围

本仓库发布已有提取器、可选 Worker、VPS 分发服务和方法 skill，不包含软件厂商安装包、用户订阅或线上系统配置。用户需自行提供有效账户或已登录会话。协议 W 的第三方兼容性及所有出口持续可用性均不能从本仓库测试推导。
