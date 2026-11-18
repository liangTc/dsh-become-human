import {collect} from './opportunities.mjs';
import {prepare,execute} from './workflow.mjs';
export const name='human-learning';
export const inject=['humanLearning','humanPlugins'];
export function apply(ctx){
  if(ctx.humanLearning.contractVersion!==1||ctx.humanPlugins.contractVersion!==1)throw Error('HUMAN_LEARNING_CONTRACT_UNSUPPORTED');
  ctx.effect(()=>{
    const plugin=ctx.humanPlugins.register('dsh-human-learning',{
      version:1,title:'探索与学习',description:'有值得了解的问题时学习，把有用内容留在笔记里。',
      learning:{version:1,collect,prepare,execute},
      pages:[{id:'learning',handlers:{
        'learning.read':{mode:'read',handle:input=>ctx.humanLearning.read(input)},
        'learning.save':{mode:'write',handle:(input,context)=>ctx.humanLearning.write(input,context)},
      }}],
      // Local progress only. It is not evidence of user interest or approval,
      // and never bypasses the existing share/engagement/contact policy.
      hooks:{
        result:(event,{state})=>event.noteId?{state:{...state,lastNoteId:event.noteId,lastResultAt:event.time}}:undefined,
        feedback:(event,{state})=>event.noteId?{state:{...state,lastFeedbackAt:event.time}}:undefined,
      },
    });
    return ()=>plugin.dispose();
  });
}
