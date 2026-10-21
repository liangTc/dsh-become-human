# 安装与升级

[返回首页](../README.md) · [配置说明](CONFIGURATION.md) · [使用指南](USAGE.md)

> [!WARNING]
> **`0.7.0-beta.1` 是测试版本，尚未开发完成。** 本页是公开发行的安装流程，不表示干净机器安装与全部能力已完成验收。

## 支持范围

| 项目 | 当前要求 |
| --- | --- |
| 操作系统 | Windows；密钥保护使用 Windows DPAPI，Linux / macOS 尚未完成适配 |
| Node.js | 24 或以上 |
| DeepSeek Harness | **0.2.0-rc.2**，当前代码会拒绝其他版本 |
| DSH profile | `web` |
| 安装单元 | `plugins/become-human-web` 生成的组合包 |
| 模型 | 已在源 DSH profile 中配置的 `llm-pi-ai` 提供商与模型 |

先使用独立数据目录尝试，再决定是否用于长期运行。源码内的 `plugins/become-human` 是内部运行模块，**不要把它单独安装到日常 DSH profile**；其隔离配置会禁用普通工具与默认 Agent 循环。

本仓库不承诺 npm 包已经公开发布，也不代表已被任何插件集收录。以下默认使用自己构建、或从可信 Release 下载的 `.tgz` 文件。

## 1. 准备 DSH 与模型

在 PowerShell 中启动指定版本：

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

通过 DSH 设置 → 模型，添加可用的第三方或自定义模型 API，记录实际 **Provider ID** 和 **Model ID**。本插件当前读取 `$DSH_HOME/profiles/web/cordis.patch.yml` 内 `llm-pi-ai.config.providers` 的路由；仅配置 `llm-deepseek` 原生适配器尚不足以启动本插件。

