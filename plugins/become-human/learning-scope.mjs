// Bounded wording guards for evidence interpretation. These cues are not a
// semantic entailment classifier: the original quotation remains the evidence.
const patterns={
  example:/\b(?:(?:in|for|this|that|our|the following|the above)\s+(?:worked\s+)?examples?|examples?\s+(?:below|above)|we\s+(?:get|receive|send|run)|our\s+cached|the following\s+(?:request|response)|this will result)\b|(?:在|本|该|这个|上述|下面的)?(?:示例|样例|案例|例子)|例如/giu,
  conditional:/\b(?:if|unless|when|provided that|as long as|only when|in cases? where)\b|如果|若(?:在|是|要|有|未|不|已|想|能)|只(?:有|在)|当[^。！？!?\n]{1,100}时|在[^。！？!?\n]{1,60}(?:条件|情况下)/giu,
  tentative:/\b(?:may|might|could|possibly|potentially|preliminary|estimated|associated with|correlated with|correlation)\b|可能|初步|推测|估计|相关性|相关关系|倾向于/gu,
};
const qualifiers={
  example:/\b(?:examples?|samples?|illustration|demonstrat(?:ion|ed)|in this case)\b|示例|样例|案例|例子|本例|例如/iu,
  conditional:/\b(?:if|unless|when|provided that|as long as|only when|under|given)\b|如果|若|条件|前提|当[^。！？!?\n]{1,100}时|在[^。！？!?\n]{1,60}(?:情况下|时|下)/iu,
  tentative:/\b(?:may|might|could|possibly|potentially|preliminary|estimated|suggests?|associated|correlat\w*)\b|可能|初步|推测|估计|尚不确定|不确定|相关|倾向/iu,
};
const strength=[
  ['universal',/\b(?:all|always|every|invariably)\b|所有|一律|总是|均(?:会|为|应|含|有)|都(?:会|包含|含有|必须)/iu],
  ['mandatory',/\b(?:must|required|mandatory|shall)\b|必须|强制|必需/iu],
  ['certainty',/\b(?:certainly|definitely|guarantees?|proves?)\b|必然|一定|保证|证明/iu],
  ['never',/\bnever\b|从不|绝不/iu],
];
const withoutNegatedStrength=text=>text.replace(/(?:并非|不是)(?:所有|每个)[^。！？!?，,；;]{0,60}|\bnot\s+(?:all|every)\b[^.!?;,]{0,60}|\b(?:not|never)\s+(?:always|required|mandatory|certainly|necessarily|guaranteed|proven)\b|(?:并非|不是|并不|不)(?:所有|总是|必须|必然|一定|保证|证明)|未必/giu,'');
const fail=(field,reason)=>{throw Object.assign(new Error('UNSUPPORTED_LEARNING_EVIDENCE_COVERAGE'),{validationDiagnostic:{field,reason,unsupportedCount:1}});};

export function evidenceScope(source,{start=0,end=source?.excerpt?.length??0}={}){
  const text=source?.excerpt;
  if(typeof text!=='string'||!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>text.length)throw new Error('INVALID_LEARNING_SOURCE');
  const prefixStart=Math.max(0,start-320),prefix=text.slice(prefixStart,start),selected=text.slice(start,end);
  const reset=[...prefix.matchAll(/\b(?:in general|general rule|definition|normative requirements?)\b|一般规则|通用规则|定义[：:]/giu)].at(-1);
  const examplePrefix=reset?prefix.slice(reset.index+reset[0].length):prefix;
  const exampleStart=start-examplePrefix.length;
  // Conditions and uncertainty in a completed preceding sentence are not
  // silently attached to the next sentence. An example can span paragraphs.
  const previousBoundary=[...prefix.matchAll(/[。！？!?\n]|\.(?=\s)/gu)].at(-1),clauseStart=previousBoundary?prefixStart+previousBoundary.index+previousBoundary[0].length:prefixStart;
  const cues=[];
  for(const [type,pattern] of Object.entries(patterns)){
    const contextStart=type==='example'?exampleStart:clauseStart,context=text.slice(contextStart,start)+selected;
    pattern.lastIndex=0;
    for(const match of context.matchAll(pattern)){
      // Uppercase MAY in a normative specification denotes permission, not an
      // uncertain scientific finding. The case-sensitive pattern omits it.
      const at=contextStart+match.index;
      cues.push({type,quote:match[0].slice(0,160),start:at,end:at+match[0].length});
      break;
    }
  }
  return {version:1,types:[...new Set(cues.map(cue=>cue.type))],cues,semanticVerified:false};
}

