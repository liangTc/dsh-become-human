# 发行、社区登记与 DSH 插件市场

[返回首页](../README.md) · [安装](INSTALLATION.md) · [架构](ARCHITECTURE.md)

本页分别说明公开源码、Release 安装包、社区登记和自定义市场索引。社区登记不等于可安装索引，也不代表 DSH 官方背书。

当前版本是 **`0.7.0-beta.4` 测试版本，尚未开发完成**。安装入口为 [固定版本 Release](https://github.com/liangTc/dsh-become-human/releases/tag/v0.7.0-beta.4)，其中提供 [组合包](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.4/dsh-become-human-web-0.7.0-beta.4.tgz) 与 [SHA-256 校验文件](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.4/dsh-become-human-web-0.7.0-beta.4.tgz.sha256)。npm 包尚未发布；介绍页和社区条目继续保留测试状态。

## 提交 DSH Plugin Radar 社区登记

本次登记目标为社区维护的 [AdamPlatin123/dsh-plugin-radar](https://github.com/AdamPlatin123/dsh-plugin-radar)，不是 DSH 官方商店。以其当前 [PLUGINS.md](https://github.com/AdamPlatin123/dsh-plugin-radar/blob/main/PLUGINS.md) 与 [README](https://github.com/AdamPlatin123/dsh-plugin-radar#readme) 为准：

1. 给本仓库添加 `dsh-plugin` topic。
2. Fork 上游，为 `PLUGINS.md` 的 **🔌 单插件** 表格追加一行；本项目用途属于 **Agent 能力**。若上游调整分类，按提交时的现有结构放置。
3. 使用与仓库一致的登记名 `dsh-become-human`，写明 Release、安装方式、兼容环境和限制，向上游提交 PR。
4. 登记运行级先填“待测”；PR 合并后再更新收录状态。作者自测不替代 Radar 的独立运行级判定。

可提交的条目描述示例：

```markdown
| dsh-become-human | [liangTc/dsh-become-human](https://github.com/liangTc/dsh-become-human) | 单会话自主 Agent：人格、分层记忆、学习、目标与主动交流，Web 与一个 IM 渠道共享会话；beta.4 尚未开发完成；Windows / Node 24 / DSH 0.2.0-rc.2 web 已有作者实测，提供 Release .tgz 与校验文件 | 待测 |
```

PR 说明应注明实测限于 Windows 与 DSH `0.2.0-rc.2` 的 `web` profile：已有安装升级、真实模型、部分微信流程和本地隔离回归。不要据此声称所有渠道、干净机器、多插件共存或多日稳定性已通过。提交或被社区收录均不构成官方兼容认证；上游合并前不写“已收录”。

## Release 与源码的安装边界

- 普通用户下载固定版本 `.tgz` 与 `.sha256`，按 [安装指南](INSTALLATION.md#使用预构建包推荐) 校验，再执行 `dsh plugin --profile web add <本地包路径>`。
- Git 仓库与源码 ZIP 不含 `client.js`、IM bundle 和 runtime 等完整预构建产物，需要先构建，不能直接登记为可安装的 Git bundle。
- 当前社区登记只需仓库说明与可下载的发行包，无需为此新建 bundle 分支或发布 npm。
- 若将来加入消费 JSON 索引的插件市场，再单独按其规范准备安装来源与固定版本；不能把 Release 下载地址伪装成 npm registry。

## DSH 自定义市场机制（独立流程）

截至 **2026-10-21**，DSH 官方文档描述的是实验性的**自定义插件市场**：维护者发布 JSON 索引，用户在当前 profile 添加索引源。官方文档明确默认不内置索引源；本页没有找到可以声称为“官方统一收录入口”的提交地址。[官方市场指南](https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market)

可选路线：

| 路线 | 需要准备 | 状态说明 |
| --- | --- | --- |
| GitHub Release 附件 | 预构建 `.tgz`、校验值、说明与许可 | 用户可本地 `dsh plugin --profile web add` |
| npm | 可用包名、维护权限、已发布精确版本 | 发布成功前不宣传 `add 包名` 可用 |
| 自建或第三方插件集 | npm 来源或 Git 固定 commit、可访问索引 | 自建索引不等于 DSH 官方收录 |
| 社区发现 | 公开仓库说明、截图、`dsh-plugin` topic | topic 有助发现，不代表市场审核通过 |

官方主仓库推荐插件仓库使用 `dsh-plugin` topic。[DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)

## 仓库信息与发布前待填写

目标仓库为 [liangTc/dsh-become-human](https://github.com/liangTc/dsh-become-human)，维护者为 [ltc（liangTc）](https://github.com/liangTc)。仓库及 package.json 的 repository、homepage、bugs 已按该地址配置。推送源码、发布安装包和部署市场索引是各自独立的步骤，以下发行信息仍需在实际发布时确认：

- `https://github.com/liangTc/dsh-become-human`：项目仓库地址。
- npm 包名与发布账户：确认 `dsh-become-human-web` 是否可用，或采用自有 scope；若改名需同步 patch、导出及内部链接。
- 核对 `package.json` 的公开元数据；原创代码署名保留 Become Human contributors，Git 提交使用维护者提供的身份。
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

发布仓库并得到固定提交后，可运行 `npm run release:market -- https://github.com/liangTc/dsh-become-human 完整40位提交SHA`。生成器先检查该公开提交是否带有匹配版本的预构建 bundle；缺少 runtime、client 或 IM 产物的源码提交会被拒绝。成功后写入 `dist/market/index.json`，仍需将索引部署到可信 HTTPS 静态地址，再添加到 DSH 的自定义市场。该命令不会发布索引，也不表示官方收录。

市场可以引用 npm 包或固定 Git 提交。本仓库包位于 `plugins/become-human-web`，因此 Git 记录必须带该目录。下面是**待填写模板，不是可直接发布的 JSON**：

```text
name: dsh-become-human-web
title.zh: Become Human · 自主 Agent
title.en: Become Human
description.zh: 为 DSH Web 增加统一人格、记忆、学习与主动行为的单会话 Agent。
repository.url: https://github.com/liangTc/dsh-become-human
repository.directory: plugins/become-human-web
version: 0.7.0-beta.4（必须与实际 package.json 一致）
publishTimestamp: 实际发布时间的 Unix 秒
source.type: git
source.url: https://github.com/liangTc/dsh-become-human
source.commit: 该版本的完整 40 位 commit SHA
source.path: plugins/become-human-web
engines.dsh: 0.2.0-rc.2
```

若使用 npm 来源，只有成功公开发布后才将 `source` 改成 npm 类型。不要把 GitHub Release 下载地址填为 npm registry，也不要使用会漂移的分支名代替 commit。

字段结构以官方市场文档和索引校验器为准。DSH 主仓库提供参考生成器，可在其开发环境中从插件列表生成索引；本仓库不内置或伪造官方市场 manifest。提交到第三方插件集时，按该集维护者公开的准则操作，核对其是否支持带子目录的 Git bundle。

## 推荐的公开描述

> Become Human 是面向 DeepSeek Harness Web 的自主 Agent 插件。它围绕一个持久会话组织人格、记忆、学习、目标、定时任务和主动交流，并通过独立运行模块控制模型调用、额度与执行边界。Web 与一个本人绑定的 IM 渠道共享会话，更换渠道会替换旧绑定；内置只读 MCP，外部 DSH 会话和浏览器操作按范围授权。当前为 0.7.0-beta.4 测试版本，尚未开发完成，完整运行要求 Windows 与 DSH 0.2.0-rc.2。

不建议写“官方插件”“已入插件市场”“全平台即装即用”“所有 IM 实测”“永不停机”或“拥有真实情感”。这些说法超出当前交付和验证范围。
