import {executeRegisteredBehavior} from './behavior-workflow.mjs';
import {prepareGoalReport} from './report-workflow.mjs';
import {executeContact} from './contact-workflow.mjs';
// Compatibility routes keep persisted task kinds and checkpoints readable.
// Third-party behaviors continue to use humanBehaviors, not this internal map.
const contact=Object.freeze({execute:executeContact});
const workflows=new Map([['behavior',Object.freeze({execute:executeRegisteredBehavior})],['write-report',Object.freeze({direct:true,execute:prepareGoalReport})],['chat',contact],['care',contact],['share-insight',contact]]);
export function selectedTaskWorkflow(kind,agent){if(['research','learn-ai'].includes(kind)){const pack=agent?.factory.learningPack;if(!pack)throw Error('LEARNING_PACK_UNAVAILABLE');return pack.workflow();}const workflow=workflows.get(kind);if(!workflow)throw new Error('AUTONOMY_WORKFLOW_UNAVAILABLE');return workflow;}
