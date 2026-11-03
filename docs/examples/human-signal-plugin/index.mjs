import {reviewSignal} from './review.mjs';
export const name='human-signal-example';
export const inject=['humanEvents','humanBehaviors'];
const sourceId='example.signals',behaviorId='example.review-signal';
export function apply(ctx,config={}){
  if(config.reviewWithModel!==undefined&&typeof config.reviewWithModel!=='boolean')throw Error('INVALID_SIGNAL_CONFIG');
  ctx.effect(()=>{
    const source=ctx.humanEvents.register(sourceId,{version:1,title:'示例外部变化',inputSchema:{type:'object',additionalProperties:false,properties:{title:{type:'string',minLength:1,maxLength:160},detail:{type:'string',maxLength:2000}},required:['title','detail']}});
    let stopBehavior,stopListener;
    try{
      stopBehavior=ctx.humanBehaviors.register(behaviorId,{version:config.reviewWithModel?3:2,title:'查看外部变化',description:config.reviewWithModel?'用一次受管模型请求理解外部变化，保留暂定价值、待确认问题与下一步建议；不会发消息、创建学习笔记或执行建议。':'读取事件来源带来的具体变化，保留未核验的原始内容和执行回执；不会发消息、创建学习笔记或扩大权限。',
        inputSchema:{type:'object',additionalProperties:false,properties:{eventId:{type:'string',minLength:1,maxLength:64}},required:['eventId']},
        eventsForInput:input=>[input.eventId],
        opportunities:(_agent,snapshot)=>snapshot.events.filter(event=>event.kind==='plugin'&&event.data.source===sourceId).slice(0,8).map(event=>({question:'检查外部变化：'+event.data.payload.title,input:{eventId:event.id},eventIds:[event.id]})),
        execute:async(_agent,input,context)=>{
          const {valid}=context;
          valid();const event=source.get(input.eventId);if(!event)throw Error('PLUGIN_EVENT_UNAVAILABLE');
          if(config.reviewWithModel)return reviewSignal(event,context);
          return {status:'completed',summary:'已读取外部信号并保留其原始内容；内容仍待核验。',eventId:event.id,observation:event.data.payload,source:sourceId,verified:false};
        },
      });
      // A real adapter publishes here from its own already-authorized source.
      // No HTTP listener, file watcher or network permission is implied.
      stopListener=ctx.on('human/example-signal',event=>source.publish(event));
      for(const event of config.signals??[])source.publish(event);
    }catch(error){stopListener?.();stopBehavior?.();source.dispose();throw error;}
    return ()=>{stopListener?.();stopBehavior?.();source.dispose();};
  });
}
