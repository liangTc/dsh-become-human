import {createImHostPlugin} from './index.mjs';
import {installSingleSessionBoundary} from '../../src/channels/shared/single-session-boundary.mjs';
import {resolveImHome} from './im-home.mjs';
export const name='become-human-all-im';
export const inject=['connection','credentials','typertGateway','sessionController','workspaceController','becomeHumanImIngress'];
export async function apply(ctx,config={}){installSingleSessionBoundary(ctx.becomeHumanImIngress);const dshHome=resolveImHome(ctx,config),isolated={...config,dshHome};delete isolated.whatsapp;for(const channel of ['feishu','weixin','dingtalk','wecom','wecomApp','qq','slack','telegram','discord','imessage','email','matrix','office'])isolated[channel]={...config[channel],dshHome};const plugin=createImHostPlugin({installDeliveryHttp:()=>{},installUpdateRpc:()=>{},installInjectedContext:()=>{},installSessionSyncCoordinator:()=>{}});await plugin.apply(ctx,isolated);}