凭据使用 DSH 的凭据引用（`apiKeyEnv`），或该引用对应的环境变量。不要把明文密钥放进插件配置。内联 `apiKey` 与自定义 `headers` 的源路由目前不会被迁入运行模块。模型配置的字段以 [DSH 模型配置指南](https://deepseek-harness.github.io/deepseek-harness/guide/providers) 为准。

完成后关闭该次 DSH 进程，以便安装并修改配置。默认 `$DSH_HOME` 是用户主目录下的 `.dsh`；如使用了自定义值，后续命令必须保持一致。

## 2. 获取安装包

### 从源码构建

先下载或克隆本仓库，进入仓库根目录。当前仓库地址以项目发布后的 GitHub 地址为准。

```powershell
npm install --prefix plugins/become-human-web
npm run build --prefix plugins/become-human-web
npm run release:package
```

构建所需的本地依赖由 `package.json` 声明，主构建重建 IM 和 Human Web 客户端，并把同仓库的运行模块复制到分发包中。最终得到类似 `dsh-become-human-web-0.7.0-beta.1.tgz` 的文件；**以命令实际输出路径为准**。

定时规则产物随仓库提供，需要修改日历生成逻辑时，再按 [架构说明](ARCHITECTURE.md#开发与构建边界) 重新生成。`npm run release:source` 可另外导出干净源码，不会自动上传或发布。

### 使用 Release 附件

若维护者已发布 Release，下载其预构建 `.tgz`，核对版本和 SHA-256。不要把源码 ZIP 直接当成安装包。Release 应同时附上许可证与第三方声明；见 [发布清单](PLUGIN_SUBMISSION.md)。

## 3. 安装到 web profile

在安装包所在目录执行，文件名替换为实际文件名：

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ./dsh-become-human-web-0.7.0-beta.1.tgz
```

这是 DSH 官方组合包安装路径，会更新 profile 的依赖与 bundle 列表。不要用普通 `npm install` 代替 profile 注册，也不要只复制 `manager.mjs`。[官方打包与安装说明](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish) 说明了 `.tgz`、本地目录和 profile 的区别。

## 4. 填写首次启动配置

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，在已有条目之外追加下面这一个覆盖项。**保留原有提供商、模型及其他插件配置**。

```yaml
- id: become-human-manager
  config:
    sourceHome: C:/Users/YOUR_NAME/.dsh
    sourceProfile: web
    runtimeHome: C:/Users/YOUR_NAME/.dsh-human-runtime
    runtimeProfile: become-human-runtime
    runtimePort: 3091
    provider: YOUR_PROVIDER_ID
    model: YOUR_MODEL_ID
    intervalMs: 600000
    tokenBudget: 40000
    localQuotaEnabled: true
    budgetRound: initial
    maxTokens: 2048
    maxCycles: 1
    requestTimeoutMs: 90000
    interactiveOnly: true
```

将 `YOUR_NAME`、`YOUR_PROVIDER_ID`、`YOUR_MODEL_ID` 改为本机真实值。路径必须为绝对路径；不要照抄示例中的占位符。`runtimeHome` 使用专用、非符号链接的目录，且不可与 `sourceHome` 相同。`3091` 是示例中的内部运行端口，需要空闲；用户继续使用 DSH 主页面，不必直接访问它。

各字段作用及界面中的自主额度与此处的区别，见 [配置说明](CONFIGURATION.md)。安装包只插入管理插件，用户的 profile patch 提供本机路径和模型选择。

## 5. 启动与首次设置

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 web --no-open
```

打开终端打印的认证地址，进入左侧 Human 入口。认证链接等同访问凭据，不要贴到 issue、截图或公开日志中。首次启动按以下顺序设置：

1. **人格与关系**：选择或自定义人物，填写与你的关系和沟通偏好。
2. **模型与对话**：核对所选模型、输出长度与连续输入合并设置。
3. **自主行为**：从低额度开始，设置静默时段、检查间隔和主动联系节奏。
4. **手机连接**：需要时配置一个渠道，并完成本人的私聊配对。
5. 核对状态后，明确启动自主运行。冷启动保持暂停，不等于安装失败。

开源版不包含 WhatsApp 及其 GPL 依赖链，也不包含 QQ 的未授权扫码连接器；QQ 采用手动 AppID / AppSecret。列表中的 12 种聊天渠道实现与 Office 连接器不代表全部真实验收通过。**一个 Human 只能绑定一个有效 IM，更换渠道会替换旧绑定。**

## 升级、停止与卸载

升级前先暂停 Human，等待当前工作结束，关闭管理端及其运行模块，备份数据，再按相同 `plugin --profile web add <新包.tgz>` 路径更新。首次升级后核对版本、唯一会话、绑定与待处理任务，按需手动恢复。不要用删除数据目录的方式解决启动问题。

卸载组合包可使用 DSH 插件页，或对应的 `dsh plugin --profile web remove dsh-become-human-web` 命令。卸载代码与删除私人数据是不同操作，数据需要在明确确认后另行处理。

离线备份工具要求两个服务均停止，并明确指定实际管理端口与运行端口。当前加密备份只支持**同一 Windows 账户、相同绝对目录**恢复，不能当作跨机器迁移方案。移动机器时应重新安装和配置凭据；可导出的人物或额度 JSON 不包含完整历史或绑定密钥。

## 常见问题

| 状态或错误 | 优先检查 |
| --- | --- |
| `UNSUPPORTED_DSH_VERSION` | 启动的 DSH 是否精确为 `0.2.0-rc.2` |
| `UNSUPPORTED_KEY_PLATFORM` | 当前完整运行模块依赖 Windows DPAPI |
| `MODEL_ROUTE_REQUIRES_SETUP` | 源 profile 的 `llm-pi-ai` 内是否存在所选 provider/model，是否混入内联密钥或 headers |
| `MODEL_CREDENTIAL_REFERENCE_MISSING` / `MODEL_CREDENTIAL_MISSING` | 路由是否有 `apiKeyEnv`，源凭据或环境变量是否有效 |
| `RUNTIME_PORT_ALREADY_IN_USE` | 内部端口是否已被其他进程占用；管理端不会接管陌生进程 |
| `INVALID_RUNTIME_HOME` / `LINKED_RUNTIME_HOME` | 是否使用不同的绝对路径，以及真实目录 |
| `WORKER_UNAVAILABLE` | 在数据与维护中查看运行状态与日志；确认问题后再手动恢复 |
| 微信显示已发送但手机未收到 | 区分本地回执、平台受理和真实实收；不要自动重发 `unknown` 投递 |

提交问题时提供脱敏版本、错误码、操作步骤和日志片段。不要提交数据库、认证链接、配对码或完整聊天记录。
