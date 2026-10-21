# 架构与扩展边界

[返回首页](../README.md) · [配置](CONFIGURATION.md) · [插件集发布](PLUGIN_SUBMISSION.md)

> **测试版本 `0.7.0-beta.1` · 尚未开发完成。** 图示说明当前设计，不代表完整稳定性验收。

## 结构

![像素风架构：Web 与 IM 通过管理插件连接独立运行模块、主会话与统一能力接口](assets/architecture-pixel.svg)

安装在宿主的 bundle 只插入 `become-human-manager`，不替换普通 DSH 的 Agent 工厂。管理插件启动独立进程与私有 profile；默认工具禁用、持久化与额度边界位于内部运行模块。进程隔离降低相互影响，但不等于不可信代码沙箱。

## 一条主线

Human 保持一个持久主 Session。定时唤醒、聊天、学习、提醒与工具任务共享调度边界。主人输入优先，后台任务通过取消信号及 epoch 检查停止或挂起；只有符合当前状态的结果才能提交。

轻量协调阶段选择一个问题或等待，执行阶段使用临时任务上下文处理有限工作。它不是永远不停输出的模型内心独白。外部 DSH 会话保持独立，仅通过明确授权的读取或写入操作访问；向其发任务可能产生额外模型调用。

## 上下文与证据

上下文按阶段组装：

1. 当前人物与关系是统一身份来源。
2. 当前状况包含有效任务、最近联系、等待原因与授权状态。
3. 根据问题召回有限记忆、近期事件概览、学习笔记与目标摘要。
4. 选择、执行和主人对话使用不同的输入预算，保留当前输入及必要证据。

事实、推断、主人原话和 Agent 学习笔记有不同来源标识。修订、撤回、过期和开发测试数据会影响其可用性；来源摘录不当作完整语义总结。详细公开资料分析会减少不必要的主人私人上下文。

选择下一步的顺序是：**当前人物配置 → 有效记忆、反馈与目标 → 模型选题**。文本 Skill 补充方法与表达，不能成为隐藏人物覆盖或绕过权限的入口。

## 统一能力接口

能力描述包含名称、版本、参数 schema、读写效果、范围、超时、结果大小、取消方式及是否允许自主调用。任务持久化保存实际输入和定义快照。

- 读取仍受资源白名单约束，结果作为不可信外部资料交给模型。
- 写入先准备预览，批准绑定任务、参数摘要、能力定义和权限版本。
- 超时、取消或断开后，无法确定外部结果的写入变为 `unknown`，不自动重放。
- 同一执行门控制前台、后台与桥接操作，取消不会提前放行尚未真正结束的外部动作。

内置 MCP 是真实 stdio JSON-RPC 连接，固定公开网页读取服务。当前没有任意 MCP 服务器管理器。DSH 桥接直接使用宿主服务读取会话，不通过网页抓取。浏览器桥接使用受限 CDP 操作，不提供任意 JavaScript 执行；DOM 点击也不等同系统可信鼠标事件。

代码已预留可信提供方注册接口，但第三方插件与代码 Skill 不能当作安全沙箱中的扩展。当前也没有完成自主选题器对任意注册能力的通用规划。

## 源码目录

```text
plugins/
  become-human/          # 运行模块源码：调度、记忆、学习、额度与能力
  become-human-web/      # 对外分发的 DSH bundle
    manager.mjs         # 宿主服务、Web 与 IM 入口
    supervisor.mjs      # 私有运行进程生命周期与桥接
    worker.mjs          # 从凭据引用启动运行模块
    native-*.tsx        # Human 工作区组件
    host-capabilities.mjs
    browser-capabilities.mjs
    im/                 # 来自 dsh-im 并按唯一会话改造的渠道代码
    runtime/            # build 生成的运行源码副本
    runtime-bundle/     # build 生成的内部 DSH bundle
plugins/become-human/presets/  # 人物与自主额度预设
docs/                   # 使用、架构、发布说明与图片
```

`runtime/` 与 `runtime-bundle/` 由构建同步，不应绕过上游 `become-human/` 单独修改。开发验证目录、运行数据、凭据和历史设计文档不属于公开分发内容。

## 开发与构建边界

在仓库根目录安装开发依赖并构建，主构建会重建 IM 的 host 与客户端、生成 Human Web 客户端并同步内部运行模块。定时规则文件随仓库提供。

```powershell
npm install --prefix plugins/become-human-web
npm run build --prefix plugins/become-human-web
npm run release:package
```

修改日历生成逻辑时，先执行 `npm run build:schedule --prefix plugins/become-human-web`，再执行主构建。`npm run release:source` 另行导出干净源码，以脚本输出路径为准；这两项准备操作不会自动发布。

IM 构建读取本包开发依赖；日历规则来自精确版本的 `@deepseek-ai/dsh-schedule`。重新生成时保留来源信息、上游许可证与修改说明。开发机的缓存目录和私人路径不属于构建契约。第三方代码清单及授权关系见仓库的许可证和第三方声明文件。

## 上游与引用

| 项目 | 在本项目中的作用 |
| --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | DSH 插件宿主、模型与会话服务，以及复用的纯日历规则 |
| [dsh-im](https://github.com/xmanrui/dsh-im) | IM 渠道与账户配置的上游实现；此处修改为本人绑定、单渠道和唯一会话边界 |
| [Humanizer](https://github.com/blader/humanizer) | 文本表达指导；中文对话适配在当前生成内应用，不额外调用模型润色 |

引用不表示上游维护者为本项目提供支持或背书。改动后的渠道注册与会话策略属于本项目，不能直接套用 dsh-im 的完整产品行为。具体版本、保留声明与许可证见 [第三方说明](../THIRD_PARTY_NOTICES.md)。

## 当前交付边界

- 完整运行依赖 Windows DPAPI；跨平台与跨机密钥迁移未完成。
- 兼容性固定 DSH `0.2.0-rc.2`；不能推定兼容未来 rc 或 Desktop。
- 一个 Human 绑定一个 IM，更换会替换旧绑定；12 种聊天适配与 Office 连接器存在不等于每个平台已完成真实验收。
- 开源发行排除 WhatsApp 及其 GPL 依赖链与 QQ 的未授权扫码连接器；QQ 使用手动 AppID / AppSecret。
- 浏览器需要用户自行配置本机 CDP 与范围，不会自动启用或接管浏览器。
- 公开搜索会受站点限制和证据质量影响；没有充分资料时应保留失败或等待状态。
- 行为时间线是可追溯摘要，角色状态是规则与记录推导，不代表真实意识或情绪。
- 长期运行、跨日、故障恢复与长期人格反馈需真实时间验证，不以隔离场景或经过时间替代。
