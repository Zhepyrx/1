// Bundles Lumencraft into a single self-contained HTML file (worker code inlined as a blob).
//   node build.mjs              -> Lumencraft.html (standalone, open directly in a browser)
//   node build.mjs --fragment F -> also writes an embeddable fragment (no <html>/<head>/<body>) to F
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const fragIdx = args.indexOf('--fragment');
const fragmentOut = fragIdx >= 0 ? args[fragIdx + 1] : null;

const common = { bundle: true, minify: true, write: false, target: ['chrome100', 'firefox110', 'safari16'], legalComments: 'none' };

const worker = await build({ ...common, entryPoints: [join(root, 'src/worker.js')], format: 'iife' });
const workerSrc = worker.outputFiles[0].text;

const main = await build({
  ...common,
  entryPoints: [join(root, 'src/main.js')],
  format: 'esm',
  define: { __WORKER_SRC__: JSON.stringify(workerSrc) },
});
const js = main.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const html = await readFile(join(root, 'index.html'), 'utf8');
const between = (a, b) => html.slice(html.indexOf(a) + a.length, html.indexOf(b)).trim();
const head = between('<!--LC:HEAD-START-->', '<!--LC:HEAD-END-->');
const body = between('<!--LC:BODY-START-->', '<!--LC:BODY-END-->');
const script = `<script type="module">\n${js}\n</script>`;

const standalone = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Lumencraft</title>
${head}
</head>
<body>
${body}
${script}
</body>
</html>
`;
await writeFile(join(root, 'Lumencraft.html'), standalone);
console.log(`Lumencraft.html  ${(standalone.length / 1024).toFixed(0)} KB`);

if (fragmentOut) {
  const fragment = `<title>Lumencraft</title>\n${head}\n${body}\n${script}\n`;
  await writeFile(fragmentOut, fragment);
  console.log(`${fragmentOut}  ${(fragment.length / 1024).toFixed(0)} KB`);
}
