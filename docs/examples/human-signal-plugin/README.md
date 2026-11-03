# Human 外部信号示例

测试用最小 DSH 插件，包版本 0.2.0，建议配合 Human 本地 beta.15 使用。遵循 Apache-2.0；不默认生成事件、不开放网络接收端口、不创建第二个会话。

注册 `example.signals` 事件源和 `example.review-signal` 行为。收到信号后让主 Human 自己决定处理或等待；默认执行只保存未核验的外部原文回执。开启 `reviewWithModel` 后，使用一次受管模型请求形成简短观察、暂定价值、待确认问题和下一步建议。两种模式都不会生成笔记、发送消息或执行下一步建议。插件释放时同时注销行为、事件源及事件监听。

安装到 Human **后台私有 profile**，不要装到宿主管理 profile。标准 `dsh plugin --profile <后台profile> add <此目录或打包tgz>` 负责安装；Human 重启会保留扩展依赖和 bundle。配置写在同一 profile 的 `human-extensions.patch.yml`，例如：

```yaml
- id: human-extension.signal-example
  config:
    reviewWithModel: false
    signals: []
```

真实适配器可以通过同进程 `human/example-signal` 事件提交 `{key, occurredAt, expiresAt, payload:{title,detail}}`。时间为毫秒时间戳，键对应来源的一次稳定变化；重复提交必须保留相同时间、有效期和内容。`signals` 只用于显式配置的开发验收，不能当作已接入真实外部服务。

安装、配置或移除后重启后台，确认目录和事件来源列表，再恢复 Human。卸载使用 DSH 的 `plugin remove`；历史回执保留。完整接口和边界见项目的 `docs/BEHAVIOR_API.md`。

`reviewWithModel: true` 是可选的轻量事件理解模式，不启用完整学习流水线。模型使用现有执行路由、单执行线及自主额度；一次成功选择和理解通常合计两次请求。结果标记 `inference: true`、`verified: false`，不能当作已核验事实、用户偏好或行动完成记录。输入/输出不合法、取消或来源失效时不提交结果，失败不自动重放。切换模式会改变行为定义版本，已有旧定义任务不能静默按新实现继续。

beta.15 每轮从同一来源最多提供八条事件，按来源及条目轮换；模型仍可以等待，轮到候选窗口不等于必须执行。示例只是最小参考，不具备真实订阅服务、通用语义事实核验或生产通知系统的保证。
