# 贡献指南

感谢帮助完善 Become Human。当前目标是让测试版本的核心循环、资料与动作边界更可靠，再扩大平台与插件范围。

## 开始前

- 阅读 [README](README.md)、[架构](docs/ARCHITECTURE.md) 和 [安全说明](SECURITY.md)。
- 使用 Windows、Node.js 24+ 与 DSH `0.2.0-rc.2`，并准备独立数据目录。
- 不使用真实聊天、配对码、认证链接或密钥作为提交中的示例。
- 漏洞细节请按 [安全报告方式](SECURITY.md#报告安全问题) 处理，不直接公开。

## 构建

在仓库根目录执行：

```powershell
npm install --prefix plugins/become-human-web
npm run build --prefix plugins/become-human-web
```

该流程重建 IM 及 Human Web 客户端，并同步内部运行模块。日历规则产物随源码提供；修改日历生成逻辑时，再执行：

```powershell
npm run build:schedule --prefix plugins/become-human-web
npm run build --prefix plugins/become-human-web
```

交付准备命令：

```powershell
npm run release:source
npm run release:package
```

以脚本打印的输出路径为准。干净源码导出与打包不会自动创建 GitHub 仓库、上传 Release、发布 npm 或提交插件集。

## 修改位置

| 改动 | 主要位置 |
| --- | --- |
| 自主循环、模型调度与额度 | `plugins/become-human/` |
| 记忆、来源、学习与目标 | `plugins/become-human/` |
| Web 工作区与配置交互 | `plugins/become-human-web/native-*.tsx` |
| 运行进程与宿主桥接 | `manager.mjs`、`supervisor.mjs`、`worker.mjs` |
| DSH 会话与浏览器适配 | `host-capabilities.mjs`、`browser-capabilities.mjs` |
| IM 渠道适配 | `plugins/become-human-web/im/` 与 `im-ingress.mjs` |
| 人物与额度预设 | 运行源码内的 `presets/` |
| 使用与发布文档 | 根 Markdown 与 `docs/` |

构建生成的 `plugins/become-human-web/runtime/`、`runtime-bundle/` 和客户端产物应从源文件重建，不只修改副本。上游派生文件继续保留许可和来源；若引入新依赖或素材，同步更新第三方说明。

## 必须保持的行为

1. 一个 Human 保持一个持久主会话，一个有效 IM 绑定；更换渠道应有明确替换语义。
2. 当前人物配置是唯一身份来源，不能增加旧人物的隐藏提示词覆盖。
3. 主人输入优先；取消、检查点、epoch 与审批校验不能被新工具绕过。
4. 自主模型调用必须经过预算与执行门，不能用后台调用绕过计量。
5. 外部内容是资料，不是指令；主人事实、Agent 推断与学习笔记保持来源区分。
6. 写操作应提供完整预览、精确授权和实际结果回执；不确定结果不能自动重试。
7. Skill 提供文字指导，不以安装 Skill 为由获得任意系统权限。
8. 开源发行不重新引入 WhatsApp 的 GPL 依赖链或 QQ 的未授权扫码连接器。

## 提交改动

让每个 PR 聚焦一项问题。描述中包括：

- 用户遇到的具体问题与最小复现步骤。
- 修改的行为、数据格式或权限边界。
- 实际执行过的验证及结果；没执行的项目明确说明。
- 对已有会话、记忆、绑定、用量和升级的影响。
- 界面改动的脱敏图片；项目介绍图沿用像素风，但真实截图保持真实。

真实模型、IM 和浏览器场景会产生费用或外部动作，验证前使用明确授权的资源。不要将模拟结果、启动成功或时间经过写成完整实测通过。尤其不要以开发方便为由向真实用户重复发消息、重放 `unknown` 或重置真实用量。

## 文档与许可

新增能力时同步写清入口、配置、默认值、失败状态和限制。市场或 Release 材料只陈述已实现、已验证的范围。

提交原创贡献即表示你有权提供该内容，并同意按本仓库的 Apache-2.0 许可发布该贡献；第三方材料保留原许可并记录来源。本项目没有额外声明一个已存在的 CLA 或签署平台。
