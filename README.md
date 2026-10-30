<p align="center">
  <img src="docs/assets/banner-pixel.png" alt="Become Human 像素风横幅：在 DSH 中构建拥有统一人格与记忆的自主 Agent" width="100%">
</p>

# Become Human

**一个会记住、学习、主动交流与推进目标的 DSH 单会话 Agent。**

[English](README.en.md) · [安装](docs/INSTALLATION.md) · [使用](docs/USAGE.md) · [配置](docs/CONFIGURATION.md) · [测试状态](docs/TESTING_STATUS.md) · [架构](docs/ARCHITECTURE.md)

> [!WARNING]
> **测试版本 · 尚未开发完成。** 当前公开测试发行是 `0.7.0-beta.5`（GitHub Prerelease）。依赖 Windows、Node.js 24+ 与 DSH `0.2.0-rc.2`。完整验收与长期稳定性尚未完成，原生 DeepSeek 全新安装整链仍待测试，具体边界见[测试状态](docs/TESTING_STATUS.md)。

`main` 当前为 **`0.7.0-beta.11` 开发源码**，尚无对应的公开 Release 安装包；下方 beta.5 下载不包含后续开发版本的新增能力。

| 版本 | 获取方式与状态 |
| --- | --- |
| `0.7.0-beta.11` | 已公开开发源码；本地已有构建、升级及有限真实模型短测，需要自行构建，尚未发布安装包 |
| `0.7.0-beta.5` | 当前公开测试发行，提供预构建组合包及 SHA-256；见下方安装步骤 |
| `0.7.0-beta.4` | 历史测试发行；旧包不包含 beta.5 新增能力 |

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
| 工具扩展 | 统一能力接口、内置只读 MCP；beta.5 可自行配置 MCP 与授权读取或使用宿主可见 DSH 会话 |
| 可追溯运行 | 活动时间线与事件日志，关联任务、产物和记忆变化 |
| 任务看板 · beta.5 | 汇总目标、子任务、定时任务与结果；默认摘要，可展开单个节点或本页全部节点；包含关注事项、自我状态与反思 |
| 用量统计 · beta.5 | 近 24 小时和当前额度周期的 token、模型请求、工作分类、小时趋势与模型明细 |
| 人格与记忆维护 · beta.5 | 可选的人格偏移、依据与撤回；定期记忆整理、冷热分层、来源关联与批次恢复 |
| 模型接入 · beta.5 | 兼容 DSH 原生 DeepSeek API Key 适配器与第三方路由，复用宿主凭据引用 |
| 连贯上下文 · 开发版 | 完整问答轮次、可追溯滚动摘要、待压缩原文与长期记忆共同衔接；可查看覆盖范围与压缩开销 |
| 图片与自主选择 · 开发版 | 支持视觉的模型可接收图片；人物可同意、协商、拒绝或重新考虑普通请求，关系指标不扩大操作权限 |
| 学习与工作协助 · 开发版 | 学习动机、自然引子与追问、有效笔记读取、授权 DSH 会话观察；保存前检查逐字引文及当前任务范围 |

DSH 会话写入默认关闭，需配置目标范围并逐笔审批；取消操作绑定读取结果中的具体轮次，任务已切换时拒绝旧操作。Human 不提供浏览器标签页或窗口控制。文本 Skill 可自行添加，但不授予任意代码执行或系统权限。

[任务看板中的关注与反思](docs/CHARACTER_BOARD.md)沿用原唯一会话、IM 绑定与执行通道。手动关注不会启动驱动，目标或承诺入卡不等于执行，采纳反思不扩大权限；不展示原始内部推理，也不证明意识。表中标为 beta.5 的新增能力随本次测试包交付，仍需按测试清单分别验收。

### beta.11 开发进展

近期开发集中在三个方向：

- **对话与分享：** 完整问答和滚动摘要衔接上下文；自然追问可读取当前有效笔记。回复增加串行校验，减少无依据的自身经历和催答，最多修正一次。聊天、压缩及回复校验单独记账，不占自主额度池。
- **学习质量：** 按句子编号、逐字圈选原文，保存前由同一执行线检查实际引文是否符合当前问题和目标范围；被拒绝的候选不写入笔记或知识记忆。审查会消耗额外自主请求和 token，模型接受不代表来源或结论已独立核实。
- **任务与恢复：** 补齐目标取消、导出并发清理和崩溃恢复检查，撤回学习依据后核对关联目标；日志保留原始失败，不自动重试未知结果。

beta.11 最近一轮有144项隔离检查、有限真实模型与 Web 页面短测，仍发现过范围审查误接受，相关测试笔记已撤回。摘录结尾完整性、多主题语义质量、公开搜索与连接超时仍待完善；新审查阶段的实际额度等待及抢占恢复、干净机器、手机图片和长期运行仍待验收。详见[变更记录](CHANGELOG.md)、[学习与日常交流](docs/LEARNING_AND_CONVERSATION.md)和[测试记录](docs/TESTING_STATUS.md)。

## 运行方式

<img src="docs/assets/architecture-pixel.svg" alt="像素风架构：DSH Web 与 IM 连接管理插件，管理插件连接独立 Human 运行模块与统一能力接口" width="100%">

