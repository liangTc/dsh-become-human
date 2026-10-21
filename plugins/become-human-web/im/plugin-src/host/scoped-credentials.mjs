const cache=new WeakMap();
export function scopedImCredentials(credentials){
  if(!credentials)return credentials;
  if(cache.has(credentials))return cache.get(credentials);
  const ref=value=>{if(typeof value!=='string'||!/^DSH_[A-Z0-9_]+$/.test(value))throw new Error('IM_CREDENTIAL_REFERENCE_INVALID');return 'BECOME_HUMAN_IM_'+value;};
  const scoped=Object.freeze({resolve:value=>credentials.resolve(ref(value)),set:(value,secret)=>credentials.set(ref(value),secret),unset:value=>credentials.unset(ref(value)),describe:value=>credentials.describe(ref(value))});
  cache.set(credentials,scoped);return scoped;
}
