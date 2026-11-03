import {createExperienceBehavior} from './behavior.mjs';
export const name='human-experience';
export const inject=['humanBehaviors','humanExperience'];
export function apply(ctx){
 if(ctx.humanBehaviors.contractVersion!==1||ctx.humanExperience.contractVersion!==1)throw Error('HUMAN_EXPERIENCE_CONTRACT_UNSUPPORTED');
 ctx.effect(()=>ctx.humanBehaviors.register('reflect-experience',createExperienceBehavior(()=>ctx.humanExperience)));
}
