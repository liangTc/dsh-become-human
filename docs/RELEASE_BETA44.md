# Become Human 0.7.0-beta.44

这是面向 DSH Web 和 Windows Desktop 的测试版，重点修复工具授权、工作记忆和重复审批。升级会保留原会话、微信绑定及已有资料。卸载学习包后可以重新启用，删除笔记则需要用户明确操作。

## 使用变化

- 聊天或看板重试一个写操作时，即使模型第二次省略了工具查询，也会复用第一份审批。
- 停用学习包后，Human 从工具目录撤下笔记与报告操作，也会从后续模型请求中撤回这些资料。一次读过多份笔记时，每份都要重新核验。关闭自主学习开关时，主人仍可主动查询已启用学习包里的资料。
- 撤销 DSH 会话读取权限后，相关工作记忆退出上下文。重新授权后，Human 必须重新核验来源。模型缺少输出容量信息时，工作观察会显示相应故障。
- 工具设置变化后，已打开的工具页会刷新。关闭内置 MCP 会等待子进程退出，停用内置技能也会从 DSH 注销 Human 注册的条目。

## 安装

Web 使用同一个组合包。

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add dsh-become-human-web@0.7.0-beta.44 --registry=https://registry.npmjs.org/
```

Windows Desktop 可在「插件 → 添加插件」安装主包 `dsh-become-human-web-0.7.0-beta.44.tgz`。按需安装的学习包为 `dsh-human-learning-0.2.1.tgz`，体验包为 `dsh-human-experience-0.1.0.tgz`。下载附件后可用同名 `.sha256` 文件校验。[GitHub 测试版](https://github.com/liangTc/dsh-become-human/releases/tag/v0.7.0-beta.44) · [安装指南](INSTALLATION.md)

## 验证范围

项目回归覆盖消息重试、资料撤回、授权变更和冷启动。内置 MCP 的退出和冷启动在隔离的 DSH Web 宿主验证。最新修复在用户现有宿主上的真实模型表现、手机实收以及专用机器的多日运行仍待验收。[测试记录](TESTING_STATUS.md)
