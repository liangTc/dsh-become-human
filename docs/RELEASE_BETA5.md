# Become Human v0.7.0-beta.5

**测试发行（GitHub Prerelease）· 尚未开发完成。** 完整运行要求 Windows、Node.js 24+、DeepSeek Harness `0.2.0-rc.2` 的 `web` profile。本次发布不扩大平台或 DSH 版本兼容范围。

## 下载与安装

- [组合安装包](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.5/dsh-become-human-web-0.7.0-beta.5.tgz)
- [SHA-256 校验文件](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.5/dsh-become-human-web-0.7.0-beta.5.tgz.sha256)
- [完整安装与升级说明](https://github.com/liangTc/dsh-become-human/blob/v0.7.0-beta.5/docs/INSTALLATION.md)

核对下载文件的 SHA-256 后，在文件所在目录执行：

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ./dsh-become-human-web-0.7.0-beta.5.tgz
```

`.tgz` 同时包含 Web 管理插件和私有后台代码，无需单独安装内部运行模块。npm 包尚未发布；GitHub 自动生成的源码 ZIP 不是预构建安装包。

升级前保存配置和备份，停止原 DSH 进程后安装，再按安装说明启动并检查原会话、数据及绑定。不要删除原数据目录或重新创建 Human 来完成升级。既有唯一主会话与一个有效 IM 绑定的设计保持不变；后台仍由宿主 DSH 管理，本版不新增常驻服务。

## 相对 beta.4 的主要变化

- **任务看板：** 统一目标、步骤、定时任务、工具和产物，默认显示摘要，支持单项或本页全部展开、筛选与分页；共用关注事项、自我状态、注意力及规则反思。
- **用量统计：** 查看近 24 小时和当前额度周期的供应商报告 token、请求、保守占额、待确认用量、工作类别和模型明细。读取账本不调用模型。
- **人格与记忆维护：** 默认关闭的证据关联人格偏移，可撤回；周期记忆整理、冷热分层、来源关联与批次恢复。移除旧表达模式和表达倾向自动微调。
- **工具接入：** 自行配置 stdio / Streamable HTTP MCP，逐项授权；支持宿主可见 DSH 普通会话的范围授权与收回，写操作继续逐笔审批。
- **原生模型兼容：** 接入 DSH 官方 DeepSeek API Key 适配器，保留第三方 `llm-pi-ai` 路由；模型目录标明来源，后台解析宿主凭据引用，增加推理档位和路由冲突校验。
- **交互与检索：** 简化任务和时间线默认视图，改进具体 HTTP 状态码检索与失败记录的呈现。

## 验证边界与已知限制

**原生 DeepSeek 全新安装整链仍待测试，本轮不执行：** 全新 DSH → 宿主配置 Key → 模型发现与凭据复用 → 首次后台启动 → 真实原生请求。现有记录只覆盖语法、本地构建、已有环境安装/服务恢复与只读模型目录发现，不能认定原生请求成功。此前 179 个安装文件的核对属于历史部署快照，本次重打包的文件清单以实际附件为准。DeepSeek 账号登录通道、内联密钥和任意 headers 不在支持范围。

已有部分目标、学习笔记、报告审批、结果反思和微信实收的短测记录，但不代表完整新装、多插件、多渠道或多日稳定性全部通过。公开搜索仍可能无结果或证据不足；微信可能受平台会话窗口和 iLink `-2` 限制，`unknown` 投递不会自动重发。平台发送回执也不等于手机实收。

人格长期反馈、语义质量、跨日/故障场景及其他 IM 的真实流程仍需分别验收。备份依赖 Windows DPAPI，不保证跨机器或跨账户恢复。任意 MCP 安装器、通用自主工具规划、Codex 执行器和原生桌面窗口控制尚未提供。

完整边界见 [测试状态与待测试清单](https://github.com/liangTc/dsh-become-human/blob/v0.7.0-beta.5/docs/TESTING_STATUS.md)；请勿上传密钥、认证链接、数据库或私人聊天作为公开反馈。

原创部分采用 Apache-2.0；第三方代码与依赖保留原许可。IM 适配参考并派生自 [dsh-im](https://github.com/xmanrui/dsh-im)，详见仓库内的 NOTICE 与 THIRD_PARTY_NOTICES。
