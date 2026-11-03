// The extension sees only the current Human's evidence service, not a session selector.
export function experienceService(factory,identity){
 const id=()=>typeof identity==='function'?identity():identity;
 return Object.freeze({contractVersion:1,
  recent:options=>factory.experience.recent(id(),{limit:options?.limit??8}),
  hasReflection:experienceId=>factory.experience.hasReflection(id(),experienceId),
  reflect:input=>factory.experience.reflect(id(),input)
 });
}
