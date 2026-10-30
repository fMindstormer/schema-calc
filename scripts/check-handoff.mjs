// Checks the built playground in Chromium: the one-cent shortcut, then the handoff.
// Each case downloads the schema, the record and validate.py through the page, and
// runs the page's own command in a directory holding only those files, with a fresh
// venv containing only jsonschema. Needs `npm run build` and
// `npx playwright install chromium` first.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = `${root}bench/scratch/handoff`;
const python = process.env.PYTHON || 'python3';
const port = 4174, url = `http://127.0.0.1:${port}/`;
const server = spawn(process.execPath, [`${root}scripts/serve.mjs`], { env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'inherit'] });
// A failed setup or browser launch exits without reaching the finally block below.
process.on('exit', () => server.kill());
await new Promise(resolve => server.stdout.once('data', resolve));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const venvPython = `${out}/venv/bin/python`;
execFileSync(python, ['-m', 'venv', `${out}/venv`]);
execFileSync(venvPython, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', 'jsonschema==4.25.1']);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const state = () => page.locator('#result').getAttribute('data-state');
  const settle = () => page.waitForFunction(() => ['valid', 'invalid', 'error'].includes(document.querySelector('#result').dataset.state) && !document.querySelector('#download').disabled);
  const record = async () => JSON.parse(await page.locator('#record').inputValue());
  await page.goto(url);
  await settle();
  assert.equal(await state(), 'valid', 'initial invoice is accepted');

  // The shortcut changes only the total of the record as edited, and accumulates.
  const edited = { subtotal: '200.00', shipping: '0.00', discount: '5.00', total: '195.00' };
  await page.locator('#record').fill(JSON.stringify(edited, null, 2));
  await settle();
  assert.equal(await state(), 'valid', 'edited invoice is accepted');
  await page.click('#tamper'); await settle();
  assert.deepEqual(await record(), { ...edited, total: '195.01' });
  assert.equal(await state(), 'invalid');
  await page.click('#tamper'); await settle();
  assert.deepEqual(await record(), { ...edited, total: '195.02' }, 'a second click adds another cent');
  console.log('shortcut: total 195.00 -> 195.01 -> 195.02, other fields unchanged, rejected');

  // Without the field, the shortcut is disabled and says why; reset restores the preset.
  await page.locator('#contract').fill(JSON.stringify({ fields: ['a', 'b'], constraints: ['a = b'] }));
  await page.locator('#record').fill('{"a":"1.00","b":"1.00"}');
  await settle();
  assert.equal(await page.locator('#tamper').isDisabled(), true);
  assert.match(await page.locator('#record-help').textContent(), /no total field/);
  await page.click('#reset'); await settle();
  assert.equal(await page.locator('#tamper').isDisabled(), false);

  async function handoff(label) {
    const dir = `${out}/${label}`;
    mkdirSync(dir);
    for (const selector of ['#download', '#download-record', 'a[href="./validate.py"]']) {
      const [download] = await Promise.all([page.waitForEvent('download'), page.click(selector)]);
      await download.saveAs(`${dir}/${download.suggestedFilename()}`);
    }
    // The second line of the page's command, run with the venv's interpreter.
    const [, ...args] = (await page.locator('#handoff-command').textContent()).split('\n')[1].split(' ');
    let output, code = 0;
    try { output = execFileSync(venvPython, ['-I', ...args], { cwd: dir, encoding: 'utf8' }); }
    catch (error) { output = error.stdout; code = error.status; }
    const decision = (await state()) === 'valid' ? 'ACCEPT' : 'REJECT';
    assert.equal(output.trim(), await page.locator('#handoff-expected').textContent(), `${label}: Python agrees with the page`);
    assert.ok(output.startsWith(decision));
    assert.equal(code, decision === 'ACCEPT' ? 0 : 1);
    console.log(`${label}: page ${decision}, python "${output.trim()}" (exit ${code}) with only ${readdirSync(dir).sort().join(', ')}`);
  }
  for (const mode of ['flat', 'tally']) {
    await page.selectOption('#encoding', mode);
    await page.click('#reset'); await settle();
    await handoff(`${mode}-accepted`);
    await page.click('#tamper'); await settle();
    await handoff(`${mode}-one-cent`);
  }
} finally {
  await browser.close();
  server.kill();
}
console.log('Handoff check passed.');
