# Human 插件与生命周期（测试版）

Human 保留一个人物、一个主会话和一条执行线。插件增加可选择的行为、外部事件、工具、定时活动和自己的页面；人格、记忆、额度、主动联系与操作授权仍由 Human 统一管理。

本合同自 Human beta.40 提供；学习包 0.2.0 需要该版本或后续兼容版本。beta.39 不包含本合同。

## 用户入口

顶部 **插件** 为固定入口。左侧是安装与管理、已安装插件，右侧显示该插件的启停操作和自行注册的页面。插件没有页面时仍能提供行为或工具。设置只保留 Human 的全局设置，资料保留共用记忆与成长记录。

探索与学习包 `dsh-human-learning@0.2.0` 将学习方式、搜索服务、关注来源、学习检查间隔、学习笔记、人工批注与反馈放在自己的 React 页面中。读取原有设置和笔记，不创建新会话，不迁移或清空历史数据。未安装或停用时不执行学习和主动分享，已有记录仍保留；重新启用后可继续查阅。

## 注册合同

DSH 插件注入 `humanPlugins`，合同版本为 1。沿用 DSH bundle 安装和 Cordis effect 清理机制。

```js
export const inject = ['humanPlugins'];
export function apply(ctx) {
  ctx.effect(() => {
    const plugin = ctx.humanPlugins.register('your-package-name', {
      version: 1,
      title: '插件显示名称',
      description: '说明为 Human 提供什么能力',
      events: [{id: 'changed', descriptor: eventDescriptor}],
      behaviors: [{id: 'inspect', descriptor: behaviorDescriptor}],
      pages: [{id: 'settings', handlers: pageHandlers}],
      schedules: [{
        id: 'periodic', title: '定期考虑查看内容',
        source: 'changed', payload: {topic: '当前关注方向'},
        rule: {kind: 'every', seconds: 3600},
      }],
      hooks: {
        result(event, {state, now}) {
          return {state: {...state, lastResultAt: now}};
        },
      },
    });
    return () => plugin.dispose();
  });
}
```

此例为合同片段，不新增任何业务插件。完整可运行实现见 `plugins/become-human/behavior-packs/learning`。

注册表支持 `events`、`behaviors`、`capabilities`、`sources`、`pages`、`schedules`、`hooks`。前四种沿用既有服务的 descriptor；`pages` 沿用 React 页面 v2 接口及精确写操作确认。资源名由核心按包名生成，跨包同名不会冲突，可用 `humanPlugins.resourceId(packageName, localId)` 获取。注册失败撤销已注册资源；停用清理所有资源和页面请求，历史任务、笔记、定时记录不删除。

React 页面可使用 `human.setDirty(boolean)` 接入统一草稿保护，使用 `human.navigate(action)` 切换自己的子页面；`human.call(method, payload, reviewText)` 的第三项可提供面向用户的写入摘要。确认票据仍绑定实际接口与完整 payload，摘要不能扩大授权。

页面仍需在 package.json 的 `dsh.human.pages` 声明 client、所属 node、read/write 方法；另加 `dsh.human.plugin: {version: 1, title: '显示名称'}`，安装器会核对实际注册是否与启停状态一致。旧版独立注册服务继续兼容。

`learning` 字段是旧持久化任务的迁移适配器，仅用于现有学习包。新业务使用通用 `behaviors`，不要增加核心特判或新的特殊 workflow 字段。

## 生命周期如何参与

| 回调 | 输入 | 可以贡献什么 |
| --- | --- | --- |
| input | 已提交的用户输入事件元数据 | 发布后续关注事件 |
| selection | 本轮选择机会 | 发布可供本轮选择的事件 |
| result | 已完成、失败或取消的任务元数据 | 记录插件进度、发布后续行动机会 |
| feedback | 用户笔记反馈、批注、实际追问记录 | 调整插件自己的关注状态 |
| memory | 记忆保存、修订等事件元数据 | 重新考虑已有关注事项 |
| growth | 人格偏移应用或撤回等元数据 | 更新插件自己的适配状态 |
| delivery | 回复已写入主会话 | 更新交流进度；不等于手机实收 |

回调是同步本地计算，不允许返回 Promise，不用于网络、模型或外部写入。输出只能是 `{state?, events?}`，不超过 16 KiB、最多 8 个事件；事件必须属于插件自己注册的来源并符合 schema。持久状态按人物与插件隔离。回调拿到事件索引与结果元数据，不自动获得完整聊天、记忆正文或凭据。

审计事件按持久游标处理，第一次安装从当下开始；重启不重放已处理事件。回调失败回滚本次本地贡献，并在本次加载期间停止该回调，其他插件和 Human 可继续运行。异常会显示在插件参与环节中，排错使用导出日志。所有插件均为受信任本机代码，此合同是执行约束，不是恶意代码安全沙箱。

后续事件不会直接投递用户。行为机会仍由模型结合当前人物、记忆、反馈与目标选择；执行继续使用原单执行线、预算与授权。不能把任务成功或发布回复当成主人喜欢，也不能由回调直接改写主人事实、核心人格或操作权限。需要分享的插件应注册产生分享候选的行为，再经过统一联系策略。

## 托管定时

使用 DSH 的定时规则实现，支持 after、at、every、daily、weekly、cron（按既有 schedule rule 字段）。定时器只发布事件，不直接发消息或调用模型。

- 相同插件、定时 ID 和定义在重启后保留原下次触发时间；一次性触发后不会因重启再执行。
- 每个定时计划可声明 `missedPolicy`。默认 `latest` 按 DSH 规则将错过的周期合为最近一次。选 `all` 会在恢复后从保存的时间点向前，每次调度检查最多提交一个仍有效的事件。两种方式都遵守事件来源的容量限制，事件有效期为原定时刻起七天。
- 全局暂停、自主保护暂停、自主关闭或进入安静时段时，插件定时计划等待。恢复后重新检查。用户设置的聊天提醒走独立的提醒入口。
- 停用后取消注册，不能继续发布事件；同版本重新启用沿用持久记录。
- 队列满时保留定时进度，一分钟后再检查容量。旧版本因队满挂起的计划在插件重新加载后也能恢复。永久性错误保留为 `held` 供排查。定义改变会重新计算时间，调度进度与事件写入在同一事务内提交。
- 核心只进行本地检查。计时器、插件事件与用户输入共用原 Human 执行调度。

## 兼容与验证范围

本轮不新增新闻插件，也不变更微信协议、主会话或人物配置。学习页面通过宿主认证的插件 RPC 调用后台；设置保存与批注写入只允许修改学习范围，要求后台空闲并占用原维护执行线，不抢断正在运行的任务。写结果不明不会自动重发。

隔离验证覆盖注册回滚、资源隔离、定时去重与漏周期、暂停、各阶段回调、失败隔离、原学习包启停及页面合同。真实长期定时、多日运行和第三方实际插件仍需后续观察，不能用隔离时钟测试替代。
