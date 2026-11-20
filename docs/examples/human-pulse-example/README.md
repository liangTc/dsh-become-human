# 节拍观察

用于 Become Human 插件开发手册的一次性定时行为示例。开发基线为 Human 0.7.0-beta.43，使用 `humanPlugins` v1 和声明式页面 v1。包内没有第三方依赖。

在本目录执行 `npm pack --ignore-scripts`，到 Human → 插件 → 安装与管理，选择生成的 `.tgz` 并安装。打开「节拍观察」即可验证页面注册。在自主开启、宿主运行且处于活动时段时，一次性计划将在到期后提供行动机会；模型可以等待。查看日志以区分定时触发、模型选中和实际完成。

在测试人物中开发。制作自己的插件时，同时更改包名、代码中的 owner、bundle 节点以及页面的 nodeId。[在线开发手册](https://liangtc.github.io/dsh-become-human/)
