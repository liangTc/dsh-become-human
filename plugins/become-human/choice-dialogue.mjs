import {randomUUID} from 'node:crypto';
import {contextMessages,personaPolicy,contextPolicy} from './context.mjs';
import {reviewConversationReply} from './conversation-review.mjs';
import {leakedDialogueHeader} from './dialogue-frame.mjs';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const textOf=message=>(message?.content??[]).filter(p=>p.type==='text').map(p=>p.text??'').join('');
const protocol=value=>plain(value)&&(Object.hasOwn(value,'capability')||Object.hasOwn(value,'board'));
const parse=text=>{try{return JSON.parse(text.trim().replace(/^```(?:json)?\s*/iu,'').replace(/\s*```$/u,''));}catch{return undefined;}};
const inputErrors=new Set(['MODEL_IMAGE_INPUT_UNSUPPORTED','MODEL_IMAGE_CAPABILITY_UNKNOWN','IMAGE_INPUT_UNSUPPORTED','IMAGE_NOT_FOUND','IMAGE_SOURCE_UNAVAILABLE','INVALID_IMAGE_REFERENCE','IMAGE_OWNERSHIP_REQUIRED']);
const localInputFailure=code=>({rid:randomUUID(),localMessageId:randomUUID(),provider:'local-image-input',model:'command',reasoningChars:0,inputFailure:true,text:['MODEL_IMAGE_INPUT_UNSUPPORTED','MODEL_IMAGE_CAPABILITY_UNKNOWN','IMAGE_INPUT_UNSUPPORTED'].includes(code)?'当前对话模型还未确认支持看图片。请在模型设置里选择支持图片的模型，再发给我。':'这张图片暂时无法读取，请重新添加后再发送。'});

// Output format only. Interpretation and expression live in configurable Skills.
export const choiceDialoguePolicy='\n最终回复可用JSON对象：reply为实际自然回复；dialogue和choice均可省略或为null，不为填写字段制造互动或分数。dialogue可含focus(最多240字符)、intent(最多80字符)、sourceIds(1至16个本轮可见来源)、address:{value(最多40字符),sourceIds(仅用户来源)}或null、attributions:[{messageId,speaker:user或assistant,span(回复内最多240字符)}](最多8项)、corrections:[{messageId(助手来源),sourceIds(用户来源),summary(最多240字符)}](最多4项)。choice仅确有选择或关系影响时填写，沿用stance/requestKey/reasonSummary/delta/evidenceSourceIds合同，重新考虑时引用真实assistantMessageId。learningLookup.requested为true而尚无当前笔记时，应先实际读取；确实需要澄清而不能选择材料时，可给 learningLookupDecision:"clarify"，reply只提出简短澄清，不声称已有笔记结论。内部字段不展示给用户。需要工具或看板时仍返回原capability/board协议；已有foregroundSources时只用资料片段协议。';

/** Meaning stays in the model. Two draft attempts at most, with serial narrow
 * review calls in the runtime. Tool and extractive-source protocols bypass it. */
