# Become Human 0.7.0-beta.39

测试发行（Prerelease），尚未开发完成。支持 Windows、Node.js 24+、DSH 0.2.0-rc.2 的 web profile。

## 安装

下载本 Release 的 `dsh-become-human-web-0.7.0-beta.39.tgz` 及 `.sha256`，核对 SHA-256。停止要更新的 DSH 后，在下载目录执行：

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ./dsh-become-human-web-0.7.0-beta.39.tgz
npx @deepseek-ai/dsh@0.2.0-rc.2 web --no-open
```

组合包包含管理插件和独立运行模块，无需单独安装内部 runtime。升级前备份，保留原数据目录；启动后核对原会话、配置和 IM 绑定，再按页面状态恢复自主运行。GitHub 自动生成的源码 ZIP 不是组合安装包。npm beta.39 已发布；官方仓库下载包已核对 SHA-512，与本 Release 的原始安装包完全一致。

也可从 npm 安装：

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add dsh-become-human-web@0.7.0-beta.39 --registry=https://registry.npmjs.org/
```

## 相对 beta.5 的主要变化

- 核心收敛为事件选择、单执行线、行动回执、结果反馈与成长；学习降为默认停用的可选行为包。
- 对话引入完整轮次、滚动摘要和长期召回，改进发言归属、更正承接与无依据经历审查；支持视觉模型的图片输入。
- 扩展安装、启停、升级与恢复；Human 内自定义 React / 声明式页面，以及带授权、过期校验和幂等处理的扩展后台接口。
- MCP 与授权 DSH 会话读写、任务与记忆管理、用量统计及简化后的 Web 导航。
- 后续版本已修复 beta.5 的首次创建初始化问题，但最终包在无共享缓存的新机器上仍需完整验收。

## 验证边界

已有各版本隔离检查和有限真实 Web、模型、微信流程记录；具体范围见 `docs/TESTING_STATUS.md`。本次发布回归另见 `docs/RELEASE_BETA39_CHECKS.json`，隔离检查不等于真实服务验收。

仍待完成：最终发行包干净机器安装与凭据组合、多日连续运行、长期人格反馈、更多视觉/MCP/DSH 场景、其他 IM 和跨机器恢复。自然表达和图片识别仍可能出错。仅兼容上述固定 DSH 版本，不保证任意第三方扩展兼容。

微信在线不等于能主动发送；`unknown` 投递不自动补发。写操作按授权与审批执行。可执行扩展是可信代码，不提供恶意代码沙箱。备份使用 Windows DPAPI，不承诺跨机器或跨账户恢复。

## 许可

原创部分 Apache-2.0；dsh-im、Humanizer 及其他依赖保留各自许可。安装包含 LICENSE、NOTICE、THIRD_PARTY_NOTICES.md，不包含私人聊天、凭据或运行数据库。


## 发布依赖修复

beta.38 在发布复核中发现依赖安全问题，已退回草稿。本版更新 MCP 客户端至 2.4.0、undici 至 7.30.2，并更新 follow-redirects。beta.38 的旧标签和附件不覆盖；请使用本版。CI 的 Windows 测试加载路径也已修正。
