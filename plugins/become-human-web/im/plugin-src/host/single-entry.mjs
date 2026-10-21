import {createImHostPlugin} from './index.mjs';
import {installSingleSessionBoundary} from '../../src/channels/shared/single-session-boundary.mjs';
import path from 'node:path';
export const name='become-human-all-im';
export const inject=['connection','credentials','typertGateway','sessionController','workspaceController','becomeHumanImIngress'];
export async function apply(ctx,config={}){installSingleSessionBoundary(ctx.becomeHumanImIngress);const dshHome=path.join(process.env.DSH_HOME,'become-human-manager','im-home'),isolated={...config,dshHome};delete isolated.whatsapp;for(const channel of ['feishu','weixin','dingtalk','wecom','wecomApp','qq','slack','telegram','discord','imessage','email','matrix','office'])isolated[channel]={...config[channel],dshHome};const plugin=createImHostPlugin({installDeliveryHttp:()=>{},installUpdateRpc:()=>{},installInjectedContext:()=>{},installSessionSyncCoordinator:()=>{}});await plugin.apply(ctx,isolated);}
