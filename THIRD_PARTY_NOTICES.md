# 第三方来源与许可证

Become Human 原创代码及文档采用 [Apache License 2.0](LICENSE)，版权声明为 `Copyright 2026 Become Human contributors`。本项目包含改编或预打包的第三方材料；这些材料保留原许可证，不因根目录的许可证变成 Apache-2.0。

本清单以当前仓库中的来源记录、已安装包和保留的许可证为依据。它不代表对第三方商标、账号、服务接口或未授权依赖的使用授权。发布新的构建时，应同步检查实际打包清单及依赖许可证。

## 直接改编与复用

| 材料 | 来源与版本 | 用途与范围 | 保留的许可证 |
| --- | --- | --- | --- |
| dsh-im | [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)，4.39.0 | `plugins/become-human-web/im/` 的渠道实现与配置界面，以及派生的 IM 客户端/Host 构建；已改为 Human 的单会话、单渠道边界和独立命名空间 | [MIT，Copyright 2026 xmanrui](plugins/become-human-web/im/LICENSE) |
| Humanizer | [blader/humanizer](https://github.com/blader/humanizer)，3.1.0，提交 `225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8` | `skills/humanizer/` 的上游技能；`skills/zhiqiu-expression/` 为中文对话适配，沿用其 MIT 声明 | [MIT，Copyright 2025 Siqi Chen](plugins/become-human/skills/humanizer/LICENSE) |
| DSH schedule | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，`@deepseek-ai/dsh-schedule` 0.2.0-rc.2 | `vendor/schedule-rules.mjs` 中的纯时间/Cron 规则；Human 自行管理任务持久化及投递 | [MIT，Copyright 2026 DeepSeek](plugins/become-human/vendor/SCHEDULE-LICENSE.txt) |
| Temporal polyfill | [js-temporal/temporal-polyfill](https://github.com/js-temporal/temporal-polyfill)，0.5.1 | 时间规则构建中的日期与时区计算 | [ISC，Copyright 2017–2020 ECMA International](plugins/become-human/vendor/TEMPORAL-LICENSE.txt) |
| JSBI | [GoogleChromeLabs/jsbi](https://github.com/GoogleChromeLabs/jsbi)，4.3.2 | Temporal 时间规则构建中的大整数兼容实现 | [Apache-2.0](plugins/become-human/vendor/JSBI-LICENSE.txt)，版权归 V8 project authors |

dsh-im 的迁移来源记录在 [MIGRATION.json](plugins/become-human-web/im/MIGRATION.json)，原始归档 SHA-256 为 `5ea4bff9fe56089cac07126c87e939dfab03ff2992e330c81a8a7891efd6694e`。本地记录未保存对应的上游 Git 提交，因此不将版本号推断为提交号。该记录描述迁移时的文件差异，并不是后续所有修改的完整历史。

Humanizer 的文件来源及摘要在 [provenance.json](plugins/become-human/skills/humanizer/provenance.json)。时间规则的包版本、源文件及构建摘要在 [schedule-provenance.json](plugins/become-human/vendor/schedule-provenance.json)。生成的 Web runtime 目录包含同一运行模块的副本，适用相同许可证。

## IM 集成的第三方材料

dsh-im 保留的 [第三方声明](plugins/become-human-web/im/THIRD_PARTY_NOTICES.md) 包括：

- 腾讯 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 请求格式与登录状态，提交 `cef0bfc390393f716903e16d50408118047f87e0`，MIT。
- [dingtalk-openclaw-connector](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector) 的设备授权和 AI Card 协议，提交 `b2fd6e5ea2ff99bd213faac637d3da541b2bfaf4`，MIT。
- `@wecom/wecom-openclaw-cli` 1.1.0 的授权请求流程，上游声明 ISC；未附带该 CLI 源码或 OpenClaw 运行时。
- 飞书 SDK、Baileys、代理库、Protobuf 等依赖和图标来源；原声明中已有的完整许可证均予保留。

其中标识 MIT 的上层 SDK，不代表其所有传递依赖也采用 MIT。原 IM 声明作为上游归属记录保留，其中对 WhatsApp/Baileys 的介绍不代表它们属于本次发行。实际 Host/Client 构建内的第三方 npm 包版本及完整许可证见 [许可证索引](plugins/become-human-web/im/licenses/INDEX.md)、[正文合辑](plugins/become-human-web/im/licenses/BUNDLED-DEPENDENCIES.txt)和[包版本与摘要](plugins/become-human-web/im/licenses/BUNDLED-DEPENDENCIES.json)。对应的[构建清单](plugins/become-human-web/im/BUILD-MANIFEST.json)记录实际输入和产物摘要。

## 本次 Apache 发行的边界

本次发行构建已排除 WhatsApp provider、Baileys、`libsignal` 和 `whatsapp-rust-bridge`，公开源码导出也排除相应渠道目录。原因是旧本地构建的 Baileys 依赖链包含 GPL-3.0 的 [`libsignal` 6.0.0](https://github.com/WhiskeySockets/libsignal-node/blob/master/LICENSE)，而 `whatsapp-rust-bridge` 0.5.4 的包未附带许可证正文。旧的本地预编译包、私有测试归档和 `node_modules` 不属于本次公开发行物，不应直接上传或替代新的发行构建。以后重新接入该渠道时，需要先完成适用许可证、对应源码和组合分发义务的核查，不能把依赖外置或添加致谢直接视为解决。

`@tencent-connect/qqbot-connector` 1.2.0 是外部运行依赖，其包元数据为 `UNLICENSED`，未将其源码并入本项目。不要把该依赖标注为 MIT 或 Apache-2.0，也不要在没有获得适当授权时把它收入二进制、离线依赖或安装包。公开 npm 可下载不等于已授予再分发许可证。

npm 安装的外部运行依赖、DSH 宿主及构建工具保留各自包内的许可证；这里的 Apache-2.0 不重新授权这些包。向他人提供包含 `node_modules` 的离线发行物时，应重新清点并附带相应法律文件。

自定义 MCP 接入通过外部运行依赖 `@modelcontextprotocol/client` 2.0.0（[Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)，MIT）处理 stdio 与 Streamable HTTP 协议。该 SDK 源码未复制进本项目的适配模块；安装依赖保留其包内许可证。第三方 MCP 服务器由用户自行安装或选择，保留各自许可证，服务接入不代表本项目重新授权其内容。

## 图标、商标与配图

渠道图标仅用于识别连接目标。原 IM 声明中来自 [Simple Icons](https://github.com/simple-icons/simple-icons) 的部分路径采用 CC0-1.0；飞书、钉钉、企微等产品标识的商标权仍归各自权利人。dsh-im 随附的品牌图片不应被用作 Become Human 的项目标识。新增项目配图的来源和使用范围应在其资源说明中记录。

## 分发时需要保留

保留根 `LICENSE`、`NOTICE`、本文件，以及对应第三方目录内的许可证、来源记录和构建中保留的版权注释。对第三方代码的修改应明确归属于本项目，不能让用户误认为是原作者发布或官方认可的版本。
