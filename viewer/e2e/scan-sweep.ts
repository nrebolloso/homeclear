import { chromium } from 'playwright-core';
import { CHROME } from './env.ts';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: [`--use-angle=${process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'gl'}`, '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
const errors: string[] = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
try {
  await page.goto(`${process.argv[2] ?? 'http://127.0.0.1:5183'}/?scene=game_synth&noground&nophys`);
  await page.waitForFunction(() => (window as any).game?.scanLibrary, null, { timeout: 60000 });
  const scans = await page.evaluate(() => (window as any).scanLibrary.entries().map((e: any) => e.id));
  for (const id of scans) {
    const result = await page.evaluate(async id => { const ok = await (window as any).scanLibrary.switch(id); if (ok) await Promise.all((window as any).game.debug.splats.map((s: any) => s.initialized)); return ok; }, id);
    assert.ok(result, id); assert.equal(await page.evaluate(() => (window as any).scanLibrary.current()), id);
    await page.waitForTimeout(100);
    console.log(`PASS opens and initializes ${id}`);
  }
  assert.deepEqual(errors, []);
  console.log(`PASS all ${scans.length} exported scans initialize without browser exceptions`);
} finally { await browser.close(); }
