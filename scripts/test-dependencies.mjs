import {registerHooks} from 'node:module';
const anchor=new URL('../plugins/become-human-web/manager.mjs',import.meta.url).href;
// Source-only tests resolve declared host dependencies from the publishable package.
// Relative imports continue to exercise maintained source, not generated copies.
registerHooks({resolve(specifier,context,next){
 if(!specifier.startsWith('.')&&!specifier.startsWith('/')&&!specifier.includes(':'))return next(specifier,{...context,parentURL:anchor});
 return next(specifier,context);
}});
