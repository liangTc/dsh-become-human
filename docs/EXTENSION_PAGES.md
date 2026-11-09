# Human 扩展页面（测试版 v1 / v2）

从 `0.7.0-beta.37` 起，安装到独立后台的扩展可通过声明注册 Human 内页面。Human 本身仍通过 DSH 的 `sidebar.panellist` 和 `main` slots 接入宿主；此接口不修改宿主插件列表。

## 安装与使用

1. 打开“设置 → 更多设置 → 工具与技能 → 行为扩展”。
2. 填写明确版本的包名，或选择本机 `.tgz` 安装包（上传最多 5 MB；服务器本地路径仍支持原有安装方式）。选择文件只上传并检查，不会直接安装。
3. 确认信任后点击“安装并应用”。安装成功后，顶部“扩展”出现扩展提供的页面。
4. 停用页面所属节点会隐藏入口；重新启用恢复；移除包清除页面注册，聊天和历史数据保留。已打开的失效页面显示状态提示，不保留过期页面内容。

扩展依然属于本机可信代码。v1 声明式页面不执行脚本或 HTML；v2 可运行打包的 React 页面并访问本扩展声明的后台方法。安装失败沿用已有恢复流程，不能把失败状态自动当作可继续运行。

## 声明格式

在包的 `package.json` 中加入：

```json
{
  "dsh": {
    "bundle": {"patch": "./cordis.patch.yml"},
    "human": {
      "pages": [{
        "version": 1,
        "id": "overview",
        "nodeId": "human-extension.example",
        "title": "我的扩展",
        "description": "扩展的用途与当前状态。",
        "blocks": [
          {"type": "text", "text": "使用说明"},
          {"type": "list", "items": ["第一项", "第二项"]},
          {"type": "runtime-status"}
        ]
      }]
    }
  }
}
```

`nodeId` 必须属于本包的 bundle 节点。页面使用 `包名:页面 id` 命名空间；每包最多 8 页，每页最多 24 块。未知块类型、重复 ID、越界节点和超限声明会被拒绝。`runtime-status` 只展示当前人物名称与运行状态，不返回聊天、凭据或其他会话。

示例源码：[page-example](../plugins/become-human/behavior-packs/page-example/README.md)。运行 `npm run release:behaviors` 会生成独立示例安装包；它不会自动安装到用户环境。

## v2 自定义 React 页面与后台接口

从 `0.7.0-beta.38` 起可使用 v2。v1 说明页兼容保留。包通过 DSH bundle 安装到 Human 独立运行环境；管理端加载器复用 DSH 的 `ctx.modules`、`window.__ModuleLoader__` 和 `ctx.slots`，在 Human 所属的子插槽中挂载页面。设计依据：[DSH slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.md)。这不是替代 DSH 的全局前端插件 API；入口仍位于 Human 内。

```json
{"dsh":{"human":{"pages":[{
  "version":2,"id":"counter","nodeId":"human-extension.my-example",
  "title":"计数器","client":"./client.js",
  "methods":[
    {"name":"counter.read","mode":"read","description":"读取本扩展计数"},
    {"name":"counter.add","mode":"write","description":"本扩展计数增加一次"}
  ]
}]}}}
```

后台 Cordis 插件声明 `inject=['humanPages']`，检查 `ctx.humanPages.contractVersion===2`，用 `ctx.effect(()=>ctx.humanPages.register(包名,页面ID,handlers))` 注册。每个 handler 是 `{mode:'read'|'write', handle:async(payload,call)=>JSON值}`；`call` 含当前 `sessionId`、`requestId` 与 `signal`。注册名、方法模式必须与安装清单一致，后台未实际注册会导致安装验证失败并进入恢复流程。重复注册不能覆盖原处理器。

浏览器入口为打包后的 CommonJS，导出 `contractVersion=2` 与默认 React 函数组件。组件通过 `human` prop 获取 `sessionId`、`signal` 和 `await human.call(method,payload)`。使用宿主提供的 `react` / `react-dom`；构建时将这两项 external，其余依赖打入包内。v2 每页要求 1–24 个已声明方法，单客户端文件最多 1 MiB，包仍受安装上传总大小限制。

完整可安装示例：[React 计数器](../plugins/become-human/behavior-packs/react-page-example/README.md)。代码包括构建、注册、输入检查、持久化、取消与错误展示。示例构建后执行 `npm run release:behaviors` 生成 `.tgz`，不会自动安装。

### 调用、确认与生命周期

- 读取经已有宿主登录验证，写入通过 Human 确认面板展示方法说明与完整参数。确认票据绑定页面版本、当前会话、方法、参数和请求 ID，60 秒有效；读取入口不能执行写方法。
- 仅路由当前包页面明确声明的方法，不提供任意 URL 代理、SQL 或任意后台函数。输入/输出为 JSON，各最多 32 KiB；每个后台最多 8 个未结束调用，10 秒超时。扩展应响应 `signal`，避免遗留工作。
- 写入请求在当前会话账本记录执行状态。相同请求 ID 的已完成写入返回已记录结果；超时、崩溃或结果不明的请求不会自动重放。该机制不承诺外部服务恰好执行一次，扩展仍须使用外部服务的幂等键并提供结果查询。
- 关闭页面清理 React 插槽、页面信号和模块缓存。停用、卸载或后台重启会撤销注册并中止处理器信号；配置、客户端内容或注册代次变化使旧页面调用失效。正在执行的非协作代码可能继续运行，但旧结果不会再次交给页面。
- 页面使用 Shadow DOM 隔离普通样式，并设置 React 错误边界。模块加载、调用或渲染失败可在扩展页显示错误，用户仍可访问 Human 其他页面。

### 信任边界

**只安装可信插件。** 自定义 JavaScript 与宿主同源，后台插件在独立运行进程内执行；Shadow DOM、声明方法和确认面板是正常插件的接口约束，不是恶意代码沙箱。不能保证恶意扩展无法访问宿主网页或自行使用进程权限。扩展不得在客户端包中放密钥，也不应将敏感数据写入通用审计日志。关闭页面、超时或卸载不等于已发生的外部副作用回滚。

## 页面与设置体验

Human 主页面、设置分类、工具/记忆子分类和日志分类使用地址参数保存位置，刷新和浏览器返回可恢复；未保存草稿仍要求确认。任务提供近 24 小时快捷筛选，历史失败不删除；统计首页优先显示实际报告用量，预算占额折叠在详情。

普通配置在空闲时保存：原本运行的连续模式会临时暂停并在保存成功后恢复，原本暂停的仍暂停，自主保护暂停不会被清除。正在执行时提示稍后保存；保存失败或状态变化时保持暂停并提示核对。权限变更、数据撤回等不在普通配置白名单内，仍遵守原有显式授权与暂停规则。
