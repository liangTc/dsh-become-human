import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {larkSdkHandshakePatch} from './im/plugin-src/host/lark-sdk-handshake-patch.mjs';

const root = import.meta.dirname;
const localRequire = createRequire(path.join(root, 'package.json'));
const explicitDeps = process.env.BH_IM_BUILD_DEPS;
const alternateRequire = explicitDeps
  ? createRequire(path.join(path.resolve(explicitDeps), 'package.json'))
  : null;
let esbuild;
try {
  esbuild = localRequire('esbuild');
} catch (error) {
  if (!alternateRequire) {
    throw new Error('Install the declared development dependencies before building IM.', {cause: error});
  }
  esbuild = alternateRequire('esbuild');
}

const external = [
  '@tencent-connect/qqbot-connector', '@tencent-connect/qqbot-nodejs',
  '@wecom/aibot-node-sdk', 'dingtalk-stream', 'imapflow', 'mailparser',
  'nodemailer', 'qrcode', 'sharp', 'undici', '@matrix-org/olm',
];
const forbidden = /(?:baileys|libsignal|rust[-_]?bridge|(?:^|[/\\])channels[/\\]whatsapp(?:[/\\]|$)|(?:^|[/\\])i18n-en[/\\]whatsapp\.mjs$)/i;
const unlicensedSource = /(?:^|[/\\])node_modules[/\\]@tencent-connect[/\\]qqbot-connector(?:[/\\]|$)/i;
const releaseBoundary = {
  name: 'apache-release-boundary',
  setup(build) {
    build.onResolve({filter: /baileys|libsignal|rust[-_]?bridge|whatsapp/i}, args => {
      if (forbidden.test(args.path)) throw new Error('Excluded dependency in Apache release: ' + args.path);
    });
  },
};
const manifestPath = path.join(root, 'im/package.json');
const parentManifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const publicClientManifest = {
  name: 'public-im-client-metadata',
  setup(build) {
    build.onLoad({filter: /package\.json$/}, args => {
      if (path.resolve(args.path) !== manifestPath) return;
      // The UI needs only these fields. Do not embed a vendored development
      // manifest, upstream installer metadata, or optional providers.
      return {contents: JSON.stringify({name: parentManifest.name, version: parentManifest.version}), loader: 'json'};
    });
  },
};
const common = {
  absWorkingDir: root,
  preserveSymlinks: true,
  bundle: true,
  write: false,
  metafile: true,
  legalComments: 'eof',
  nodePaths: explicitDeps ? [path.join(path.resolve(explicitDeps), 'node_modules')] : [],
};
const host = await esbuild.build({
  ...common,
  entryPoints: ['im/plugin-src/host/single-entry.mjs'],
  outfile: 'im/lib/index.js',
  format: 'esm', platform: 'node', target: 'node24',
  external: external.flatMap(name => [name, name + '/*']),
  plugins: [releaseBoundary, larkSdkHandshakePatch],
  minify: true,
  banner: {js: "import {createRequire as __req} from 'node:module';import {fileURLToPath as __url} from 'node:url';import {dirname as __dir} from 'node:path';const require=__req(import.meta.url),__filename=__url(import.meta.url),__dirname=__dir(__filename);"},
});
const client = await esbuild.build({
  ...common,
  entryPoints: ['im/plugin-src/client/index.js'],
  outfile: 'im-client.js',
  format: 'cjs', platform: 'browser', target: 'chrome100',
  external: ['react', 'react-dom'],
  plugins: [releaseBoundary, publicClientManifest],
  minify: false,
});

function checkSources(result) {
  for (const input of Object.keys(result.metafile.inputs)) {
    if (forbidden.test(input) || unlicensedSource.test(input)) {
      throw new Error('Excluded source in Apache release: ' + input);
    }
  }
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports ?? []) {
      if (forbidden.test(dependency.path)) {
        throw new Error('Excluded external dependency in Apache release: ' + dependency.path);
      }
    }
  }
}
checkSources(host);
checkSources(client);
const hostBody = host.outputFiles[0].text;
const clientBody = "window.__ModuleLoader__.load({id:'dsh-become-human-web',factory:(require)=>{var module={exports:{}},exports=module.exports;\n" + client.outputFiles[0].text + "\nreturn module.exports;}});\n";
const metadataDir = path.join(root, 'build-meta');
await fs.mkdir(path.join(root, 'im/lib'), {recursive: true});
await fs.mkdir(metadataDir, {recursive: true});
await fs.writeFile(path.join(root, 'im/lib/index.js'), hostBody);
await fs.writeFile(path.join(root, 'im-client.js'), clientBody);
await fs.writeFile(path.join(metadataDir, 'im-host.metafile.json'), JSON.stringify(host.metafile, null, 2) + '\n');
await fs.writeFile(path.join(metadataDir, 'im-client.metafile.json'), JSON.stringify(client.metafile, null, 2) + '\n');
const digest = value => createHash('sha256').update(value).digest('hex');
const sourceRecord = result => Object.entries(result.metafile.inputs).map(([file, info]) => ({
  file: file.replaceAll('\\', '/'), bytes: info.bytes,
})).sort((a, b) => a.file.localeCompare(b.file));
await fs.writeFile(path.join(root, 'im/BUILD-MANIFEST.json'), JSON.stringify({
  schemaVersion: 1,
  package: parentManifest.name,
  version: parentManifest.version,
  upstream: {name: 'dsh-im', version: '4.39.0', license: 'MIT'},
  excludedProviders: ['whatsapp'],
  excludedDependencies: ['@whiskeysockets/baileys', 'libsignal', 'rustbridge'],
  externalNotBundled: external,
  host: {file: 'lib/index.js', sha256: digest(hostBody), inputs: sourceRecord(host)},
  client: {file: '../im-client.js', sha256: digest(clientBody), inputs: sourceRecord(client)},
}, null, 2) + '\n');
console.log(JSON.stringify({
  host: 'im/lib/index.js', client: 'im-client.js', allChatChannels: 12, connectors: 1,
  excludedProviders: ['whatsapp'], sourceManifest: 'im/BUILD-MANIFEST.json',
  metadata: 'build-meta/im-host.metafile.json',
}));
