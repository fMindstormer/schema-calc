import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const port = Number(process.env.PORT || 4173);
const types = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript'], '/worker.js': ['worker.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
createServer(async (req, res) => {
  const asset = types[new URL(req.url, 'http://localhost').pathname];
  if (!asset) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const data = await readFile(new URL(`../dist/${asset[0]}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  } catch {
    res.writeHead(503); res.end('Run npm run build first.');
  }
}).listen(port, '127.0.0.1', () => console.log(`Schema Calc: http://127.0.0.1:${port}`));
