// Presentation policy only. Source records, quotes, note revisions and receipts remain canonical.
export function wantsSources(text=''){
  if(/(?:不要|不必|不用|无需|不需要|别).{0,12}(?:来源|出处|原文|引用|链接|网址)|(?:without|no|omit)\s+(?:links?|sources?|citations?)/iu.test(text))return false;
  return /(?:给|发|提供|附|列|查看|看看|看一下|查阅|查证|核对|找|想看|我要|需要).{0,24}(?:来源|参考|出处|原文|引用|链接|网址)|(?:来源|出处|参考文献|原文|链接|网址)(?:呢|在哪|是什么|给我|发我|地址)|\b(?:sources?|citations?|references?|links?|urls?)\b/iu.test(text);
}
export const conversationPolicy='默认用自然聊天的方式交流。直接给主人看的日常回复通常为 1 至 3 个短句，围绕此刻最相关的一件事表达，最多一个自然追问，也可以不问；不每次补齐背景、方案、总结或列清单。内容较多时先说核心判断和必要理由，给对方接话的空间，同一段日常回复包含两个可独立表达的意思时，用空行分成两至三个短段，供同一回复分条发送；一句简单回应无需凑成多条。不要把一篇长文机械拆成多条连续发送。主人明确要求详细解释、完整步骤、技术分析、代码、来源或报告时按需要充分回答；不能为短而删掉关键事实、限制、风险或造成句意残缺。内部研究、学习笔记及结构化证据字段按各自协议保留完整。默认不附来源网址、文献脚注、证据编号、笔记原文或报告式引用。知识来源仍保存在学习笔记里；只有本轮主人明确要求来源、原文或链接时才提供。不要把这些表达规则说给主人听；事实边界、不确定性和人物立场照常保留。';
export const foregroundConversationPolicy='同一轮输入里的多条主人消息可能是在补充同一件事，先合起来理解，再给一次贴合整体意思的回复；不逐条问候或重复作答，也不把分段表达解读为催促。主人泛泛地打招呼、表示回来、可以继续聊或恢复测试，只表示愿意交流，不代表同意回答旧问题。接住本轮输入或自然换个方向，不提醒“你还没答”“上次问的还挂着”，不重复追问之前未被回应的问题；只有本轮主人明确提到该话题或请求重复时才接续。历史助手措辞不是行为规范，不模仿旧发言里的催答。不得从“可以继续聊”推断主人的具体喜好、经历、地点或当前状态；不报备这些规则。';
export function conversationalText(text,{includeSources=false}={}){
  if(includeSources||typeof text!=='string')return text;
  const code=[],tick=String.fromCharCode(96),protectedText=text.replace(new RegExp(tick+'{3}[\\s\\S]*?'+tick+'{3}|'+tick+'[^'+tick+'\\n]+'+tick,'gu'),value=>{const i=code.push(value)-1;return '\uE000CODE'+i+'\uE001';});
  return protectedText
    .replace(/^\s*(?:来源|资料来源|参考来源|参考资料|参考文献|出处|原文|Sources?|References?)\s*[:：].*$/gimu,'')
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^)\s]+\)/gu,'$1')
    .replace(/https?:\/\/[^\s<>()\u3000]+/giu,'')
    .replace(/^\s*\[\^\d+\]:.*$/gmu,'').replace(/\[\^\d+\]/gu,'')
    .replace(/^\s*(?:来源|出处|原文)\s*[:：]?\s*$/gmu,'')
    .replace(/[ \t]+\n/gu,'\n').replace(/\n{3,}/gu,'\n\n').trim()
    .replace(/\uE000CODE(\d+)\uE001/gu,(_m,n)=>code[Number(n)]??'');
}
