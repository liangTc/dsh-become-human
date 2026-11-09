import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
// In this workspace esbuild is provided by the Web manager development tools.
const esbuild=createRequire(new URL('../../../become-human-web/package.json',import.meta.url))('esbuild');
await esbuild.build({entryPoints:[fileURLToPath(new URL('./page.tsx',import.meta.url))],outfile:fileURLToPath(new URL('./client.js',import.meta.url)),bundle:true,format:'cjs',platform:'browser',external:['react','react-dom'],target:['chrome100']});
