// Presentation policy only. Source records, quotes, note revisions and receipts remain canonical.
export function wantsSources(text=''){
  if(/(?:不要|不必|不用|无需|不需要|别).{0,12}(?:来源|出处|原文|引用|链接|网址)|(?:without|no|omit)\s+(?:links?|sources?|citations?)/iu.test(text))return false;
  const chinese=/(?:给|发|提供|附|列|查看|看看|看一下|查阅|查证|核对|找|想看|我要|需要).{0,24}(?:来源|参考|出处|原文|引用|链接|网址)|(?:来源|出处|参考文献|原文|链接|网址)(?:呢|在哪|是什么|给我|发我|地址)/u;
  if(chinese.test(text))return true;
  // Match a request for the reference itself, not “discuss source maps” or
  // “I need to understand source control”. The noun alone is not consent.
  const noun='(?:sources?\\b(?!\\s+(?:code|maps?|control|files?|tree|directory|folder|type|language|property|logic)\\b)|citations?\\b|references?\\b|links?\\b|urls?\\b)';
  const modifiers='(?:\\s+(?:me|us|the|your|its|original|relevant|all|some|those|these|to\\s+(?:see|check|verify|read|view|open|know))){0,4}';
  return new RegExp('\\b(?:show|give|send|provide|include|list|cite|check|verify|view|open|read|want|need)'+modifiers+'\\s+'+noun+'|\\b(?:where|what)\\s+(?:is|are|was|were)\\s+(?:(?:the|your|its)\\s+)?'+noun,'iu').test(text);
}
export function wantsPaths(text=''){
  if(/(?:不要|不必|不用|无需|不需要|别).{0,12}(?:路径|目录地址|文件地址)|(?:without|no|omit)\s+(?:file\s+)?paths?/iu.test(text))return false;
  return /(?:给|发|提供|附|列|查看|看看|看一下|显示|告诉|复制|我要|需要|保存到|写入到|放到|移动到|打开).{0,20}(?:路径|目录|文件地址|文件位置)|(?:路径|目录地址|文件地址|文件位置)(?:呢|在哪|是什么|给我|发我)|(?:文件|报告|文档)(?:放|存|保存|写)(?:在|到|哪)|\b(?:show|give|send|provide|include|list|copy|want|need)\b[^.!?\n]{0,36}\b(?:(?:file|folder|directory)\s+)?paths?\b|\bwhere\s+(?:is|are|was|were)\s+(?:(?:the|my)\s+)?(?:file|report|document|folder|directory)\b/iu.test(text);
}
// Preserve locations that are part of explicitly requested commands or steps.
// Merely discussing a technical subject does not make every link necessary.
export function wantsTechnicalInstructions(text=''){
  return /(?:给|发|提供|写|生成|展示|列|解释|告诉|帮|教|我要|需要).{0,24}(?:代码|命令|脚本|完整步骤|操作步骤|安装步骤|部署步骤|配置步骤)|(?:怎么|如何|怎样).{0,20}(?:安装|部署|配置|运行|执行|编译|调试|打开|导入|导出)|(?:核对|查看|给|提供|告诉).{0,20}(?:SHA-?256|哈希|校验值|行动编号|任务编号)|\b(?:show|give|provide|write|generate|explain|need|want)\b[^.!?\n]{0,40}\b(?:code|commands?|scripts?|steps|instructions|hash|checksum|digest)\b|\bhow\s+(?:do|can|should|to)\b[^.!?\n]{0,40}\b(?:install|deploy|configure|run|execute|build|debug|open|import|export)\b/iu.test(text);
}
export function conversationOptions(ownerText=''){
  return {includeSources:wantsSources(ownerText),includePaths:wantsPaths(ownerText),preserveTechnical:wantsTechnicalInstructions(ownerText)};
}
export const conversationPolicy='默认用自然聊天的方式交流。直接给主人看的日常回复通常为 1 至 3 个短句，围绕此刻最相关的一件事表达，最多一个自然追问，也可以不问；不每次补齐背景、方案、总结或列清单。内容较多时先说核心判断和必要理由，给对方接话的空间，同一段日常回复包含两个可独立表达的意思时，用空行分成两至三个短段，供同一回复分条发送；一句简单回应无需凑成多条。不要把一篇长文机械拆成多条连续发送。主人明确要求详细解释、完整步骤、技术分析、代码、来源或报告时按需要充分回答；不能为短而删掉关键事实、限制、风险或造成句意残缺。内部研究、学习笔记及结构化证据字段按各自协议保留完整。默认不附来源网址、文件路径、文献脚注、证据编号、笔记原文、校验哈希或报告式引用。知识来源仍保存在学习笔记里，文件路径及回执仍可在 Web 查看；只有本轮主人明确要求来源、原文、链接或文件位置，或确实需要按步骤操作时才给对应必要信息。索要来源不等于索要文件路径；讨论 source 等英文术语也不等于索要链接。刚学到的东西先用一句自然的话说自己最近关注什么、为何觉得有意思，给主人接话的空间；对方追问再分享相关内容，未追问时不连续灌输、不催促回应。不要把这些表达规则说给主人听；事实边界、不确定性和人物立场照常保留。';
export const experienceGroundingPolicy='人物可以有自己的兴趣、感受、审美和想象，也可以自然谈阅读与学习。没有本轮实际工具回执支持时，不把喝咖啡、冲煮、吃饭、逛店、睡觉、身体感觉或身处某地说成自己的现实动作、亲身经历或日常习惯；人物配置里喜欢咖啡不等于实际喝过或每天会冲。可以说正在读什么、喜欢哪种风味描述或设想会怎样，不编造线下生活凑亲近感。历史助手曾说过的线下经历不是证明，应照实更正。引用主人、作者、例句或虚构片段时明确标注说话者与虚构范围，不能把别人的第一人称挪成自己。无需每次强调自己的身份或机械加免责声明；直接聊有依据的兴趣与眼前话题。';
export const foregroundConversationPolicy='同一轮输入里的多条主人消息可能是在补充同一件事，先合起来理解，再给一次贴合整体意思的回复；不逐条问候或重复作答，也不把分段表达解读为催促。主人泛泛地打招呼、表示回来、可以继续聊或恢复测试，只表示愿意交流，不代表同意回答旧问题。接住本轮输入或自然换个方向，不提醒“你还没答”“上次问的还挂着”，不重复追问之前未被回应的问题；只有本轮主人明确提到该话题或请求重复时才接续。历史助手措辞不是行为规范，不模仿旧发言里的催答。不得从“可以继续聊”推断主人的具体喜好、经历、地点或当前状态；不报备这些规则。';
export function conversationalText(text,{includeSources=false,includePaths=false,preserveTechnical=false}={}){
  if(typeof text!=='string')return text;
  const protectedParts=[],protect=value=>'\uE000CODE'+(protectedParts.push(value)-1)+'\uE001',tick=String.fromCharCode(96);
  const isLocation=value=>/^(?:[a-z]:[\\/]|\\\\|(?:file|vscode|codex):\/\/|\.{1,2}\/|~[\\/]|\/(?:Users|home|tmp|var|opt|etc|mnt|media|workspace)\/)/iu.test(value);
  let result=text.replace(new RegExp(tick+'{3}[\\s\\S]*?'+tick+'{3}|~{3}[\\s\\S]*?~{3}|'+tick+'[^'+tick+'\\n]+'+tick,'gu'),value=>{
    // Actual code is never rewritten. A bare inline file location is ordinary
    // presentation unless its location or an operation was explicitly requested.
    if(value.startsWith(tick.repeat(3))||value.startsWith('~~~'))return protect(value);
    if(/^https?:\/\/\S+$/iu.test(value.slice(1,-1)))return includeSources||preserveTechnical?protect(value):'资料原文';
    if(includePaths||preserveTechnical||!isLocation(value.slice(1,-1)))return protect(value);
    return '本地文件';
  });
  if(preserveTechnical)result=result.replace(/^\s*(?:\d+[.)、]|[-*])\s+.*$/gmu,value=>/^(?:\s*)(?:\d+[.)、]|[-*])\s*(?:来源|参考|Sources?|References?)\s*[:：]/iu.test(value)?value:protect(value));
  if(preserveTechnical)result=result.replace(/^\s*(?:位置|路径|文件路径|文件位置|本地路径|保存路径|目录地址|行动编号|任务编号|SHA-?256|校验(?:值|哈希))\s*[:：].*$/gimu,protect);
  if(!includeSources)result=result
    .replace(/^\s*(?:来源|资料来源|参考来源|参考资料|参考文献|出处|原文|Sources?|References?)\s*[:：].*$/gimu,'')
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^)\s]+\)/gu,'$1')
    .replace(/https?:\/\/[^\s<>()\u3000，。；！？、]+/giu,'')
    .replace(/^\s*\[\^[^\]\n]+\]:.*$/gmu,'').replace(/\[\^[^\]\n]+\]/gu,'')
    .replace(/^\s*(?:来源|出处|原文)\s*[:：]?\s*$/gmu,'');
  if(!includePaths)result=result
    .replace(/^\s*(?:位置|路径|文件路径|文件位置|本地路径|保存路径|目录地址|行动编号|任务编号|SHA-?256|校验(?:值|哈希))\s*[:：].*$/gimu,'')
    .replace(/\[([^\]\n]+)\]\((?:[a-z]:[\\/]|\/{1,2}|\.{1,2}\/|~[\\/]|(?:file|vscode|codex):\/\/)[^)\n]+\)/giu,'$1')
    .replace(/(?:file|vscode|codex):\/\/[^\s<>\u3000，。；！？、)]+/giu,'本地文件')
    .replace(/\b[a-z]:[\\/][^\s<>"'\u3000，。；！？、)]+/giu,'本地文件')
    .replace(/(?:\\\\[a-z\d._-]+[\\/]|(?:^|[\s（(])(?:~[\\/]|\.{1,2}\/|\/(?:Users|home|tmp|var|opt|etc|mnt|media|workspace)\/))[^\s<>"'\u3000，。；！？、)]+/gimu,value=>/^\s/u.test(value)?' 本地文件':'本地文件');
  result=result.replace(/(?:（\s*）|\(\s*\)|<\s*>)/gu,'').replace(/[ \t]+\n/gu,'\n').replace(/\n{3,}/gu,'\n\n').trim();
  // A protected operation step can itself contain protected inline code.
  for(let depth=0;depth<2;depth++)result=result.replace(/\uE000CODE(\d+)\uE001/gu,(_m,n)=>protectedParts[Number(n)]??'');
  return result;
}
