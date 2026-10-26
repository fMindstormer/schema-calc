import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = new URL('../', import.meta.url);
await mkdir(new URL('dist/', root), { recursive: true });
await build({ entryPoints: ['web/app.mjs', 'web/worker.mjs'].map(path => fileURLToPath(new URL(path, root))), outdir: fileURLToPath(new URL('dist/', root)), bundle: true, format: 'esm', minify: true, target: 'es2022', logLevel: 'info' });
for (const name of ['index.html', 'style.css']) await copyFile(new URL(`web/${name}`, root), new URL(`dist/${name}`, root));
