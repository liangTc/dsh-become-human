export const name = 'human-pulse-example';
export const inject = ['humanPlugins'];
const owner = 'dsh-human-pulse-example';

export function apply(ctx) {
  if (ctx.humanPlugins.contractVersion !== 1) throw Error('HUMAN_PLUGIN_VERSION_UNSUPPORTED');
  const source = ctx.humanPlugins.resourceId(owner, 'tick');
  ctx.effect(() => {
    const plugin = ctx.humanPlugins.register(owner, {
      version: 1,
      title: '节拍观察',
      events: [{
        id: 'tick',
        descriptor: {
          version: 1, title: '节拍到期',
          inputSchema: {type: 'object', properties: {}, additionalProperties: false},
        },
      }],
      schedules: [{
        id: 'first-tick', title: '首次节拍', source: 'tick',
        rule: {kind: 'after', seconds: 60}, payload: {},
      }],
      behaviors: [{
        id: 'acknowledge',
        descriptor: {
          version: 1, title: '记录节拍',
          description: '为到期的插件事件留下一条本地任务回执。',
          inputSchema: {
            type: 'object', additionalProperties: false, required: ['eventId'],
            properties: {eventId: {type: 'string', minLength: 1, maxLength: 64}},
          },
          opportunities(_agent, snapshot) {
            const tick = snapshot.events.find(e => e.kind === 'plugin' && e.data.source === source);
            return tick ? [{
              question: '是否值得记录这次节拍？',
              input: {eventId: tick.id}, eventIds: [tick.id],
            }] : [];
          },
          eventsForInput: input => [input.eventId],
          async execute(_agent, input, context) {
            context.valid();
            return {status: 'completed', summary: '已记录一次节拍。', eventId: input.eventId};
          },
        },
      }],
    });
    return () => plugin.dispose();
  });
}
