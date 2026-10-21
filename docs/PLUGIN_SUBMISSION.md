# GitHub 发布与 DSH 插件集接入

[返回首页](../README.md) · [安装](INSTALLATION.md) · [架构](ARCHITECTURE.md)

本页区分三件事：公开源码仓库、交付可安装 bundle、出现在某个插件集。准备好这些材料不代表已经发布或获官方背书。

当前公开发行目标是 **`0.7.0-beta.1` 测试版本，尚未开发完成**。介绍页、市场卡片和 Release 应保留该状态，不标记为稳定完成版。

## 目前的 DSH 插件集机制

截至 **2026-10-21**，DSH 官方文档描述的是实验性的**自定义插件市场**：维护者发布 JSON 索引，用户在当前 profile 添加索引源。官方文档明确默认不内置索引源；本页没有找到可以声称为“官方统一收录入口”的提交地址。[官方市场指南](https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market)

可选路线：

| 路线 | 需要准备 | 状态说明 |
| --- | --- | --- |
| GitHub Release 附件 | 预构建 `.tgz`、校验值、说明与许可 | 用户可本地 `dsh plugin --profile web add` |
| npm | 可用包名、维护权限、已发布精确版本 | 发布成功前不宣传 `add 包名` 可用 |
| 自建或第三方插件集 | npm 来源或 Git 固定 commit、可访问索引 | 自建索引不等于 DSH 官方收录 |
| 社区发现 | 公开仓库说明、截图、`dsh-plugin` topic | topic 有助发现，不代表市场审核通过 |

官方主仓库推荐插件仓库使用 `dsh-plugin` topic。[DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)

## 发布前待填写

当前 GitHub owner、仓库地址和维护者身份尚未提供。发布前填写真实值，不能把占位符直接写入 npm 或市场：

- `https://github.com/OWNER/REPOSITORY`：仓库地址。
- npm 包名与发布账户：确认 `dsh-become-human-web` 是否可用，或采用自有 scope；若改名需同步 patch、导出及内部链接。
- `package.json` 的 repository、homepage、bugs、author 等公开元数据。
- Release tag、精确包版本、实际发布日期及完整 40 位 commit SHA。
- 图标的正式托管地址；所有图片应使用脱敏内容。
- 安全问题的联系渠道；不要填写不存在的邮箱或暗示平台官方支持。

## GitHub 公开仓库清单

- [ ] 核对 `.gitignore`：不包含 `.dsh-verify`、运行 homes、凭据、数据库、备份、认证链接、私人测试日志和聊天截图。
- [ ] 核对已暂存及历史内容；`.gitignore` 不会自动清除已经提交的数据。
- [ ] Apache-2.0 许可证覆盖本项目原创部分，保留第三方原有许可证与 NOTICE。
- [ ] README 清楚说明 Windows / Node / DSH 版本和当前限制，链接安装、使用、配置与架构。
- [ ] 每张配图提供用途明确的说明；概念图不冒充运行截图。
- [ ] 源码构建不依赖开发者私有目录、测试目录或 npm 缓存路径。
- [ ] 内部 runtime 不作为独立面向普通用户的安装包宣传。
- [ ] 公开版排除 WhatsApp 及其 GPL 依赖链和 QQ 的未授权扫码连接器，QQ 手动配置保留。
- [ ] 渠道数写为“12 种聊天适配实现与 Office 连接器”，不写“全渠道均已实测”；单 IM 绑定与替换旧绑定的语义明确。
- [ ] 在干净机器完成首次安装验收后再标记稳定；本次整理不等于完成该验收。

## Release 建议内容

1. 在源码中统一版本，在仓库根执行 `npm install --prefix plugins/become-human-web` 和 `npm run build --prefix plugins/become-human-web`。
2. 用 `npm run release:package` 生成组合包，用 `npm run release:source` 导出干净源码，检查实际清单和许可证；以脚本输出路径为准。
3. 为 `.tgz` 生成 SHA-256；将安装包和校验文件作为 Release 附件。
4. Release 说明写清兼容 DSH 精确版本、需要手动配置的字段、升级步骤、已知问题及真实测试范围。
5. 核对认证链接、凭据、内部机器路径和私人聊天未进入附件。

GitHub tag 只标识源码。若市场使用 Git 来源，构建产物必须能由其安装路径提供，或明确满足该 DSH 版本的构建授权要求；不要默认 Git 安装会执行所有构建脚本。预构建 npm 包或 `.tgz` 通常更便于用户安装。[官方打包说明](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)

## 为插件集准备条目

发布仓库并得到固定提交后，可运行 `npm run release:market -- https://github.com/OWNER/REPOSITORY 完整40位提交SHA`。生成器先检查该公开提交是否带有匹配版本的预构建 bundle；缺少 runtime、client 或 IM 产物的源码提交会被拒绝。成功后写入 `dist/market/index.json`，仍需将索引部署到可信 HTTPS 静态地址，再添加到 DSH 的自定义市场。该命令不会发布索引，也不表示官方收录。

市场可以引用 npm 包或固定 Git 提交。本仓库包位于 `plugins/become-human-web`，因此 Git 记录必须带该目录。下面是**待填写模板，不是可直接发布的 JSON**：

```text
name: dsh-become-human-web
title.zh: Become Human · 自主 Agent
title.en: Become Human
description.zh: 为 DSH Web 增加统一人格、记忆、学习与主动行为的单会话 Agent。
repository.url: https://github.com/OWNER/REPOSITORY
repository.directory: plugins/become-human-web
version: 0.7.0-beta.1（必须与实际 package.json 一致）
publishTimestamp: 实际发布时间的 Unix 秒
source.type: git
source.url: https://github.com/OWNER/REPOSITORY
source.commit: 该版本的完整 40 位 commit SHA
source.path: plugins/become-human-web
engines.dsh: 0.2.0-rc.2
```

若使用 npm 来源，只有成功公开发布后才将 `source` 改成 npm 类型。不要把 GitHub Release 下载地址填为 npm registry，也不要使用会漂移的分支名代替 commit。

字段结构以官方市场文档和索引校验器为准。DSH 主仓库提供参考生成器，可在其开发环境中从插件列表生成索引；本仓库不内置或伪造官方市场 manifest。提交到第三方插件集时，按该集维护者公开的准则操作，核对其是否支持带子目录的 Git bundle。

## 推荐的公开描述

> Become Human 是面向 DeepSeek Harness Web 的自主 Agent 插件。它围绕一个持久会话组织人格、记忆、学习、目标、定时任务和主动交流，并通过独立运行模块控制模型调用、额度与执行边界。Web 与一个本人绑定的 IM 渠道共享会话，更换渠道会替换旧绑定；内置只读 MCP，外部 DSH 会话和浏览器操作按范围授权。当前为 0.7.0-beta.1 测试版本，尚未开发完成，完整运行要求 Windows 与 DSH 0.2.0-rc.2。

不建议写“官方插件”“已入插件市场”“全平台即装即用”“所有 IM 实测”“永不停机”或“拥有真实情感”。这些说法超出当前交付和验证范围。
