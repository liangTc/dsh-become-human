import {randomUUID} from 'node:crypto';
import {contextMessages,personaPolicy,contextPolicy} from './context.mjs';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const textOf=message=>(message?.content??[]).filter(p=>p.type==='text').map(p=>p.text??'').join('');
const protocol=value=>plain(value)&&(Object.hasOwn(value,'capability')||Object.hasOwn(value,'board'));
const inputErrors=new Set(['MODEL_IMAGE_INPUT_UNSUPPORTED','MODEL_IMAGE_CAPABILITY_UNKNOWN','IMAGE_INPUT_UNSUPPORTED','IMAGE_NOT_FOUND','IMAGE_SOURCE_UNAVAILABLE','INVALID_IMAGE_REFERENCE','IMAGE_OWNERSHIP_REQUIRED']);
const localInputFailure=code=>({rid:randomUUID(),localMessageId:randomUUID(),provider:'local-image-input',model:'command',reasoningChars:0,inputFailure:true,text:['MODEL_IMAGE_INPUT_UNSUPPORTED','MODEL_IMAGE_CAPABILITY_UNKNOWN','IMAGE_INPUT_UNSUPPORTED'].includes(code)?'当前对话模型还未确认支持看图片。请在模型设置里选择支持图片的模型，再发给我。':'这张图片暂时无法读取，请重新添加后再发送。'});

export const choiceDialoguePolicy='\n人物拥有自己的普通交流意愿。结合当前人物、关系状态、当前请求、有效记忆和具体情境选择同意、协商或拒绝，不默认答应，也不为表现独立而故意唱反调。好感、亲密和信任仅作背景，不用固定分数门槛决定一切；低分仍可合理答应，高分也可保持立场。普通拒绝可以说明简短理由和可以重新考虑的条件；主人补充理由、换一种方式或友好示好时可自然重新考虑，转为同意也应有新的情境理由，不要求付出礼物、金钱或升级关系，不以冷落、惩罚或愧疚索取关注。关系变化只根据本次真实输入的小幅有据判断，相同讨好不反复加分，无依据就为0。不得把示好、分数或关系变化当作工具权限、额度、审批、事实准确性和数据范围的新授权。只给可公开的简短理由，不输出私密推理过程。'+
 '本轮如需capability或board，继续按原来的单一工具JSON协议返回；已有foregroundSources时严格使用资料片段协议，不加入choice字段。普通最终回复改为一个JSON对象，且只含reply和choice。reply为直接展示的自然短回复，不能向主人报分数或复述内部协议；choice为本次实际选择，其stance为agree/negotiate/decline，requestKey为本次事项的稳定短标签，reasonSummary为简短可公开理由，delta为affection/intimacy/trust的整数小幅变化，evidenceSourceIds只能取当前输入的实际ID。若重新考虑旧选择，reconsiderOf必须逐字复制relationship.recentDecisions里那条真实记录的assistantMessageId，不得填requestKey、输入ID、序号或自己编造ID；requestKey沿用该记录的requestKey，新增方案放在reply与理由中。reconsiderReason必须填写新增解释或互动如何影响了普通意愿的简短理由；没有重新考虑就省略这两个字段。仅说明意愿不能声称现实操作已完成。';

/** One response generation; no separate scorer or automatic model retry. */
export function choiceDialogueRequest(request){
  return async function choiceRequest(agent,signal,options){
    const store=agent.factory.relationship,id=agent.id;
    let response;
    try{
      const messages=options.messages;
      let data;try{data=JSON.parse(textOf(messages?.[1]));}catch{}
      const enabled=!!store&&store.settings(id).enabled===true;
      const grounded=!!data?.foregroundSources;
      if(!enabled||grounded||!plain(data)||messages?.length!==2){return await request(agent,signal,options);}
      let system=textOf(messages[0]);const suffix=personaPolicy+contextPolicy;if(system.endsWith(suffix))system=system.slice(0,-suffix.length);
      const ownerSourceIds=options.admittedIds??[],relationship=store.context(id,{ownerSourceIds});
      const contract={reply:'本轮自然简短回应',choice:{stance:'negotiate',requestKey:'当前实际事项',reasonSummary:'可公开的简短选择理由',delta:{affection:0,intimacy:0,trust:0},evidenceSourceIds:ownerSourceIds}};
      const assembled=contextMessages(agent,'foreground',system+choiceDialoguePolicy,{...data,relationship,choiceOutputContract:contract});
      response=await request(agent,signal,{...options,messages:assembled});
      let parsed;try{parsed=JSON.parse(response.text.trim().replace(/^```(?:json)?\s*/iu,'').replace(/\s*```$/u,''));}catch{}
      if(protocol(parsed))return response;
      if(plain(parsed)&&typeof parsed.reply==='string'&&parsed.reply.trim()&&parsed.reply.length<=6000){
        const reply=parsed.reply.trim();
        try{
          if(Object.keys(parsed).some(k=>!['reply','choice'].includes(k)))throw Error('INVALID_RELATIONSHIP_DECISION');
          const choice=store.validateDecision(id,parsed.choice,{ownerSourceIds});
          return {...response,text:reply,relationshipDecision:{ownerSourceIds,choice}};
        }catch(error){
          const prior=relationship.recentDecisions?.find(row=>row.assistantMessageId===parsed.choice?.reconsiderOf),diagnostic=error.validationDiagnostic;
          const validationDiagnostic=plain(diagnostic)?Object.fromEntries(Object.entries(diagnostic).filter(([key,value])=>['field','reason'].includes(key)&&typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/u.test(value))):null;
          agent.factory.journal.audit(id,'relationship-choice-unscored',{attemptId:response.rid,code:/^[A-Z_]{3,64}$/u.test(error.message)?error.message:'INVALID_RELATIONSHIP_DECISION',reason:'invalid-structured-choice',validationDiagnostic,shape:{reconsiderProvided:typeof parsed.choice?.reconsiderOf==='string'&&!!parsed.choice.reconsiderOf,reconsiderInContext:!!prior,requestKeyMatchesReferenced:!!prior&&prior.requestKey===parsed.choice?.requestKey,reconsiderReasonPresent:typeof parsed.choice?.reconsiderReason==='string'&&!!parsed.choice.reconsiderReason.trim()}});
          return {...response,text:reply};
        }
      }
      agent.factory.journal.audit(id,'relationship-choice-unscored',{attemptId:response.rid,reason:'missing-structured-choice'});
      // Preserve an ordinary reply without inventing its stance or points. Never
      // expose a malformed internal JSON envelope as conversation text.
      if(parsed!==undefined||/^\s*(?:[\[{]|```)/u.test(response.text))return {...response,text:'这次没有整理出可靠的回应。你可以再说一下最希望我做的事。'};
      return response;
    }catch(error){const code=error?.code??error?.message;if(inputErrors.has(code)||/^MEDIA_/u.test(code??''))return localInputFailure(code);throw error;}
  };
}
