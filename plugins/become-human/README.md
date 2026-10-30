# Become Human · 内部运行模块

> **0.7.0-beta.10 · 开发源码，尚未公开发行，功能尚未开发完成。** 公开测试包仍为 beta.5。本模块仅随组合插件交付，不单独面向用户发行。

这是组合插件 `dsh-become-human-web` 的内部自主运行模块，包含事件循环、唯一会话、分层记忆、学习、额度、目标、定时任务及统一能力队列。

**不要单独安装到日常 DSH profile。** 本目录的隔离 patch 会禁用普通 Agent 循环和工具，正确安装单元是同仓库的 `plugins/become-human-web`。组合包会在专用 home 与私有 profile 中运行此模块。

## 开发约定

- 当前人物配置 → 有效记忆、反馈与目标 → 模型选题。
- 一个 Human 只有一个持久主会话，临时任务上下文不拥有第二个人格或长期记忆。
- 主人输入优先；模型执行与受管工具使用串行入口。
- 自主请求有独立额度，原始用量和保守占额分开记账。
- 写操作绑定具体目标、参数、预览、有效期与批准；unknown 不自动重试。
- 外部网页与工具结果作为未核验材料，不自动改写人格或主人事实。

完整介绍与使用方法见仓库根 [README](https://github.com/liangTc/dsh-become-human#readme) 和 [架构说明](https://github.com/liangTc/dsh-become-human/blob/main/docs/ARCHITECTURE.md)。

本模块原创代码采用 [Apache-2.0](LICENSE)。表达规则、日历纯函数与其打包依赖保留各自原许可，见 [NOTICE](NOTICE)、[第三方声明](THIRD_PARTY_NOTICES.md)、`skills/` 与 `vendor/` 内的许可证。

## 任务看板与认知记录

任务看板汇总任务、目标、子步骤、定时、工具和产物，并收纳自我状态、共享事项、单一关注与规则反思。主人和 Agent 使用同一主 Session 的持久记录；关注事项仍需经过原预算、静默、未回复退避和动作权限。参见[看板说明](https://github.com/liangTc/dsh-become-human/blob/main/docs/CHARACTER_BOARD.md)与[测试状态](https://github.com/liangTc/dsh-become-human/blob/main/docs/TESTING_STATUS.md)，已验证片段不代表新版完整验收或长期运行通过。