export function choiceDialogueRequest(request){
  return async function choiceRequest(agent,signal,options){
    const f=agent.factory,j=f.journal,id=agent.id;
    try{
      let data;try{data=JSON.parse(textOf(options.messages?.[1]));}catch{}
      if(!plain(data)||data.foregroundSources||options.messages?.length!==2)return await request(agent,signal,options);
      const ownerSourceIds=options.admittedIds??[],enabled=!!f.relationship&&f.relationship.settings(id).enabled===true;
      if(!enabled&&!f.dialogueState)return await request(agent,signal,options);
      const relationship=enabled?f.relationship.context(id,{ownerSourceIds}):null;
      const contract={reply:'自然回复',dialogue:'可选，按本轮真实含义更新',choice:null};
      let system=textOf(options.messages[0]);const suffix=personaPolicy+contextPolicy;if(system.endsWith(suffix))system=system.slice(0,-suffix.length);
      let messages=contextMessages(agent,'foreground',system+choiceDialoguePolicy,{...data,...(relationship?{relationship}:{}),choiceOutputContract:contract});
      for(let pass=0;pass<2;pass++){
        const response=await request(agent,signal,{...options,messages}),parsed=parse(response.text);
        if(protocol(parsed))return response;
        let reply=parsed===undefined?response.text:plain(parsed)&&typeof parsed.reply==='string'?parsed.reply.trim():null;
        let contractError;
        if(!reply||parsed===undefined&&/^\s*(?:[\[{]|```)/u.test(reply))contractError=Object.assign(new Error('INVALID_DIALOGUE_RESPONSE'),{validationDiagnostic:{field:'reply',reason:'natural-reply-required'}});
        if(!contractError&&leakedDialogueHeader(reply,JSON.parse(textOf(messages[1]))))contractError=Object.assign(new Error('INVALID_DIALOGUE_RESPONSE'),{validationDiagnostic:{field:'reply',reason:'internal-transport-header'}});
        let conversationIssues;
        if(!contractError&&f.conversationReview===true){
          try{const review=await reviewConversationReply(agent,signal,{request,options,data:JSON.parse(textOf(messages[1])),reply});if(review.decision==='revise'){conversationIssues=review.issues;contractError=Object.assign(new Error('CONVERSATION_REVIEW_REJECTED'),{validationDiagnostic:{field:'reply',reason:'conversation-behavior',issueKinds:review.issues.map(issue=>issue.kind)}});}}
          catch(error){j.endAttempt(response.rid,{state:signal.aborted?'cancelled':'validation-rejected',usage:response.usage,usageConfidence:response.usage?'reported':'unknown',error:'CONVERSATION_REVIEW_UNAVAILABLE',textChars:response.text.length,reasoningChars:response.reasoningChars});throw error;}
        }
        let dialogueState;
        if(!contractError&&plain(parsed)&&parsed.dialogue!=null&&f.dialogueState){
          try{dialogueState=f.dialogueState.prepare(agent,JSON.parse(textOf(messages[1])),parsed.dialogue,reply);}
          catch(error){
            j.audit(id,'dialogue-state-rejected',{attemptId:response.rid,code:'INVALID_DIALOGUE_STATE',validationDiagnostic:error.validationDiagnostic??null});
            // A malformed optional focus does not lose a usable reply. An
            // explicitly declared wrong speaker is corrected by the model.
            if(error.validationDiagnostic?.reason==='source-speaker-mismatch')contractError=error;
          }
        }
        if(contractError){
          j.endAttempt(response.rid,{state:'validation-rejected',usage:response.usage,usageConfidence:response.usage?'reported':'unknown',error:contractError.message,textChars:response.text.length,reasoningChars:response.reasoningChars,failureFacts:{validationDiagnostic:contractError.validationDiagnostic}});
          if(pass)throw contractError;
          j.audit(id,'dialogue-contract-repair',{attemptId:response.rid,validationDiagnostic:contractError.validationDiagnostic,maximumAdditionalCalls:1});
          messages=contextMessages(agent,'foreground',system+choiceDialoguePolicy,{...data,...(relationship?{relationship}:{}),choiceOutputContract:contract,dialogueRepair:{validationDiagnostic:contractError.validationDiagnostic,...(conversationIssues?{conversationIssues}:{}),previousReply:response.text.slice(0,6000),unpublishedDraft:true}});
          continue;
        }
        let relationshipDecision;
        if(enabled&&plain(parsed)&&parsed.choice!=null){
          try{relationshipDecision={ownerSourceIds,choice:f.relationship.validateDecision(id,parsed.choice,{ownerSourceIds})};}
          catch(error){j.audit(id,'relationship-choice-unscored',{attemptId:response.rid,code:error.message,reason:'invalid-optional-choice',validationDiagnostic:error.validationDiagnostic??null});}
        }
        const clarification=plain(parsed)&&parsed.learningLookupDecision==='clarify'&&data.learningLookup?.requested===true&&!data.learningConversation?.note;
        return {...response,text:reply,...(clarification?{learningLookupDecision:'clarify'}:{}),...(dialogueState?{dialogueState}:{}),...(relationshipDecision?{relationshipDecision}:{})};
      }
    }catch(error){const code=error?.code??error?.message;if(inputErrors.has(code)||/^MEDIA_/u.test(code??''))return localInputFailure(code);throw error;}
  };
}
