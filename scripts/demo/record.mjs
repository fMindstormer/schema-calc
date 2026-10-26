// Records the four-step demonstration. Every playground state is real, the files are
// the browser's actual downloads, and the terminal shows the captured output of
// running the real commands on those files in a fresh venv. Writes docs/demo.gif and
// its reduced-motion poster docs/demo.png. Needs `npm run build`,
// `npx playwright install chromium`, ffmpeg and ImageMagick.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = `${root}bench/scratch/demo`, python = process.env.PYTHON || 'python3';
const stageUrl = new URL('stage.html', import.meta.url).href, port = 4175, appUrl = `http://127.0.0.1:${port}/`;
const server = spawn(process.execPath, [`${root}scripts/serve.mjs`], { env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(resolve => server.stdout.once('data', resolve));
const files = `${out}/files`, venv = `${out}/venv`;
rmSync(out, { recursive: true, force: true }); mkdirSync(files, { recursive: true });
execFileSync(python, ['-m', 'venv', venv]);
execFileSync(`${venv}/bin/python`, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', 'jsonschema==4.25.1']);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 960, height: 600 }, acceptDownloads: true, recordVideo: { dir: `${out}/video`, size: { width: 960, height: 600 } } });
const born = Date.now();
const page = await context.newPage();
await page.goto(stageUrl);
await page.evaluate(src => { document.getElementById('app').src = src; }, appUrl);
const frame = await (await page.waitForSelector('#app')).contentFrame();
await frame.waitForFunction(() => document.querySelector('#result')?.dataset.state === 'valid');
const state = () => frame.locator('#result').getAttribute('data-state');
const stage = (method, ...args) => page.evaluate(([m, a]) => window.stage[m](...a), [method, args]);
const sleep = ms => page.waitForTimeout(ms);
async function click(selector) {
  const box = await frame.locator(selector).boundingBox();
  await stage('point', box.x + box.width / 2, box.y + box.height / 2);
  await stage('press');
  await frame.click(selector);
}
// Shorter editors, as a visitor might resize them, so the verdict is in frame.
await frame.addStyleTag({ content: 'textarea { height: 168px !important; }' });
await frame.evaluate(() => window.scrollTo(0, document.querySelector('.workspace-heading').getBoundingClientRect().top + scrollY - 4));
await stage('caption', 1, 'The correct invoice is accepted', '127.50 + 4.95 − 10.00 = 122.45');
await sleep(400);
const start = (Date.now() - born) / 1000;
await sleep(3200);

await stage('caption', 2, 'Add one cent to the total');
await click('#tamper');
await frame.waitForFunction(() => document.querySelector('#result').dataset.state === 'invalid');
assert.equal(JSON.parse(await frame.locator('#record').inputValue()).total, '122.46');
await stage('caption', 2, 'Add one cent to the total: rejected', 'total 122.46');
await sleep(2600);
await stage('hideCursor');
await page.screenshot({ path: `${out}/poster-browser.png` });

await stage('caption', 3, 'Download the schema, the record and validate.py');
await frame.evaluate(() => window.scrollTo({ top: document.querySelector('.artifact').getBoundingClientRect().top + scrollY - 10, behavior: 'smooth' }));
await sleep(1000);
for (const selector of ['#download', '#download-record', 'a[href="./validate.py"]']) {
  const [download] = await Promise.all([page.waitForEvent('download'), click(selector)]);
  await download.saveAs(`${files}/${download.suggestedFilename()}`);
  await stage('file', download.suggestedFilename());
  await sleep(350);
}
await sleep(1100);

// Run the real commands on the downloaded files before replaying them.
const env = { PATH: `${venv}/bin:/usr/bin:/bin` };
const sh = args => execFileSync(args[0], args.slice(1), { cwd: files, env, encoding: 'utf8' }).trimEnd();
const listing = sh(['ls', '-1']);
const packages = sh(['python3', '-m', 'pip', 'list', '--format=freeze', '--disable-pip-version-check']);
let verdict, code = 0;
try { verdict = sh(['python3', 'validate.py', 'invoice.schema.json', 'invoice.record.json']); }
catch (error) { verdict = error.stdout.trimEnd(); code = error.status; }
assert.equal(verdict, 'REJECT  invoice.record.json'); assert.equal(code, 1);
assert.ok(!/schema.?calc/i.test(packages), 'Schema Calc is not installed');
writeFileSync(`${out}/transcript.txt`, `$ ls -1\n${listing}\n$ python3 -m pip list --format=freeze\n${packages}\n$ python3 validate.py invoice.schema.json invoice.record.json\n${verdict}\n(exit ${code})\n`);

await stage('caption', 4, 'Stock Python jsonschema, no Schema Calc installed');
await stage('showTerminal');
await sleep(500);
await stage('run', 'ls -1', listing);
await stage('run', 'python3 -m pip list --format=freeze', packages);
await stage('run', 'python3 validate.py invoice.schema.json invoice.record.json', verdict, 'reject');
await stage('caption', 4, 'Stock Python jsonschema: rejected too', 'no Schema Calc installed');
await sleep(3200);
await page.screenshot({ path: `${out}/poster-terminal.png` });
const end = (Date.now() - born) / 1000;
await context.close();
await browser.close();
server.kill();
const video = await page.video().path();
// 10 fps, 880 px wide, a shared palette; then the step 2 and step 4 stills, stacked.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(start), '-t', (end - start - 0.3).toFixed(2), '-i', video, '-vf',
  'fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  '-loop', '0', `${root}docs/demo.gif`]);
execFileSync('magick', [`${out}/poster-browser.png`, '(', `${out}/poster-terminal.png`, '-crop', '960x480+0+0', '+repage', ')',
  '-append', '+repage', '-resize', '880x', '-strip', `${root}docs/demo.png`]);
console.log(`docs/demo.gif: ${(end - start).toFixed(1)} s; transcript in bench/scratch/demo/transcript.txt`);
