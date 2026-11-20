import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const src = path.join(root, 'docs/handbook');
const out = path.join(root, 'dist/handbook');
const downloads = path.join(out, 'downloads');
const repository = 'https://github.com/liangTc/dsh-become-human';
const baseline = '0.7.0-beta.43';
const pulse = path.join(root, 'docs/examples/human-pulse-example');
const counter = path.join(root, 'plugins/become-human/behavior-packs/react-page-example');
const chapters = [
  ['index', '手册首页', 'Human 插件开发手册'],
  ['start', '快速开始', '制作第一个插件'],
  ['behavior', '事件与自主行为', '从事件到行动回执'],
  ['lifecycle', '注册与生命周期', '注册资源与生命周期'],
  ['pages', '页面与后台接口', '开发插件页面'],
  ['verify', '测试与交付', '验证、排错与交付'],
];
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const code = value => '<pre><code>' + escape(value.trimEnd()) + '</code></pre>';
const read = file => fs.readFile(file, 'utf8');
await fs.mkdir(downloads, {recursive: true});

function pack(dir) {
  const cli = process.env.npm_execpath;
  if (!cli) throw Error('Run npm run docs:build from the repository root');
  const result = spawnSync(process.execPath, [cli, 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', downloads], {cwd: dir, encoding: 'utf8'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(result.stderr || result.stdout || 'Failed to pack ' + dir);
  const [archive] = JSON.parse(result.stdout);
  return archive.filename;
}
const tokens = {
  blob: repository + '/blob/v' + baseline,
  tree: repository + '/tree/v' + baseline,
  mainTree: repository + '/tree/main',
  pulse: pack(pulse),
  counter: pack(counter),
  pulseManifest: code(await read(path.join(pulse, 'package.json'))),
  pulsePatch: code(await read(path.join(pulse, 'cordis.patch.yml'))),
  pulseCode: code(await read(path.join(pulse, 'index.mjs'))),
  counterPage: code(JSON.stringify(JSON.parse(await read(path.join(counter, 'package.json'))).dsh.human.pages[0], null, 2)),
};
await fs.copyFile(path.join(root, 'docs/assets/avatar-pixel-icon.png'), path.join(out, 'human.png'));
await fs.copyFile(path.join(src, 'style.css'), path.join(out, 'style.css'));
for (const [index, [slug, , title]] of chapters.entries()) {
  const body = (await read(path.join(src, slug + '.html'))).replace(/{{(\w+)}}/g, (_, key) => {
    if (!Object.hasOwn(tokens, key)) throw Error('Unknown handbook field: ' + key);
    return tokens[key];
  });
  const rows = chapters.map(([id, text]) =>
    `<li><a href="${id}.html"${id === slug ? ' aria-current="page"' : ''}>${text}</a></li>`).join('\n');
  const sections = [...body.matchAll(/<h2 id="([a-z-]+)">([^<]+)<\/h2>/g)];
  if (!sections.length || new Set(sections.map(s => s[1])).size !== sections.length) throw Error('Invalid sections: ' + slug);
  const contents = sections.map(([, id, text]) => `<li><a href="#${id}">${text}</a></li>`).join('\n');
  const prev = chapters[index - 1], next = chapters[index + 1];
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Become Human</title><link rel="icon" href="human.png"><link rel="stylesheet" href="style.css">
</head><body>
<a class="skip" href="#main">跳到正文</a>
<header class="top"><div class="topbar"><a class="brand" href="index.html"><img alt="" width="38" height="38" src="human.png">Become Human</a>
<span class="version">${baseline}</span><a class="repository" href="${repository}">GitHub ↗</a></div></header>
<div class="layout"><nav class="side" aria-label="手册章节"><span class="navtitle">开发手册</span><ul>${rows}</ul></nav>
<details class="mobile"><summary>章节目录</summary><nav aria-label="选择章节"><ul>${rows}</ul></nav></details>
<main id="main"><h1>${title}</h1>${body}
<nav class="pager" aria-label="翻页">${prev ? `<a rel="prev" href="${prev[0]}.html">← ${prev[1]}</a>` : '<span></span>'}
${next ? `<a rel="next" href="${next[0]}.html">${next[1]} →</a>` : ''}</nav></main>
<nav class="toc" aria-label="本页目录"><span class="navtitle">本页内容</span><ul>${contents}</ul></nav></div>
</body></html>\n`;
  await fs.writeFile(path.join(out, slug + '.html'), html);
}
console.log('Built ' + chapters.length + ' handbook chapters and 2 downloadable examples in dist/handbook');
