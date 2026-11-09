# Human 页面扩展示例

需要 Human 0.7.0-beta.37 或更新版本。此包仅演示页面注册，不创建会话，不调用模型，不发消息。

在本目录运行 `npm pack --ignore-scripts`，然后在 Human 的“设置 → 工具与技能 → 行为扩展”选择生成的 `.tgz`，核对并勾选信任后安装。顶部“扩展”中将出现“页面示例”。停用节点隐藏入口，重新启用恢复，移除包清除注册。

`dsh.human.pages` 是声明式 v1 页面合同，支持 `text`、`list`、`runtime-status`。文本按普通文本渲染，不执行 HTML 或脚本，不授予额外工具权限。它不是任意 React/JavaScript 页面装载器；复杂 DSH 前端插件仍需安装在宿主并使用 DSH 原生 slots。
