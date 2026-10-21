<p align="center">
  <img src="docs/assets/banner-pixel.png" alt="Become Human 像素风横幅：在 DSH 中构建拥有统一人格与记忆的自主 Agent" width="100%">
</p>

# Become Human

**一个会记住、学习、主动交流与推进目标的 DSH 单会话 Agent。**

[English](README.en.md) · [安装](docs/INSTALLATION.md) · [使用](docs/USAGE.md) · [配置](docs/CONFIGURATION.md) · [架构](docs/ARCHITECTURE.md)

> [!WARNING]
> **测试版本 · 尚未开发完成。** 当前公开版目标为 `0.7.0-beta.1`，依赖 Windows、Node.js 24+ 与 DSH `0.2.0-rc.2`。请使用独立数据目录尝试。长期稳定性、部分渠道、浏览器与外部会话的完整流程仍需继续验证；不要直接用于关键业务。

## 它想解决什么

普通聊天通常需要你先开口。Become Human 在保留一个持久主会话的前提下，加入事件循环：在合适的时候，根据**当前人物配置 → 有效记忆、反馈与目标 → 模型选题**，决定等待、学习、关心、交流或推进一项有限任务。

Web 是统一管理入口，手机是同一会话的另一条通道。人格影响交流与选题，代码负责调度、额度、执行边界与记录。项目探索的是持续、有上下文的 Agent 行为；不声称模型拥有真人意识、真实情绪或已经实现长期人格进化。

## 能做什么

<img src="docs/assets/capabilities-pixel.svg" alt="像素风能力概览：人格、记忆、主动行为、目标、手机通道与工具" width="100%">

| 能力 | 当前实现 |
| --- | --- |
| 统一人格 | 人物、关系、兴趣与长期方向；预设或自定义 JSON |
| 分层记忆 | 有来源的记忆、事件概览与学习笔记；可查看、修订与遗忘 |
| 自主循环 | 定时检查与事件触发；轻量选题、有限执行、等待与检查点 |
| 自然交流 | 连续输入合并、短回复、分条；主动闲聊与未回复退避 |
| 目标与定时任务 | 多步目标、一次性提醒、周期任务及状态追踪 |
| 行动与产物 | 报告内容预览、精确审批、受管文件写入与回执 |
| 手机通道 | Web 与 IM 共享一个主会话；本人配对与统一投递 |
| 工具扩展 | 统一能力接口、内置只读 MCP、按范围读取 DSH 会话 |
| 可追溯运行 | 活动时间线与事件日志、用量、任务、记忆变化的关联 |

浏览器标签页控制与 DSH 会话写入已有接入代码，默认关闭并按操作审批，真实使用前需要单独配置和验证。文本 Skill 可自行添加，但不授予任意代码执行或系统权限。

## 运行方式

<img src="docs/assets/architecture-pixel.svg" alt="像素风架构：DSH Web 与 IM 连接管理插件，管理插件连接独立 Human 运行模块与统一能力接口" width="100%">

管理插件嵌入 DSH Web，独立运行模块承载 Human 的循环和数据。外层 bundle 不替换普通 DSH 的 Agent 工厂。内部私有 profile 有自己的工具与持久化边界；**不要将内部运行包单独安装到日常 profile**。

### 唯一会话与单渠道

- 一个 Human 只有一个持久主会话；临时任务上下文不形成第二个人格或聊天入口。
- Web 与手机共享消息、记忆与任务，主人输入优先于后台工作。
- **一个 Human 同时只绑定一个有效 IM 渠道，更换渠道会替换旧绑定。**
- 外部 DSH 会话是经授权的资料或执行目标，不是 Human 的另一个主会话。

## 快速开始

本仓库尚不能据此认定已发布 npm 包或被插件集收录。使用本地构建的 `.tgz` 安装，完整前置条件和首次配置见 [安装指南](docs/INSTALLATION.md)。

在仓库根目录：

```powershell
npm install --prefix plugins/become-human-web
npm run build --prefix plugins/become-human-web
npm run release:package
```

