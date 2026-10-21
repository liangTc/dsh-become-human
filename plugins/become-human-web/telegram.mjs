export class TelegramAdapter {
  constructor(fetchImpl=fetch){this.fetch=fetchImpl;}
  async call(config,method,body){
    let response;
    try{response=await this.fetch('https://api.telegram.org/bot'+config.token+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});}
    catch{const error=new Error('TELEGRAM_TRANSPORT_UNKNOWN');error.code=error.message;throw error;}
    const result=await response.json();if(!response.ok||result.ok!==true){const error=new Error(result.error_code===409?'TELEGRAM_POLL_CONFLICT':result.error_code===429?'TELEGRAM_RATE_LIMITED':result.error_code===401?'TELEGRAM_AUTH_REJECTED':'TELEGRAM_REJECTED');error.code=error.message;error.definitelyRejected=true;throw error;}return result.result;
  }
  async verify(config){await this.call(config,'getMe',{});const webhook=await this.call(config,'getWebhookInfo',{});if(webhook?.url)throw new Error('TELEGRAM_WEBHOOK_ALREADY_CONFIGURED');return {privateOwner:/^\d+$/.test(config.ownerId)};}
  async poll(config){
    const updates=await this.call(config,'getUpdates',{offset:config.offset??0,timeout:0,limit:20,allowed_updates:['message']});let offset=config.offset??0;const messages=[];
    for(const update of updates){offset=Math.max(offset,update.update_id+1);const m=update.message;if(m?.text&&m.chat?.type==='private')messages.push({messageId:'tg-'+update.update_id,text:m.text,senderId:String(m.from.id),chatId:String(m.chat.id),privateChat:true});}
    return {messages,offset};
  }
  async send(config,text){const bounded=text.length>3500?text.slice(0,3450)+'\n[内容较长，请在 Web 查看完整消息]':text;const result=await this.call(config,'sendMessage',{chat_id:config.ownerId,text:bounded});return {accepted:true,messageId:String(result.message_id)};}
}
