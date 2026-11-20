# Become Human 0.7.0-beta.43

这个测试版将 Human 带到官方 Windows DSH Desktop。桌面用户可以从侧栏打开 Human，在同一个会话里聊天、延续记忆和使用已授权的行为扩展。原有 DSH Web 安装继续使用原数据目录。

## 安装

| Windows 宿主 | 安装方式 |
| --- | --- |
| DSH Desktop `0.2.2-rc.3` 或 `0.2.2-rc.5` | 下载下面的 `.tgz`。从左侧进入「插件 → 添加插件」，在「包名或地址」填入文件的绝对路径，点击「安装」及「立即启用」。按宿主提示重启，然后从侧栏打开 Human。 |
| DSH Web `0.2.0-rc.2`，Node.js 24+ | 在要安装或升级的 `web` profile 所用环境中运行下方命令。 |

~~~powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add dsh-become-human-web@0.7.0-beta.43 --registry=https://registry.npmjs.org/
npx @deepseek-ai/dsh@0.2.0-rc.2 web --no-open
~~~

Web 和 Desktop 使用同一份安装包。已有用户升级前请备份目标环境的 Human 数据。[下载安装包](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.43/dsh-become-human-web-0.7.0-beta.43.tgz) · [SHA-256 校验文件](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.43/dsh-become-human-web-0.7.0-beta.43.tgz.sha256) · [安装指南](https://github.com/liangTc/dsh-become-human/blob/v0.7.0-beta.43/docs/INSTALLATION.md)

## 与 beta.41 相比

- Desktop 复用宿主的模型配置和运行环境。Web 和 Desktop 各自保存 Human 的会话、运行锁和 IM 绑定。从 Web 转到 Desktop 首次打开时，会进入新 Human 的创建向导。
- 完全退出 Desktop 时，它启动的 Human 后台随之退出。再次打开后恢复原会话。需要全天在线时，可保持宿主运行或使用 Web 常驻方案。
- 聊天和自主选题可接收仅在流式文本块结束时返回的正文。自主选题遇到空正文、断流或临时服务错误后，会等待下次检查；连续失败时逐步延长间隔，最长一小时。Web 和手机状态显示最早再试时间。

## 验证范围

29 组发布回归通过。两个 Desktop 版本均在独立 profile 中安装，完成模型发现、首次设置、启动后台及一轮聊天。模型服务由本机测试程序提供。关闭再启动后，会话 ID 一致，用户和助手消息各保留一条，重启没有重复请求模型。Desktop rc.3 还通过了实际插件管理界面的安装与启用检查。Web rc.2 通过了全新安装、首次引导和常驻入口冷重启检查。

真实供应商、此次版本的手机实收、跨宿主数据迁移与多日运行仍需单独验收。[完整测试记录](https://github.com/liangTc/dsh-become-human/blob/v0.7.0-beta.43/docs/TESTING_STATUS.md)
