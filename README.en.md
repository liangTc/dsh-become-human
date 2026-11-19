<p align="center">

  <img src="docs/assets/banner-pixel.png" alt="Become Human pixel art banner: a single-session autonomous agent for DSH" width="100%">
</p>

# Become Human

**A persistent personality. An extensible capacity to act.**

A digital companion living in DSH: remembering shared experiences, developing its own tendencies, choosing actions in an event loop, and gaining capabilities through plugins.

> **Test release `0.7.0-beta.41` · Work in progress.** [GitHub Release](https://github.com/liangTc/dsh-become-human/releases/tag/v0.7.0-beta.41) · [npm package](https://www.npmjs.com/package/dsh-become-human-web/v/0.7.0-beta.41) · [Verification scope](docs/RELEASE_BETA41.md)

[简体中文](README.md) · [Installation](docs/INSTALLATION.md) · [Usage](docs/USAGE.md) · [Configuration](docs/CONFIGURATION.md) · [Testing status](docs/TESTING_STATUS.md) · [Architecture](docs/ARCHITECTURE.md)

> [!WARNING]
> **Test release · Development is incomplete.** The current public test release is `0.7.0-beta.41` (GitHub Prerelease). Windows, Node.js 24+, and DSH `0.2.0-rc.2` are required. Complete acceptance and long-running reliability remain unverified, including the fresh-DSH native DeepSeek flow; see [testing status](docs/TESTING_STATUS.md).

The 0.7.0-beta.41 prerelease fixes duplicate replies after an explicit retry, conversation memory, rolling budgets, extension recovery and daylight-saving handling for quiet hours.

| Version | Availability and status |
| --- | --- |
| `0.7.0-beta.41` | Current test release on npm and GitHub. The upgrade from beta.40 was checked with the DSH CLI and Chrome. |
| `0.7.0-beta.40` | Published test release with local builds, upgrades and limited real-model/Web checks; available as a GitHub Prerelease and npm package |
| `0.7.0-beta.5` | Historical test release, with a prebuilt bundle and SHA-256 file; see installation below |
| `0.7.0-beta.4` | Historical test release; its package does not include beta.5 additions |

**New in beta.40:** a dedicated plugin center with plugin-owned settings and React pages; `humanPlugins` v1 lifecycle hooks, managed timers and unified registrations. Optional learning 0.2.0 moves its settings and notes into its own page. Existing session and channel data are retained. See [the plugin contract](docs/PLUGIN_LIFECYCLE.md) and [release notes](docs/RELEASE_BETA40.md).

## What it does

Become Human adds an event loop to a persistent DSH conversation. It uses **the current persona → valid memories, feedback, and goals → model choice** to decide whether to wait, check in, chat, or use an enabled capability. Goals and learning are optional activities, not a fixed identity or a mandatory task list.

DSH Web is the management surface. A paired phone is another channel into the same conversation. Persona configuration guides expression and topic selection; code handles scheduling, budgets, execution boundaries, and records. This project explores persistent, contextual agent behavior. It does not claim consciousness, genuine emotions, or verified long-term personality development.

## Personality that persists across experiences

The configured persona is a starting point. Relationships, valid memories, current concerns and recorded outcomes inform later choices within the same main session.

- **Personal choices:** agree, negotiate, decline or reconsider ordinary requests. Relationship state influences choices without granting tool permissions.
- **Continuity:** recent dialogue, rolling summaries and long-term memory preserve context, with separate attribution for user statements, execution facts and model inferences.
- **Traceable growth:** optional personality development can add interests, dispositions and habits when its evidence requirements are met. It is off by default; changes can be inspected and retracted. Base identity, relationship settings and permissions remain user-managed.
- **Changing priorities:** take on a goal, attend to a concern or wait. A fixed profession and an endless task list are not required.

## Capabilities that extend the same personality

Extensions share the existing event loop, context and execution records instead of creating another conversational identity.

| Extension point | Contribution |
| --- | --- |
| Events and behavior packs | New signals, actionable opportunities, execution methods and outcome feedback through `humanEvents` and `humanBehaviors` |
| Tools | MCP services and authorized DSH session collaboration through scoped capability calls |
| Skills | Task methods and conversational guidance; no implicit permission grants |
| Pages and backend methods | Custom React or declarative pages inside Human, with declared backend read/write interfaces |

Learning is one optional behavior pack, disabled by default. Chat and report handling still include internal compatibility paths; not every built-in flow is independently packaged. Third-party extensions must implement Human's contracts, and installed code is trusted local code rather than sandboxed code.

[Behavior contracts and examples](docs/BEHAVIOR_API.md) · [Extension pages](docs/EXTENSION_PAGES.md) · [Architecture](docs/ARCHITECTURE.md)

The loop is **events → opportunities → persona-informed choice or wait → execution → recorded outcomes → usable experience → the next choice**. Reflection and personality development have separate evidence checks: an action succeeding does not prove that a personality has grown.

## Supporting capabilities

| Area | Current implementation |
| --- | --- |
| Conversation | Complete turns, rolling summaries, memory recall, input batching, short replies, message bubbles, proactive chat and unanswered-message backoff; images with confirmed vision models |
| Memory and growth | Evidence-linked records, revision, forgetting, hot/cold tiers and optional reversible personality development |
| Autonomous action | Event and timer checks, attention, model choice, waiting, checkpoints and outcome feedback |
| Tasks and artifacts | Goals, substeps, schedules, task board, reviews, approved managed file output and receipts |
| Visibility and cost | Activity timeline, event logs, autonomous budgets and usage by time window, work category and model |
| Channels and models | Web plus one active IM binding share the main session; host credential references for model setup |
| Extensions | Behavior packs, Skills, MCP, authorized DSH sessions, custom pages and backend methods; installation, configuration, enable/disable, upgrade and removal |

DSH session writes are disabled by default and require scoped configuration and per-operation approval. Cancellation targets the specific turn returned by a session read and rejects stale requests after the task changes. Human does not provide browser tab or window control. Text Skills provide guidance; they do not grant arbitrary code execution or operating-system access.

[Shared matters and reviews in the task board](docs/CHARACTER_BOARD.md) use the existing main session, IM binding, and execution lane. Manual focus does not start the driver; recording a goal or commitment does not dispatch it. Accepting a review does not grant permissions or retry failed work. The view shows concise intentions and evidence, not raw chain of thought or proof of consciousness. Implementation and verified quality are separate; see [testing status](docs/TESTING_STATUS.md).

### beta.12–beta.28 development progress

Recent development separates business behaviors from the core loop:

- **Core loop:** validate current events and candidates before choosing work on one execution lane. Persist terminal outcomes with feedback work; recover feedback without replaying external actions. Experiences, method effectiveness and personality drift retain separate evidence requirements.
- **Optional behavior packs:** `dsh-human-learning` is no longer a default responsibility and remains disabled after installation. `dsh-human-experience` can take over experience reviews. Public event sources include RSS, Atom and JSON Feed. See the [extension API](docs/BEHAVIOR_API.md).
- **Extension management:** install trusted local or published package sources and manage configuration, enablement, upgrades and removal in Web. Local lifecycle checks cover configuration-preserving upgrades and failed-upgrade recovery; arbitrary third-party packages, public/authenticated registries, missing caches and interrupted recovery remain unverified. Text Skills and executable extensions are separate.
- **Conversation and memory:** complete turns, rolling summaries and long-term memory preserve continuity. Fixes cover corrections, speaker attribution and independent protocol/semantic repair opportunities. Contextual review targets irrelevant defensive remarks, process explanations, pressure and unsupported experiences while preserving disagreement and necessary explanations. At most one protocol repair and one semantic repair, three drafts in total; no separate polishing stage.

beta.28 has 65 isolated dialogue checks, eight final real-model review cases and four final Web replies, including a draft rejected for unnecessary commentary and rewritten by the model before publication. Earlier local extension lifecycle and limited restart checks do not establish general conversation quality, long-term memory, personality growth or arbitrary extension compatibility. Failures remain documented in the [changelog](CHANGELOG.md) and [test record](docs/TESTING_STATUS.md). Learning quality remains a separate [optional activity](docs/LEARNING_AND_CONVERSATION.md), rather than the main measure of the core's progress.

## Architecture

<img src="docs/assets/architecture-pixel.svg" alt="Pixel art architecture: DSH Web and IM connect to a manager plugin and an isolated Human runtime" width="100%">

A manager bundle integrates with DSH Web. A separate runtime process owns the Human loop and data. The outer bundle does not replace the ordinary DSH agent factory. The private runtime profile supplies its own persistence and restricted tool configuration. **Do not install the internal runtime package directly into your regular profile.**

### One main session, one IM channel

- Each Human has one persistent main session. Temporary task contexts do not become independent personas or conversation entry points.
- Web and phone share messages, memory, and tasks. Owner input takes priority over background work.
- **A Human can bind one active IM channel. Changing the channel replaces the previous binding.**
- Other DSH sessions remain external sources or action targets, accessed only within an explicit scope.

## Quick start

Install the current test release into DSH Web:

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add dsh-become-human-web@0.7.0-beta.41 --registry=https://registry.npmjs.org/
```

To install from a downloaded tarball, use the matching release files:

Use the prebuilt bundle from the [v0.7.0-beta.41 prerelease](https://github.com/liangTc/dsh-become-human/releases/tag/v0.7.0-beta.41). One `.tgz` installs both the Web plugin and its bundled runtime:

1. Download the [installation package](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.41/dsh-become-human-web-0.7.0-beta.41.tgz) and its [SHA-256 file](https://github.com/liangTc/dsh-become-human/releases/download/v0.7.0-beta.41/dsh-become-human-web-0.7.0-beta.41.tgz.sha256).
2. Verify the checksum as described in the [installation guide](docs/INSTALLATION.md#使用预构建包推荐), then run this from your download directory:

```powershell
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ./dsh-become-human-web-0.7.0-beta.41.tgz
```

The current npm package is beta.41; the tarball above contains the same plugin. The Git repository and GitHub source ZIP omit generated bundles and cannot be installed directly as a prebuilt plugin. Developers can [build a `.tgz` from source](docs/INSTALLATION.md#从源码构建). The detailed guides are currently in Chinese.

**Known beta.5 fresh-install issue:** initial Human creation can fail because of initialization order. The fix is in beta.6 development source, and is included in this release. Read the [testing status](docs/TESTING_STATUS.md) before installing; existing-install upgrade checks do not establish clean-install success.

Start DSH, open Human, and follow **existing model → persona and budget → create and start**. The plugin prepares its data directory, private profile, and available loopback port automatically. No separate runtime installation or YAML editing is required for a fresh setup. `beta.5` supports `llm-pi-ai` routes and DSH's native DeepSeek API Key adapter. Both resolve `apiKeyEnv` credential references without returning secrets to the browser. DeepSeek account authentication, inline keys, and arbitrary headers are not supported. See [model configuration](docs/CONFIGURATION.md#进程与模型配置).

**Native adapter validation:** the public beta.5 release retains its original acceptance scope. On October 28, a beta.6 development candidate passed real official model discovery, host-process credential reuse, background startup, and Flash requests in a separate empty directory on the same machine. This used shared dependency caches; it does not establish clean-machine success or retroactively validate beta.5. Uncached installation of the final release artifact, credential-priority combinations, and additional reasoning settings are tracked under [merged tests D1/D2](docs/TESTING_STATUS.md#merged-testing).

Choose a persona, low/medium/high budget, optional owner name, and timezone. Autonomous behavior is off by default. In beta.28, enabling it does not also enable learning: install and enable the learning pack, then configure learning separately. The public beta.5 wizard retains its historical options. Phone binding is optional afterward. Existing installations retain their session, configuration, and binding; cold starts remain paused until explicitly resumed. The runtime follows the DSH service lifecycle; this change does not add a resident service. See [configuration](docs/CONFIGURATION.md) and [usage](docs/USAGE.md).

## IM scope

The open-source distribution retains **12 chat channel implementations and one Office connector**:

WeChat, Feishu / Lark, DingTalk, WeCom, WeCom App, QQ, Slack, Telegram, Discord, iMessage, Email, and Matrix; plus AI Office.

**An adapter is not a claim of full real-world validation.** WeChat has undergone device workflow checks; other channels depend on account setup, network access, platform permissions, and runtime support. iMessage requires macOS, while the complete Human runtime currently requires Windows, so it is not usable out of the box in this release.

The open-source release excludes WhatsApp and its GPL dependency chain. It also excludes the QQ QR-code connector without an open-source distribution grant; QQ uses manual AppID / AppSecret setup. Channel code is derived from [dsh-im](https://github.com/xmanrui/dsh-im); see [third-party notices](THIRD_PARTY_NOTICES.md).

## Budgets and operating limits

- Autonomous work can be limited by tokens, requests, rounds, and time per round. Owner conversations have separate accounting and still incur provider charges.
- Local admission estimates are not a provider-enforced spending cap. Sleep, process exit, network failures, model rate limits, and IM session expiry affect availability.
- Public searches can fail or return insufficient evidence. A plan is not a completed result; a delivery receipt is not proof of phone receipt.
- Review write previews. An `unknown` result requires checking the external state before any retry.
- Data is stored locally, but configured model, search, and IM services receive necessary content. Never publish authentication links, credentials, databases, or private conversations.
- Windows DPAPI protects local keys. Encrypted backups currently require the same Windows account and absolute data paths; they are not a cross-machine migration solution.

## Incomplete areas

This remains a test release. Complete clean-install, multiple-plugin, multiple-channel, long-duration, personality-feedback, and external-action acceptance is unfinished. Generic tools support manual and bounded foreground calls; the autonomous selector does not yet plan arbitrary registered tools. An arbitrary MCP server installer, Codex executor, and native desktop window control are not provided.

“Online” means the running process can respond and check for autonomous work, not a 24-hour uptime guarantee. The timeline shows behavior summaries and evidence rather than private model reasoning. See [current boundaries](docs/ARCHITECTURE.md#当前交付边界).

## Documentation and contribution

- [Installation and upgrades](docs/INSTALLATION.md)
- [Configuration](docs/CONFIGURATION.md)
- [Usage and phone commands](docs/USAGE.md)
- [Shared matters and outcome reviews](docs/CHARACTER_BOARD.md)
- [Testing status and pending acceptance](docs/TESTING_STATUS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Releases, community registration, and plugin markets](docs/PLUGIN_SUBMISSION.md)
- [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), [Changelog](CHANGELOG.md)

This project is being submitted as an Agent capability in the single-plugin category of the community [DSH Plugin Radar register](https://github.com/AdamPlatin123/dsh-plugin-radar/blob/main/PLUGINS.md). Inclusion is not claimed before the upstream change is merged. Community registration, independent runtime validation, and DSH custom market indexes are separate processes; none implies official endorsement. See the [submission guide](docs/PLUGIN_SUBMISSION.md) and [official market guide](https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market).

## Credits and license

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): plugin host, model and session services, and calendar rules.
- [dsh-im](https://github.com/xmanrui/dsh-im): the principal upstream for IM channel and setup code.
- [Humanizer](https://github.com/blader/humanizer): expression guidance and the basis for a Chinese conversation adaptation.

Original code and documentation are licensed under the **[Apache License 2.0](LICENSE)**. Third-party code, Skills, icons, and dependencies retain their respective licenses; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This is an independent project; upstream names and trademarks identify compatibility or origin, not endorsement.