export function assertScopedInterpretation(text,scope,observed,{field='claims.text',types=scope.types}={}){
  // A small bilingual polarity rule covers the concrete response-body failure
  // mode. It intentionally does not infer arbitrary translated negations.
  const body=/\bbody\b|\bpayload\b|消息体|响应体|内容体/iu;
  const bodyDenied=/\b(?:does?|must|should|can|will|shall)\s+not\s+(?:contain|include|send|return|have)\s+(?:a\s+|the\s+)?(?:message\s+|response\s+)?body\b|\bwithout\s+(?:a\s+|the\s+)?(?:message\s+|response\s+)?body\b|(?:不包含|不含|不得包含|不能包含|没有|禁止).{0,12}(?:消息体|响应体|内容体)/iu;
  const bodyNegative=/\b(?:does?|must|should|can|will|shall)\s+not\b[^.!?]{0,32}\bbody\b|\bwithout\b[^.!?]{0,20}\bbody\b|(?:不(?:应|得|能|会|需|必|允许)?(?:包含|含有|含|携带|发送|返回|提供|带有|带)|没有|无|禁止).{0,12}(?:消息体|响应体|内容体)|(?:消息体|响应体|内容体).{0,12}(?:不应|不得|不能|不会|无需|不可|不必|禁止)/iu;
  if(body.test(text)&&bodyDenied.test(observed)&&!bodyNegative.test(text))fail(field,'body-negation-omitted');
  const onDemand=/\bwhen\s+(?:desired|needed|requested)\b/iu.test(observed)&&/按需|按需要|应请求|应要求|需要时/u.test(text);
  const sample=qualifiers.example.test(text),conditional=qualifiers.conditional.test(text)||onDemand,tentative=qualifiers.tentative.test(text);
  if(types.includes('example')&&!sample)fail(field,'example-scope-omitted');
  if(types.includes('conditional')&&!sample&&!conditional)fail(field,'condition-scope-omitted');
  if(types.includes('tentative')&&!tentative)fail(field,'uncertainty-scope-omitted');
  if(types.length){
    const proposed=withoutNegatedStrength(text),evidence=withoutNegatedStrength(observed);
    for(const [kind,pattern] of strength)if(pattern.test(proposed)&&!pattern.test(evidence))fail(field,'scope-strengthened-'+kind);
    if(/\b(?:associated with|correlat\w*)\b|相关(?:性|关系)/iu.test(observed)&&/\b(?:causes?|leads? to|results? in)\b|导致|引起|造成/iu.test(text)&&!/\b(?:causes?|leads? to|results? in)\b|导致|引起|造成/iu.test(observed))fail(field,'association-strengthened-to-causation');
  }
}

export function commonClaimScope(claims){
  const types=['example','conditional','tentative'].filter(type=>claims.length&&claims.every(claim=>claim.scope?.types?.includes(type)));
  return {version:1,types,cues:[],semanticVerified:false};
}

// New learning records publish whole selected source spans. Model wording is
// retained separately as an unverified draft, never used to repair this span.
// The excerpt is traceable, not independently verified truth or relevance.
export function selectedSourceText(quote,{claimIndex=0,maxChars=400}={}){
  if(typeof quote!=='string'||!quote.trim())throw Object.assign(new Error('INVALID_LEARNING_SOURCE_SELECTION'),{validationDiagnostic:{field:'claims.evidenceIds',reason:'empty-source-selection',claimIndex}});
  if(quote.length>maxChars)throw Object.assign(new Error('LEARNING_EVIDENCE_SELECTION_TOO_LONG'),{validationDiagnostic:{field:'claims.evidenceIds',reason:'source-selection-too-long',claimIndex,length:quote.length,maximum:maxChars}});
  return quote;
}

export function observedSourceTitle(source){
  const text=typeof source?.title==='string'?source.title.replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim():'';
  if(!text)return '来源原文摘录';
  const prefix='原文摘录 · ',maximum=100-prefix.length;
  return prefix+(text.length<=maximum?text:text.slice(0,maximum-1).replace(/[\uD800-\uDBFF]$/u,'')+'…');
}

// A summary is a projection of complete recorded claims, not another model
// inference lane. New records contain source spans; legacy records retain their
// earlier interpretations. Never shorten a fact to make it fit.
export function claimTextProjection(claims,{maxChars=800}={}){
  if(!Array.isArray(claims)||claims.length>4||!Number.isSafeInteger(maxChars)||maxChars<1||maxChars>2800||claims.some(claim=>typeof claim?.text!=='string'||!claim.text.trim()||claim.text.length>400))throw new Error('INVALID_LEARNING_CLAIM_PROJECTION');
  const texts=[],includedClaimIndexes=[];let length=0;
  for(let index=0;index<claims.length;index++){
    const text=claims[index].text,next=length+(texts.length?1:0)+text.length;
    if(next>maxChars)break;
    texts.push(text);includedClaimIndexes.push(index);length=next;
  }
  return {text:texts.join('\n'),version:1,method:'accepted-claim-text',maxChars,includedClaimIndexes,omittedClaimCount:claims.length-includedClaimIndexes.length,semanticVerified:false};
}

export function scopeBoundaryOnly(text){
  // A plain statement about the limits of the note need not repeat every
  // example qualifier. Facts with concrete numbers or code names still pass
  // through the scope checks instead of gaining this small exemption.
  return !/[\dA-Z]|\b(?:is|are|means?|contains?|causes?)\b/u.test(text)&&/(?:未验证|证据不足|后续.{0,12}核对|不作.{0,12}结论|需要.{0,12}验证|仅.{0,12}参考)/u.test(text);
}