根据命令输出找到 `.tgz`，再安装到已有的 DSH Web profile：

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add <安装包的实际路径.tgz>
```

安装后，先在 `$DSH_HOME/profiles/web/cordis.patch.yml` 设置 `become-human-manager` 的 `sourceHome`、`runtimeHome`、`provider` 与 `model`，再启动 DSH。源模型目前需要 `llm-pi-ai` 路由和 `apiKeyEnv` 凭据引用；不能把任意现有 DSH 模型配置都视为可直接迁入。

首次进入 Human 后，完成 **人格与关系 → 自主行为与额度 → 手机连接（可选）**。冷启动保持暂停，核对设置后手动开始。更多说明见 [配置](docs/CONFIGURATION.md) 与 [使用](docs/USAGE.md)。

## IM 适配范围

开源发行保留 **12 种聊天渠道实现与 1 个 Office 连接器**：

微信、飞书、钉钉、企业微信、企业微信应用、QQ、Slack、Telegram、Discord、iMessage、邮箱、Matrix；另有 AI Office 连接器。

**有适配实现不等于全部完成真实验收。** 微信已有实机流程验证，其他渠道受平台账户、网络、权限与当前运行平台限制。iMessage 需要 macOS，而本版完整 Human 运行时依赖 Windows，尚不能在本版中即装即用。

为保证开源发行的授权边界，本版不包含 WhatsApp 适配及其 GPL 依赖链，不包含 QQ 的未授予开源分发许可的扫码连接器；QQ 使用手动 AppID / AppSecret 配置。渠道改造参考并派生自 [dsh-im](https://github.com/xmanrui/dsh-im)，详情见 [第三方说明](THIRD_PARTY_NOTICES.md)。

## 额度与运行注意

- 自主行为可按 token、模型请求、轮次和单轮时限约束；主人主动聊天使用独立计量，仍会产生供应商费用。
- 本地准入量是保守估算，不是供应商的硬消费上限。离线、休眠、进程退出、模型限流和渠道会话失效都会影响可用性。
- 公开搜索可能无结果或证据不足；任务有计划不等于已有成果，投递回执也不等于手机实际收到。
- 写操作需要核对预览。结果为 `unknown` 时先检查外部实际状态，不自动重试，避免重复操作。
- 数据保存在本地，但模型、搜索和 IM 会向所选服务发送必要内容。认证链接、凭据、数据库和聊天记录不要公开。
- 当前密钥保护和离线备份依赖 Windows DPAPI；加密备份不是跨机器一键迁移方案。

## 当前边界

公开版仍是测试版本。持续运行、多日人格反馈、干净安装、多插件共存、各渠道与外部操作的完整验收尚未全部完成。当前通用能力支持手动和前台有限调用，自主选题器尚未具备对任意工具的通用规划；任意 MCP 服务器安装器、Codex 执行器和原生桌面窗口控制也未提供。

“在线”表示进程运行时具备响应与自主检查能力，不是 24 小时稳定性承诺。活动时间线展示行为摘要和证据，不展示模型完整私有思维过程。已知限制见 [架构边界](docs/ARCHITECTURE.md#当前交付边界)。

## 文档与参与

| 文档 | 内容 |
| --- | --- |
| [安装与升级](docs/INSTALLATION.md) | 构建、`.tgz` 安装、首次配置、常见错误 |
| [配置说明](docs/CONFIGURATION.md) | 人物、额度、模型、Skill、手机与工具范围 |
| [使用指南](docs/USAGE.md) | 对话、主动行为、目标、提醒、学习和手机命令 |
| [架构](docs/ARCHITECTURE.md) | 主会话、独立模块、上下文、能力与源码结构 |
| [插件集接入](docs/PLUGIN_SUBMISSION.md) | GitHub Release、npm 与 DSH 自定义市场索引 |
| [贡献指南](CONTRIBUTING.md) | 开发边界、改动与反馈 |
| [安全说明](SECURITY.md) | 数据边界与漏洞报告 |
| [变更记录](CHANGELOG.md) | 公开版本变化 |

DSH 当前提供实验性的自定义插件市场索引。准备好 bundle 或给仓库添加 `dsh-plugin` topic，不代表获得官方收录；发布方式见 [DSH 官方市场指南](https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market)。

## 致谢与许可

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：插件宿主、模型、会话服务及纯日历规则。
- [dsh-im](https://github.com/xmanrui/dsh-im)：IM 渠道与配置实现的主要上游。
- [Humanizer](https://github.com/blader/humanizer)：表达指导及中文对话适配的参考。

原创代码与文档采用 **[Apache License 2.0](LICENSE)**。第三方代码、Skill、图标及依赖保留各自许可，见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目独立维护，上游名称和商标仅用于说明兼容性与来源。
