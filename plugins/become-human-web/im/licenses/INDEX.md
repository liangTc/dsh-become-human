# IM 构建依赖许可证

本目录保留实际发行构建内 50 个第三方 npm 包版本的完整许可证正文、版权及摘要。清单按 Host/Client 实际构建输入生成，不把上层 SDK 的许可替代为传递依赖许可。

- [完整许可证合辑](BUNDLED-DEPENDENCIES.txt)
- [包版本、许可证与正文摘要](BUNDLED-DEPENDENCIES.json)
- [构建来源清单](../BUILD-MANIFEST.json)
- [腾讯 openclaw-weixin MIT](OPENCLAW-WEIXIN-MIT.txt)
- [DingTalk connector MIT](DINGTALK-CONNECTOR-MIT.txt)
- [Simple Icons CC0](SIMPLE-ICONS-CC0.txt)
- [Proxy agents MIT](PROXY-AGENTS-MIT.txt)

缺少包内许可证全文的 agent-base / https-proxy-agent 使用已保留的官方 proxy-agents MIT 文本，来源与摘要见 [SOURCES.json](SOURCES.json)。WhatsApp/Baileys、libsignal 和 whatsapp-rust-bridge 不属于此发行构建。外部安装依赖保留各包自己的许可证。

在完成 IM 构建后，从仓库根运行 `node scripts/collect-third-party.mjs` 重新生成；可额外传入另一个 Web 构建目录。脚本发现未审核许可、GPL 或无许可源码时拒绝生成。
