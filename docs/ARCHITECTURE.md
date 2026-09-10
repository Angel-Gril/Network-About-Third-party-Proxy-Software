# 目录与模块边界

仓库按提供者实现、可部署应用和开发工具划分。两家提取器平级，源码、测试、模板各有固定位置。

```text
providers/
  flybird/                 飞鸟：JavaScript 订阅模块与 Windows 本地导出
    src/                   运行代码
    tests/                 该提供者的测试
    templates/             本地 Mihomo 模板
  leapvpn/                 飞跃：可安装的 Python 包
    src/leapvpn/           export、auth、refresh、sync、receive
    tests/                 该提供者的测试
    pyproject.toml         包元数据和运行依赖
apps/
  cloudflare-worker/       Cloudflare 入口和 Wrangler 配置
  subscription-server/     Node 服务、管理页及服务器部署模板
    src/
    tests/
    public/
    templates/
    deploy/nginx/
    deploy/systemd/
scripts/                   仓库检查、测试调度和 skill 打包
tests/                     仓库工具测试
skills/                    可独立安装的 Agent skill
docs/                      架构、开发和迁移说明
```

## 依赖方向

- `@proxy-toolkit/flybird` 是飞鸟 JavaScript 实现的唯一 npm 包；本地 PowerShell 实现在同一提供者目录中。
- Worker 应用只提供部署入口，导入飞鸟包，不复制它的代码。
- 订阅服务导入同一飞鸟包，调用飞跃导出器，并负责验证、缓存和读取 token。它不再按文件路径导入另一个应用。
- `leapvpn` 使用标准 Python src 布局，通过 pip 安装后以 `python -m leapvpn.export` 等模块入口运行。
- skill 总结分析和验证方法，不持有另一份提取算法。

## 路径约定

源码与模板路径相对于所属模块定位。用户显式指定的文件路径相对于调用目录；飞鸟默认输出统一放到仓库 `exports/flybird/`。安装后的飞跃模块可从其他目录调用。

JavaScript 使用 npm workspaces 和根目录唯一的 `package-lock.json`；Python 运行依赖由提供者的 `pyproject.toml` 维护。根目录开发依赖引用该包。

## 本次迁移边界

目录迁移保留协议转换、会话续期、缓存失败保护与 token 隔离行为。验收包括已有回归、跨目录入口、实际 Worker 与 Python wheel 打包、完整文档链接和 Windows/Linux CI。仓库调整不会自动修改现有 VPS；部署目录和环境变量的对应关系见 [迁移说明](MIGRATION.md)。
