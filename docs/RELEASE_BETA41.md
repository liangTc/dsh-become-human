# Become Human 0.7.0-beta.41

本版为测试版。适用环境为 Windows、Node.js 24 及以上和 DeepSeek Harness `0.2.0-rc.2` 的 Web profile。

## 安装或升级

先在 DSH 中配置模型。已有用户请先备份 Human 数据并停止对应服务，然后在终端执行下列命令。

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add dsh-become-human-web@0.7.0-beta.41 --registry=https://registry.npmjs.org/
npx @deepseek-ai/dsh@0.2.0-rc.2 web --no-open
```

也可下载 [组合包](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.41/dsh-become-human-web-0.7.0-beta.41.tgz) 和 [SHA-256 校验文件](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.41/dsh-become-human-web-0.7.0-beta.41.tgz.sha256)，按[本地安装步骤](INSTALLATION.md)操作。学习行为包 `0.2.0` 和经历行为包 `0.1.0` 可按需安装。

## 本版变化

- 主回复已经提交后，即使辅助检查报错，显式重试也会识别原回复，避免重复回答。
- 带有“【开发计划】”这类标题的正常聊天可以进入记忆。升级时会从仍有效的原文恢复此前误排的消息。
- 长会话启动时按持久化游标核对新增投递记录，减少对历史事件的重复扫描。
- 滚动额度释放后，补额请求会重新计算实际缺口，发送提醒前也会复核额度。
- 已结束的扩展操作可归档，历史超过一千条后仍能继续管理扩展和恢复失败作业。
- 安静时段支持按地区时区自动切换夏令时，也支持固定 UTC 偏移。

## 验证范围

25 组发布回归通过。使用官方 DSH CLI 在同一个隔离 Web profile 从公开 beta.40 原地升级，Chrome 验证了升级及冷重启后的历史聊天、唯一会话和模拟渠道绑定。真实微信实收、真实模型调用及多日运行仍待单独验收。[完整测试记录](TESTING_STATUS.md)
