import {Service} from '@deepseek-ai/cordis';
export class DisabledUploads extends Service {
  static inject=['connection'];
  constructor(ctx){
    super(ctx,'fileUploads');
    ctx.connection.fetch.register({path:'/api/session/uploadFileBinary',methods:['POST'],requestBody:'buffered',fetch:()=>Response.json({ok:false,error:{code:'P0_UPLOAD_DISABLED',message:'P0_UPLOAD_DISABLED'}},{status:403})});
  }
  registerAgentResolver(){return ()=>{};}
  resolve(){return undefined;}
  bindPrompt(agent,receiptIds){if(receiptIds.length)throw new Error('P0_UPLOAD_DISABLED');return {commit(){},[Symbol.dispose](){}};}
  retirePrompt(){}
  async upload(){throw new Error('P0_UPLOAD_DISABLED');}
  async uploadStream(){throw new Error('P0_UPLOAD_DISABLED');}
}
export const name='become-human-upload-guard';
export function apply(ctx){ctx.plugin(DisabledUploads);}