管理插件嵌入 DSH Web，独立运行模块承载 Human 的循环和数据。外层 bundle 不替换普通 DSH 的 Agent 工厂。内部私有 profile 有自己的工具与持久化边界；**不要将内部运行包单独安装到日常 profile**。

### 唯一会话与单渠道

- 一个 Human 只有一个持久主会话；临时任务上下文不形成第二个人格或聊天入口。
- Web 与手机共享消息、记忆与任务，主人输入优先于后台工作。
- **一个 Human 同时只绑定一个有效 IM 渠道，更换渠道会替换旧绑定。**
- 外部 DSH 会话是经授权的资料或执行目标，不是 Human 的另一个主会话。

## 快速开始

推荐使用 [v0.7.0-beta.5 测试发行](https://github.com/liangTc/dsh-become-human/releases/tag/v0.7.0-beta.5) 的预构建组合包，一次安装 Web 插件和后台代码：

1. 下载 [安装包 `.tgz`](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.5/dsh-become-human-web-0.7.0-beta.5.tgz) 和 [SHA-256 校验文件](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.5/dsh-become-human-web-0.7.0-beta.5.tgz.sha256)。
2. 按 [安装指南](docs/INSTALLATION.md#使用预构建包推荐) 核对校验值，在下载目录安装到已有的 DSH Web profile：

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ./dsh-become-human-web-0.7.0-beta.5.tgz
```

npm 包尚未发布。Git 仓库和 GitHub 的源码 ZIP 不包含全部预构建产物，不能直接当作可安装组合包；开发者可按 [从源码构建](docs/INSTALLATION.md#从源码构建) 生成 `.tgz`。

**beta.5 已知新装问题：** 首次创建 Human 可能因初始化顺序失败；修复已纳入 beta.6 开发源码，尚未提供新的公开 Release 包。首次安装请先阅读[测试状态](docs/TESTING_STATUS.md)，已有安装升级的短测不能证明干净安装已通过。

安装后启动 DSH，打开 Human，按 **选择已有模型 → 人物与额度 → 创建并启动** 完成向导。路径、内部 profile 和空闲回环端口自动准备，无需另装后台或手工填写 YAML。`beta.5` 支持 `llm-pi-ai` 路由及 DSH 原生 DeepSeek API Key 通道。两者通过 `apiKeyEnv` 引用解析凭据，不回传密钥；尚不支持 DeepSeek 账号登录、内联密钥或任意 headers。具体支持范围见 [模型配置](docs/CONFIGURATION.md#进程与模型配置)。

**原生通道验证边界：** 公开 beta.5 保留其原发行验收范围。10月28日的 beta.6 开发候选已在同机独立空目录完成真实官方模型发现、宿主进程凭据复用、后台启动与 Flash 请求；使用共享依赖缓存，不代表干净机器通过，也不追记为 beta.5 已验收。最终发行包无缓存安装、更多凭据优先级组合与推理档位统一列入[合并待测清单 D1/D2](docs/TESTING_STATUS.md#merged-testing)。

首次可选人物预设、低中高额度、主人称呼与时区；“同时开启自主学习和主动交流”默认关闭。创建后再按需连接手机、丰富人物资料。已有安装保留原会话、配置和绑定，后续冷启动仍需明确恢复。后台继续随 DSH 服务运行；本次未增加后台常驻模式。更多说明见 [配置](docs/CONFIGURATION.md) 与 [使用](docs/USAGE.md)。

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
| [关注事项与反思](docs/CHARACTER_BOARD.md) | 任务看板中的共用事项、自我状态、注意力与规则反思 |
| [测试状态与待测试清单](docs/TESTING_STATUS.md) | 已验证范围、推迟项目与后续验收顺序 |
| [架构](docs/ARCHITECTURE.md) | 主会话、独立模块、上下文、能力与源码结构 |
| [发行与社区登记](docs/PLUGIN_SUBMISSION.md) | GitHub Release、Plugin Radar 登记与自定义市场边界 |
| [贡献指南](CONTRIBUTING.md) | 开发边界、改动与反馈 |
| [安全说明](SECURITY.md) | 数据边界与漏洞报告 |
| [变更记录](CHANGELOG.md) | 公开版本变化 |

本项目按 Agent 能力方向向社区 [DSH Plugin Radar 登记表](https://github.com/AdamPlatin123/dsh-plugin-radar/blob/main/PLUGINS.md) 的单插件分类提交登记；上游合并前不声称已收录。社区登记、独立运行级审核与 DSH 自定义市场索引是不同流程，均不代表官方背书。详见 [提交流程](docs/PLUGIN_SUBMISSION.md) 与 [DSH 官方市场指南](https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market)。

## 致谢与许可

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：插件宿主、模型、会话服务及纯日历规则。
- [dsh-im](https://github.com/xmanrui/dsh-im)：IM 渠道与配置实现的主要上游。
- [Humanizer](https://github.com/blader/humanizer)：表达指导及中文对话适配的参考。

原创代码与文档采用 **[Apache License 2.0](LICENSE)**。第三方代码、Skill、图标及依赖保留各自许可，见 [NOTICE](NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目独立维护，上游名称和商标仅用于说明兼容性与来源。
