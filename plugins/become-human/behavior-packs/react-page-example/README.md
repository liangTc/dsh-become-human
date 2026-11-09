# Human React 页面示例（测试版）

需要 Become Human 0.7.0-beta.38 或更高版本。示范通过 DSH 模块加载器和 React 插槽挂载页面，并调用本扩展的后台方法；不创建新的 Human 会话。

在 Human「设置 → 扩展安装」上传 `dsh-human-react-page-example-0.1.0.tgz`，核对安装预览并确认信任来源。安装完成后在「扩展」打开「交互页面示例」。读取计数无需确认；增加计数会显示一次写入确认。取消不修改计数，刷新页面保留计数。

示例只写入当前独立运行环境 `DSH_HOME/become-human/react-page-example/counter.json`。卸载代码不会自动删除该文件。错误、超时和页面异常按钮用于开发验证，不会调用模型、发送手机消息或更改 Human 记忆。

在项目工作区执行 `node plugins/become-human/behavior-packs/react-page-example/build.mjs` 生成 `client.js`，再执行 `node scripts/package-behavior-packs.mjs` 打包。页面使用宿主提供的 React，不捆绑第二份 React。外部依赖需自行打包；不要在浏览器包中放凭据。

这是可信插件扩展机制，不是运行恶意代码的隔离容器。只安装可信代码。页面使用 Shadow DOM 隔离普通样式，错误边界限制渲染故障；代码仍与宿主同源。后台处理器必须检查输入并响应 AbortSignal；超时不代表外部副作用已撤销，结果不明的写入不会自动重试。

协议与使用方式见项目 `docs/EXTENSION_PAGES.md`。Apache-2.0。
