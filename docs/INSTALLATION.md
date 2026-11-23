# 安装与升级

> **测试版 0.7.0-beta.45。** [GitHub Release](https://github.com/liangTc/dsh-become-human/releases/tag/v0.7.0-beta.45) · [npm 安装包](https://www.npmjs.com/package/dsh-become-human-web/v/0.7.0-beta.45) · [本版发行说明](https://github.com/liangTc/dsh-become-human/blob/v0.7.0-beta.45/docs/RELEASE_BETA45.md)

[返回首页](../README.md) · [配置说明](CONFIGURATION.md) · [使用指南](USAGE.md) · [测试状态](TESTING_STATUS.md)

**本版仍在测试。** Windows 上的独立 profile 已验证首次安装与冷重启。原生 DeepSeek 的新机器无缓存安装、真实供应商调用及长期运行仍有待验证。

## 支持范围

| 项目 | 当前要求 |
| --- | --- |
| 操作系统 | Windows；密钥保护使用 Windows DPAPI，Linux / macOS 尚未完成适配 |
| Node.js | Web 使用 Node.js 24 或更高版本，Desktop 使用应用自带的运行环境 |
| DeepSeek Harness | 官方 Windows Desktop `0.2.2-rc.3` 或 `0.2.2-rc.5`，Windows Web `0.2.0-rc.2` |
| DSH profile | Web 选择 `web`，Desktop 使用宿主提供的 `desktop` |
| 安装单元 | `plugins/become-human-web` 生成的组合包 |
| 模型 | 源 DSH profile 的兼容第三方模型或 DSH 原生 DeepSeek API Key 通道；原生全新安装整链待测 |

Desktop 首次设置可选择宿主模型，退出并重新启动后回到原会话。Web 版也验证了首次安装与常驻入口重启。[验收记录](TESTING_STATUS.md)

先使用独立数据目录尝试，再决定是否用于长期运行。源码内的 `plugins/become-human` 是内部运行模块，**不要把它单独安装到日常 DSH profile**；其隔离配置会禁用普通工具与默认 Agent 循环。

安装流程是：**安装一个组合包 → 打开 Human 完成首次设置 → 创建并启动**。组合包已经包含后台代码；插件自动准备专用运行目录和内部 profile，复用宿主的 Node 与 DSH 启动后台，无需另装第二套 Human 程序。

下载并保留与版本对应的 `.tgz` 与 SHA-256 文件。[beta.45 Release](https://github.com/liangTc/dsh-become-human/releases/tag/v0.7.0-beta.45)

<a id="desktop-windows"></a>

## 在 Windows Desktop 安装

1. 在官方 DSH Desktop 的「关于」确认版本为 `0.2.2-rc.3` 或 `0.2.2-rc.5`，在宿主的模型设置中配置要使用的模型。
2. 下载 `dsh-become-human-web-0.7.0-beta.45.tgz`，并用同版 `.sha256` 核对文件。[安装包](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.45/dsh-become-human-web-0.7.0-beta.45.tgz) · [SHA-256](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.45/dsh-become-human-web-0.7.0-beta.45.tgz.sha256)
3. 从 Desktop 左侧进入「插件 → 添加插件」，在「包名或地址」填入安装包的**绝对路径**，点击「安装」，再选择「立即启用」。若宿主提示重启，退出并重新打开 Desktop。
4. 从左侧栏打开 **Human**，选择宿主模型并完成首次设置。Desktop 使用应用自带的 Electron/Node 和 DSH 启动独立后台。以后在 Desktop 的插件管理中更新。

完全退出 Desktop 时，它启动的 Human 后台会一同退出。下次打开会恢复这次会话。需要全天在线时，可以让 Desktop 持续运行，或使用现有 Web 常驻方案。

**已有 Web Human 的用户**：Desktop 首次打开会创建自己的 Human。Web 继续使用 `DSH_HOME/become-human-manager`，Desktop 使用 `DSH_HOME/become-human-desktop/become-human-manager`。即使共用 DSH 数据根目录，各自的会话、运行锁及 IM 绑定也分别保存。无需移动 Web 的数据或解除微信绑定。直接将现有 Web Human 迁入 Desktop 的流程尚未提供。

## 1. 准备 DSH Web 与模型

在 PowerShell 中启动指定版本：

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

通过 DSH 设置 → 模型，配置可用的模型 API。Human 首次设置会列出兼容的现有模型，选择后自动保存，不必手工抄写 Provider ID 和 Model ID。选择和初始化不会额外发起模型测试调用；首次真正聊天或执行已开启的自主任务时才产生相应模型请求。

**原生 DeepSeek 兼容随 `0.7.0-beta.5` 测试包交付，完整新装流程仍待验收。** 当前支持以下两类来源：

| DSH 中的来源 | Human 的读取方式 |
| --- | --- |
| 原生 DeepSeek API Key | 读取 `llm-deepseek` 的 API Key 适配器配置，使用 `deepseek-official` 提供商；模型列表由当前 DSH 官方适配器解析，保留有效的模型覆盖 |
| 第三方 / 自定义 API | 继续读取 `llm-pi-ai.config.providers` 中兼容的提供商与模型 |

凭据使用 DSH 的 `apiKeyEnv` 引用；原生 DeepSeek 默认引用 `DEEPSEEK_API_KEY`。后台按 **宿主进程环境变量 → 源 `$DSH_HOME/.credentials.yaml` → 宿主启动项目的 `.env` → 源 `$DSH_HOME/.env`** 的顺序解析。凭据值仅供后台进程使用，不会回传首次设置页面，也不会写入首次设置记录或生成的 profile。全新 DSH 尚未配置 API 时，先在 DSH 模型设置中完成，再回 Human 点击“重新检查”。

当前未接入 DeepSeek 账号登录通道，不导入内联 `apiKey` 或任意自定义 `headers`。原生通道使用官方 Messages 协议，默认地址为 `https://api.deepseek.com/anthropic`；不要为它填写 OpenAI Chat Completions 地址。地址遵循官方适配器规则，可通过原生配置的 `baseURL` 或宿主启动环境的 `DEEPSEEK_BASE_URL` 指定，宿主已加载的 `.env` 也可提供该变量。后台沿用 Human 的准入、超时与取消控制，并将适配器自动重试次数设为 `0`，避免隐藏重试增加实际调用。模型配置字段见 [DSH 模型配置指南](https://deepseek-harness.github.io/deepseek-harness/guide/providers)。

**按发行包分别验收。** 10月28日的 beta.6 开发候选已在同机独立空目录完成真实官方模型发现、宿主进程凭据复用、后台启动和 Flash 请求；使用共享依赖缓存。这不能替代本页公开 beta.5 包或最终发行包的无缓存新装。剩余安装和凭据组合统一见[合并清单 D1/D2](TESTING_STATUS.md#merged-testing)，文件清单以对应 Release 包为准。目录中存在模型不等于凭据可用，后台能启动也不等于真实网络请求成功。

完成后关闭该次 DSH 进程，再安装组合包。默认 `$DSH_HOME` 是用户主目录下的 `.dsh`；如使用了自定义值，后续命令必须保持一致。

## 2. 获取安装包

### 从 npm 安装当前测试版

停止要更新的 DSH 服务后执行（与下方 `.tgz` 方式二选一）：

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add dsh-become-human-web@0.7.0-beta.45 --registry=https://registry.npmjs.org/
```

安装后直接进入第 4 步启动与配置，无需重复安装本地包。首次发布时镜像可能延迟，示例指定 npm 官方仓库。

<a id="使用预构建包推荐"></a>

### 使用预构建包

从 [v0.7.0-beta.45 Release](https://github.com/liangTc/dsh-become-human/releases/tag/v0.7.0-beta.45) 下载以下两个附件，并保存到同一目录：

- [dsh-become-human-web-0.7.0-beta.45.tgz](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.45/dsh-become-human-web-0.7.0-beta.45.tgz)
- [dsh-become-human-web-0.7.0-beta.45.tgz.sha256](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.45/dsh-become-human-web-0.7.0-beta.45.tgz.sha256)

在该目录打开 PowerShell，校验后再安装：

```powershell
$humanExpectedSha = ((Get-Content -LiteralPath './dsh-become-human-web-0.7.0-beta.45.tgz.sha256' -Raw).Trim() -split '\s+')[0]
$humanActualSha = (Get-FileHash -LiteralPath './dsh-become-human-web-0.7.0-beta.45.tgz' -Algorithm SHA256).Hash
if ($humanExpectedSha -notmatch '^[a-fA-F0-9]{64}$' -or $humanActualSha -ine $humanExpectedSha) {
  throw '安装包校验失败，请重新核对下载来源和文件。'
}
```

组合包包含 Web 插件、内部运行模块、构建产物、许可证与第三方声明。GitHub 自动生成的 Source code ZIP 与仓库源码缺少预构建 bundle，不能直接安装，也不能把源码 Git 地址当作预构建包来源。开发者需要先按下面步骤构建；发行方式见 [发布清单](PLUGIN_SUBMISSION.md)。

### 从源码构建

下载或克隆 [liangTc/dsh-become-human](https://github.com/liangTc/dsh-become-human) 的 `main` 分支，进入仓库根目录。远程分支与本地开发源码可能不同步；构建前核对所下载版本的 `package.json` 和变更记录，请使用与目标版本一致的源码或组合包。

```powershell
git clone --branch main --single-branch https://github.com/liangTc/dsh-become-human.git
cd dsh-become-human
npm install --prefix plugins/become-human-web
npm run build --prefix plugins/become-human-web
npm run release:package
```

构建所需的本地依赖由 `package.json` 声明，主构建重建 IM 和 Human Web 客户端，并把同仓库的运行模块复制到分发包中。产物为 `dist/packages/dsh-become-human-web-<版本>.tgz`；**以命令实际输出路径为准**。安装该包时，将下方示例文件名替换为实际生成的文件名。

定时规则产物随仓库提供，需要修改日历生成逻辑时，再按 [架构说明](ARCHITECTURE.md#开发与构建边界) 重新生成。`npm run release:source` 可另外导出干净源码，不会自动上传或发布。

以上命令构建开发分支，不承诺与公开 Release 相同的验收状态。若需复现历史 beta.5 源码，可将克隆分支改为 `v0.7.0-beta.5`。不要混用不同版本的安装包和校验文件。

可选行为包可以用 `npm run release:behaviors` 构建。产物为 `dsh-human-learning-0.2.1.tgz` 和 `dsh-human-experience-0.1.0.tgz` 及各自的 SHA-256 文件。校验后，在 **插件 → 安装与管理** 安装可信本地包。学习包从 0.2.0 起提供专属设置页，首次安装默认停用。需要学习时，分别启用该扩展和学习设置。包协议、信任边界和配置见[行为扩展 API](BEHAVIOR_API.md)。

## 3. 安装到 web profile

在安装包所在目录执行，文件名替换为实际文件名：

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ./dsh-become-human-web-0.7.0-beta.45.tgz
```

这是 DSH 官方组合包安装路径，会更新 profile 的依赖与 bundle 列表。不要用普通 `npm install` 代替 profile 注册，也不要只复制 `manager.mjs`。[官方打包与安装说明](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish) 说明了 `.tgz`、本地目录和 profile 的区别。

## 4. 启动并完成首次设置

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 web --no-open
```

打开终端打印的认证地址，进入左侧 Human 入口。认证链接等同访问凭据，不要贴到 issue、截图或公开日志中。新安装会显示首次设置向导：

1. **选择模型**：从宿主已有的兼容模型中选择，核对环境与凭据是否就绪。没有可用项时，先在 DSH 模型设置中补齐路由和凭据，再返回刷新。
2. **人物与额度**　选择人物和自主额度，填写称呼，确认时区与每天的安静时段。默认 22:00 至次日 08:00 暂停闲时自主循环。选好后在下一步核对，日后可在设置中修改。
3. **核对并创建**：检查选择后点击“创建并启动”。后台目录、内部 profile 和空闲回环端口自动准备，首次配置保存在插件管理的数据目录，无需编辑 YAML。

首次自主活动默认关闭。保持关闭时先开始主人对话，需要自主活动时再明确开启。当前开发版中启用自主活动不会同时开启学习；学习需要另外安装并启用学习行为包、开启其学习设置。公开 beta.5 的旧向导仍显示“同时开启自主学习和主动交流”，不要用它判断当前源码的行为。创建过程不通过额外模型请求测试 API，也不会自动完成手机绑定。

创建失败时查看页面错误提示后重试，重试沿用已创建的进度和唯一会话。已有运行数据或显式旧配置的安装会继续原会话、人物、额度和手机绑定，不会重新套用首次设置预设。

首次明确“创建并启动”与之后的冷启动不同：DSH 重启或运行模块重启后仍保持暂停，需核对状态后明确恢复；不会自动重试旧失败任务。关闭浏览器页面后，只要 DSH 服务仍在，Human 可以继续运行；停止 DSH 服务会一并停止它管理的后台。本次流程未增加后台常驻或登录自启入口。

手机连接在创建后按需配置。开源版不包含 WhatsApp 及其 GPL 依赖链，也不包含 QQ 的未授权扫码连接器；QQ 采用手动 AppID / AppSecret。列表中的 12 种聊天渠道实现与 Office 连接器不代表全部真实验收通过。**一个 Human 只能绑定一个有效 IM，更换渠道会替换旧绑定。**

## 高级配置

新安装可直接使用首次设置。需要指定已有运行目录、内部端口或模型路由时，可在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中覆盖 `become-human-manager`。**保留原有提供商、模型及其他插件配置**。

以下是可选的完整示例；无需为了新安装复制它：

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

各字段作用及界面中的自主额度与此处的区别，见 [配置说明](CONFIGURATION.md)。显式路径和模型配置继续用于已有安装；不要通过删除旧配置或移动数据目录强制重新进入首次设置。向导只管理 Human 自己的配置，不改写源 profile 的模型配置。

## 升级、停止与卸载

### 页面内更新（新增，本地开发版）

进入 **Human → 设置 → 版本与更新**，选择 Beta 并检查更新。仍可用本页的固定版本 CLI 命令原地升级。

- 固定读取官方 npm 的 `dsh-become-human-web`，核验 SHA-512、安装包身份、Node.js 与 DSH 版本兼容性。不会自动降级、覆盖同版本或执行任意下载地址。
- 下载校验完成后暂停 Human 后台，保留当前宿主 profile 的安装配置及锁文件，再使用 DSH 官方插件命令安装；不修改会话、记忆、人格、凭据或手机绑定。备份是安装恢复快照，不替代完整离线数据备份。
- 显示“安装完成，等待重启 DSH”后，保存其他会话的工作并重启当前 DSH 应用或原服务，然后刷新。DSH 更换已加载的插件包需要进程重启；刷新网页或只重启 Human 后台不等于升级生效。
- 新进程核对版本、原会话和渠道绑定后才显示完成；原本暂停仍暂停，模型保护暂停不自动清除，旧失败任务和未知投递不自动重试。
- 安装失败可点击“恢复更新前版本”，使用本地缓存和锁文件恢复；缓存缺失或 profile 被其他操作改动时停止自动恢复，保留错误供手动处理。已被 profile 引用的校验安装包保留在管理数据目录，不能在仍被引用时删除。
- 源码、外部链接和无法确认身份的安装显示手动更新提示。更新任务只处理 Human 包，不自动升级 DSH 或其他插件；管理器自己的更新接口不依赖模型调用。

以下命令行方式继续可用。

升级前先暂停 Human，等待当前工作结束，关闭管理端及其运行模块，备份数据，再按相同 `plugin --profile web add <新包.tgz>` 路径更新。首次升级后核对版本、唯一会话、绑定与待处理任务，按需手动恢复。不要用删除数据目录的方式解决启动问题。

卸载组合包可使用 DSH 插件页，或对应的 `dsh plugin --profile web remove dsh-become-human-web` 命令。卸载代码与删除私人数据是不同操作，数据需要在明确确认后另行处理。

离线备份工具要求两个服务均停止，并明确指定实际管理端口与运行端口。当前加密备份只支持**同一 Windows 账户、相同绝对目录**恢复，不能当作跨机器迁移方案。移动机器时应重新安装和配置凭据；可导出的人物或额度 JSON 不包含完整历史或绑定密钥。

## 常见问题

| 状态或错误 | 优先检查 |
| --- | --- |
| `UNSUPPORTED_DSH_VERSION` | 启动的 DSH 是否精确为 `0.2.0-rc.2` |
| `UNSUPPORTED_KEY_PLATFORM` | 当前完整运行模块依赖 Windows DPAPI |
| `MODEL_ROUTE_REQUIRES_SETUP` | 是否已在源 DSH 中配置兼容的模型；`beta.5` 支持原生 DeepSeek API Key 与第三方模型 |
| `MODEL_CREDENTIAL_REFERENCE_MISSING` / `MODEL_CREDENTIAL_MISSING` | 路由的 `apiKeyEnv` 引用及源凭据或环境变量是否可用；原生 DeepSeek 默认引用 `DEEPSEEK_API_KEY` |
| `SOURCE_NATIVE_MODEL_CONFIGURATION_INVALID` | 原生 DeepSeek API Key 配置是否包含不支持的内联密钥、headers 或无效模型字段；在 DSH 中修正后重新检查 |
| `SOURCE_NATIVE_ADAPTER_UNSUPPORTED` | 当前安装的 DSH 原生适配器合同是否兼容；使用本页指定的 DSH 版本 |
| `SOURCE_MODEL_ROUTE_CONFLICT` | 第三方 `llm-pi-ai` 提供商是否也使用了保留 ID `deepseek-official`；为第三方提供商换用其他 ID，并同步其默认模型选择 |
| `RUNTIME_PORT_ALREADY_IN_USE` | 内部端口是否已被其他进程占用；管理端不会接管陌生进程 |
| `INVALID_RUNTIME_HOME` / `LINKED_RUNTIME_HOME` | 是否使用不同的绝对路径，以及真实目录 |
| `WORKER_UNAVAILABLE` | 在数据与维护中查看运行状态与日志；确认问题后再手动恢复 |
| 微信显示已发送但手机未收到 | 区分本地回执、平台受理和真实实收；不要自动重发 `unknown` 投递 |
| 微信消息同步在线，但发送失败或显示 `-2` | 查看独立的发送健康与最近本人微信入站时间；参考窗口不保证发送。本人发送一条新微信消息后核对状态与新回执，不能仅据 `-2` 断言登录凭据失效 |

提交问题时提供脱敏版本、错误码、操作步骤和日志片段。不要提交数据库、认证链接、配对码或完整聊天记录。

## 本地 beta.25 的可选学习包

主包不再内置自动学习提供方。需要学习时，从本次本地构建的 dist/packages/dsh-human-learning-0.1.0.tgz 安装到 Human 的“工具与技能 → 行为扩展”，启用后再设置学习方式。该包默认停用，不创建第二会话、数据库或模型定时器，卸载不回退内置学习。无需学习可以不安装。

这是本地测试构建，还没有发布对应公开下载链接；不要把 beta.5 公开 Release 当作已包含此功能。
