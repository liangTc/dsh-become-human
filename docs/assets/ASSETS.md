# 项目配图

所有公开展示素材使用像素风，并标注测试版状态。它们是项目宣传或结构示意，不是运行截图。

| 文件 | 用途 | 来源 |
| --- | --- | --- |
| banner-pixel.png | GitHub 首页横幅，带 Beta / Work in progress 标记 | imagegen 内置工具生成 |
| avatar-pixel-mature.png | 原始头像设计稿，保留作参考 | imagegen 内置工具，参考 banner-pixel.png 生成 |
| avatar-pixel-transparent.png | 早期透明抠图稿，顶部裁切问题由 complete 版替代 | imagegen 内置工具移除原始头像背景 |
| icon-pixel.svg | 插件与项目图标 | 项目原创可编辑 SVG |
| personality-extension-pixel.svg | 持续人格、事件循环、成长反馈与扩展入口 | 项目原创可编辑 SVG |
| architecture-pixel.svg | 宿主管理、独立运行与唯一会话的部署结构 | 项目原创可编辑 SVG |
| capabilities-pixel.svg | 功能概览 | 项目原创可编辑 SVG |

## 视觉方向与参考

2026-10-22 更新：参考《底特律：化身为人》的冷色近未来氛围及 [Steam 商店头图](https://store.steampowered.com/app/1222140/Detroit_Become_Human/)的电影海报式构图，转译为项目自己的像素视觉。

横幅以原创仿生人肖像、雨夜城市与像素消散表现陪伴、记忆和成长；图表使用深午夜蓝、冰青色、冷白及阶梯状边框，保持文字与流程可读。主标题为 Become Human，始终保留 BETA / WORK IN PROGRESS。

本目录原创素材随项目采用 Apache-2.0。游戏名称及商标归各自权利人所有；参考不表示该游戏、Quantic Dream、Sony 或 DeepSeek 对本项目的授权或背书。本目录不分发游戏原画、游戏标志或游戏截图。上游 IM 运行所需图标的来源及许可另见第三方声明。

## Banner 生成提示词

2026-11-17 头像调整：使用成熟的仿生人肖像、短黑发、冰蓝轮廓光和面部细电路线，替换早期偏幼态的机器人方案。头像是产品视觉，不向人物配置或模型提示词注入固定姓名、性别、关系或性格。侧栏的新消息角标是独立界面状态。

头像生成方式：内置 imagegen；不透明 PNG；参考文件 `banner-pixel.png`。提示词核心：`Use the supplied banner as the direct visual reference. One square close-up adult android portrait, short layered black hair, natural adult proportions, thoughtful eyes, thin cyan temple and cheek circuit seam, charcoal high collar. Mature cinematic pixel art, dark navy background, icy blue rim light, stepped edges and selective dithering. No cute mascot, chibi, toy robot, antenna, text or interface.`

生成方式：内置 imagegen；不透明 PNG；项目文件为 `banner-pixel.png`。

```text
Use case: ads-marketing
Asset type: production GitHub project banner for "Become Human", a DSH autonomous companion plugin. Ultra-wide 3:1 landscape banner, around 2048 x 683.
Primary request: redesign the project artwork in the cinematic near-future mood and Steam store capsule composition associated with Detroit: Become Human, interpreted as sophisticated detailed PIXEL ART. Use original characters and the project's own title.
Subject and composition: an original young adult female android portrait in three-quarter view dominates the right half, thoughtful restrained expression, short dark hair, graphite high-collar clothing, subtle cyan illuminated facial seam and a few square pixels dissolving from the far edge. A faint second/profile silhouette may suggest memory behind her but preserve ONE principal subject. A rain-lit futuristic city and delicate branching data lines recede into the background. Left half is spacious dark negative space for a very large project title, with a tiny square cyan emblem. Cinematic key art, editorial hierarchy, striking at GitHub README width.
Style/medium: unmistakable premium pixel art, carefully placed crisp square pixel clusters, stepped silhouettes, limited controlled palette, hand-dithered shading, dense high-quality pixel detail; no smooth vector art, no painted/photographic realism. Not chibi, not cozy, no desk, coffee cup or memory tree.
Lighting and palette: deep midnight black/navy, steel blue, ice cyan, cool white, dramatic rim lighting, subtle digital fragmentation and rain. Restrained cold science-fiction atmosphere with human emotion.
Text, verbatim, clean legible typography on the left:
"BECOME"
"HUMAN"
Small subtitle: "ONE SESSION. A GROWING PRESENCE."
Small footer: "Autonomous companion for DSH"
Prominent small outlined status panel at upper left: "BETA / WORK IN PROGRESS"
The project title must be the largest type, white tall condensed geometric sans with subtle pixel-stepped edges. All text fully in frame and spelled correctly. No other text, official game title or game logos, actor likenesses, watermarks, screenshots, Steam logo or UI. Keep the original project name and the beta label readable. Opaque background.
```

透明版生成：内置 imagegen 编辑原始头像，transparent_background=true。提示词：Remove only the navy background; preserve the mature pixel android portrait and opaque hair and jacket. True RGBA alpha transparency outside the silhouette; no rectangular tile, matte, shadow or painted checkerboard. 页面不再添加圆角裁切或底板。

当前头像为 `avatar-pixel-complete.png`：imagegen 内置工具编辑透明原图，补全头顶并缩小构图，头发及肩部均完整落在画布内。提示词核心：Reconstruct the complete crown; zoom out with transparent air above and on both sides; preserve mature pixel android identity; no subject touches canvas edges. True RGBA transparency.
