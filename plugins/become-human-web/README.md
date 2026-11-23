# Become Human · DSH Web / Desktop 插件

**0.7.0-beta.45 测试版，持续开发中。** Become Human 为 DSH 添加一个拥有持久人格、记忆和独立后台的数字人。每个 Human 只有一个持久主会话，可同时绑定一个 IM 渠道。扩展能够注册事件、行为、定时任务和管理页面。学习作为行为包按需启用。

本版适配官方 Windows DSH Desktop `0.2.2-rc.3`、`0.2.2-rc.5`，以及 DSH Web `0.2.0-rc.2`。工作观察能提示授权来源有新消息，生成与复核共用同一批有效摘录，提出协助前可以核对旧阻塞是否已有结果。[发行说明](https://github.com/liangTc/dsh-become-human/blob/v0.7.0-beta.45/docs/RELEASE_BETA45.md)

## 安装

**Desktop**：在左侧「插件 → 添加插件」中输入下载的 `.tgz` 的绝对路径，安装并启用，按提示重启。打开侧栏 Human，选择已有模型并完成人物设置。[下载安装包](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.45/dsh-become-human-web-0.7.0-beta.45.tgz)

**Web**：使用 Node.js 24 或更高版本，在要使用的 `web` profile 环境运行以下命令。

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add dsh-become-human-web@0.7.0-beta.45 --registry=https://registry.npmjs.org/
```

安装包包含管理插件和独立运行模块。Desktop 与 Web 分别保存会话和 IM 绑定。完全退出 Desktop 会停止其启动的后台，下次打开后恢复会话。[安装与升级](https://github.com/liangTc/dsh-become-human/blob/v0.7.0-beta.45/docs/INSTALLATION.md)

安装后启动 DSH，进入 Human，按“选择已有模型 → 人物与额度 → 创建并启动”完成首次设置。路径、私有 profile 和内部空闲端口自动准备，无需另装后台或手工编辑 YAML。模型凭据通过 DSH 的 apiKeyEnv 引用解析；向导不接收明文密钥。详见 [安装与升级](https://github.com/liangTc/dsh-become-human/blob/main/docs/INSTALLATION.md)。单独安装内部 runtime 不属于支持方式。

`beta.5` 测试包支持 `llm-pi-ai` 兼容路由和 DSH 原生 DeepSeek API Key 通道，模型列表会标明来源。尚不支持 DeepSeek 账号登录、内联密钥或任意 headers；选择和初始化不额外调用模型。新 DSH 未配置 API 时，先在宿主模型设置中完成，再回 Human 点击“重新检查”。

原生兼容已有本地构建、已有环境安装核对与服务恢复记录。10月28日开发候选在同机独立空目录、共享依赖缓存下完成官方模型发现、宿主凭据复用、后台启动与 Flash 真实请求；不追记为 beta.5 通过。最终发行包无缓存安装、干净机器和更多凭据组合仍待测，以测试状态为准。

首次自主行为默认关闭，可在创建前明确勾选；手机连接在创建后按需设置。已有安装保留会话、配置与绑定。后台继续由宿主 DSH 管理，重启后仍保持暂停；本次未增加后台常驻功能。

## 使用与配置

- Human → 对话：唯一主会话，Web 与手机共享。
- 任务看板：目标、子任务、定时事项、工具作业、报告与结果；摘要优先，支持单节点与本页全部展开，关注事项、自我状态和反思位于同一入口。
- 资料：查看、修订记忆与学习笔记，核对成长依据。
- 日志：行为时间线、事件日志、上下文与投递诊断，可关联任务、产物及记忆。
- 统计：近 24 小时与当前额度周期的 token、请求次数、工作类别和模型明细；读取账本不调用模型。
- 设置：人物、主人资料、额度、记忆、可选学习、Skills、扩展、IM 和工具连接；常用项优先，复杂项按需展开。人格偏移默认关闭，记忆整理可配置并支持批次恢复。

支持人物与额度预设或自定义配置。主人输入优先于后台工作；公开学习会保留来源，外部材料不自动成为已核实事实。写操作需要精确预览与逐笔审批，结果未知时不自动重试。

[使用指南](https://github.com/liangTc/dsh-become-human/blob/main/docs/USAGE.md) · [配置说明](https://github.com/liangTc/dsh-become-human/blob/main/docs/CONFIGURATION.md) · [架构](https://github.com/liangTc/dsh-become-human/blob/main/docs/ARCHITECTURE.md) · [GitHub 与插件集发布](https://github.com/liangTc/dsh-become-human/blob/main/docs/PLUGIN_SUBMISSION.md)

## 当前边界

- 需要本机持续开机和网络连接；不承诺无人值守 24 小时稳定送达。
- 一个 Human 只绑定一个有效 IM 渠道，切换渠道替换旧绑定。微信已有短时实测，其余实现不能等同于平台端到端通过。
- 公开发行不包含 WhatsApp/GPL 传递依赖；QQ 的非开源扫码连接器不随包安装，手动 AppID 配置保留。
- 内置 MCP 提供公开网页只读；beta.5 支持自行配置 stdio / Streamable HTTP MCP，发现工具后逐项授权，不自动安装服务。stdio 程序以当前系统账户运行，“只读”标签不构成系统沙盒。DSH 外部会话可授权指定范围或全部可见普通会话，写操作仍逐笔审批；开发版已移除浏览器标签页与窗口控制。各连接的真实流程仍按测试清单分别验收。
- Linux/macOS、任意 MCP 安装器、通用自主工具规划与 Codex 执行器尚未完成。
- 备份使用 Windows DPAPI，不能据此声称支持跨机器、跨账户恢复。

## 开发

从完整源码仓库构建，而非在已安装的插件目录内安装开发依赖：

```powershell
npm install --prefix plugins/become-human-web
npm run build --prefix plugins/become-human-web
npm run release:package
```

主构建重新生成 IM 与 Web/runtime 产物。日历规则有变动时执行 `npm run build:schedule --prefix plugins/become-human-web`，并保留第三方来源及许可证。

## 许可与引用

本项目原创部分采用 [Apache-2.0](LICENSE)。第三方部分保留其原许可：IM 适配基于 [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)，表达规则参考 [blader/humanizer](https://github.com/blader/humanizer)，日历规则复用 DeepSeek Harness schedule 的纯函数。

阅读 [NOTICE](NOTICE)、[第三方声明](THIRD_PARTY_NOTICES.md) 和 [IM 依赖许可](im/licenses/INDEX.md)。本项目由社区独立维护，不代表 DeepSeek 官方产品或已获插件集收录。

## 任务看板与认知记录

任务看板集中查看实际任务、目标步骤和执行结果，支持类型、状态、关键词与时间筛选。关注事项、自我状态、单一关注及有证据的规则反思收纳在同一入口。默认只展示状态与结果摘要，按需展开单条或本页全部节点，继续追溯事件和依据。主人和 Agent 使用同一主 Session 的持久记录；执行继续受原预算、静默、未回复退避和动作权限约束。参见[任务看板说明](https://github.com/liangTc/dsh-become-human/blob/main/docs/CHARACTER_BOARD.md)。已有部分学习产出、反思及手机实收闭环记录，不能据此认定所有主题、故障或长期流程均已通过。
