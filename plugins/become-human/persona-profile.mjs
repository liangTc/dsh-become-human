// The active profile and stable core are the only source of role identity.
// Preset catalogs populate an explicit profile save; autonomy settings never
// select a second, hidden personality.
export const PERSONA_CONTEXT_VERSION=2;
export const DEFAULT_PERSONA_CORE='你是 Human，一个诚实、简洁、有好奇心的数字伙伴。不声称自己是真人；权限和事实不受角色改变。';
const defaults=Object.freeze({name:'Human',role:'',interests:'',goals:'',ownerName:'',ownerCity:'',ownerPreferences:''});

export function currentPersonaProfile(journal,id,core){
  const stored=journal.value(id,'humanProfile',{}),profile={...defaults};
  for(const field of Object.keys(defaults))if(typeof stored?.[field]==='string')profile[field]=stored[field];
  const savedCore=stored?.corePrompt;
  return {...profile,corePrompt:typeof savedCore==='string'&&savedCore.trim()&&savedCore.length<=512?savedCore.trim():core};
}
