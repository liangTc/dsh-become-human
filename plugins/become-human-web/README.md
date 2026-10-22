# Become Human · DSH Web 插件

> **0.7.0-beta.4 · 测试版本，尚未开发完成。** 当前面向 Windows、Node.js 24+、DeepSeek Harness 0.2.0-rc.2 的 web profile。长期运行与全部渠道尚未完成实测验收。

为 DSH Web 增加一个拥有统一人格、记忆、学习与主动行为的 Human。管理插件嵌入 Web，独立运行模块处理事件循环；一个 Human 只有一个持久主会话，同时只绑定一个有效 IM 渠道。

## 安装

使用预构建 `.tgz`，一次安装 Web 插件及其后台代码。当前公开 Release 安装附件与 npm 包尚未发布，可使用维护者提供或自行构建的包：

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ./dsh-become-human-web-0.7.0-beta.4.tgz
```

安装后启动 DSH，进入 Human，按“选择已有模型 → 人物与额度 → 创建并启动”完成首次设置。路径、私有 profile 和内部空闲端口自动准备，无需另装后台或手工编辑 YAML。模型凭据通过 DSH 的 apiKeyEnv 引用解析；向导不接收明文密钥。详见 [安装与升级](docs/INSTALLATION.md)。单独安装内部 runtime 不属于支持方式。

首次自主行为默认关闭，可在创建前明确勾选；手机连接在创建后按需设置。已有安装保留会话、配置与绑定。后台继续由宿主 DSH 管理，重启后仍保持暂停；本次未增加后台常驻功能。

## 使用与配置

- Human → 对话：唯一主会话，Web 与手机共享。
- 活动：大脑时间线和事件日志，可关联任务及记忆。
- 任务：目标、定时事项、报告文件、工具与能力。
- 设置：人物、主人资料、记忆、学习、额度、Skills、IM 和工具连接。

支持人物与额度预设或自定义配置。主人输入优先于后台工作；公开学习会保留来源，外部材料不自动成为已核实事实。写操作需要精确预览与逐笔审批，结果未知时不自动重试。

[使用指南](docs/USAGE.md) · [配置说明](docs/CONFIGURATION.md) · [架构](docs/ARCHITECTURE.md) · [GitHub 与插件集发布](docs/PLUGIN_SUBMISSION.md)

## 当前边界

- 需要本机持续开机和网络连接；不承诺无人值守 24 小时稳定送达。
- 一个 Human 只绑定一个有效 IM 渠道，切换渠道替换旧绑定。微信已有短时实测，其余实现不能等同于平台端到端通过。
- 公开发行不包含 WhatsApp/GPL 传递依赖；QQ 的非开源扫码连接器不随包安装，手动 AppID 配置保留。
- 内置 MCP 仅提供公开网页只读；DSH 外部会话及浏览器访问默认关闭，需明确授权资源。真实非空会话读取与浏览器操作仍需后续验收。
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
