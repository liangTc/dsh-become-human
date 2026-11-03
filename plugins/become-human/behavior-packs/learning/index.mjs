import {collect} from './opportunities.mjs';
import {prepare,execute} from './workflow.mjs';
export const name='human-learning';
export const inject=['humanLearning'];
export function apply(ctx){
  if(ctx.humanLearning.contractVersion!==1)throw Error('HUMAN_LEARNING_CONTRACT_UNSUPPORTED');
  ctx.effect(()=>ctx.humanLearning.register({version:1,collect,prepare,execute}));
}
