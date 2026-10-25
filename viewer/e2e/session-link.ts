import { chromium } from 'playwright-core';
import { CHROME } from './env.ts';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: [`--use-angle=${process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'gl'}`, '--enable-gpu', '--ignore-gpu-blocklist'] });
const host = await browser.newPage({ viewport: { width: 1000, height: 700 } }), companion = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors: string[] = []; for (const page of [host, companion]) page.on('response', r => { if (r.status() >= 400) console.log(r.status(), r.url()); }); for (const page of [host, companion]) { page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(String(e))); }
const base = process.argv[2] ?? 'http://127.0.0.1:5183';
try {
  for (const page of [host, companion]) { await page.goto(`${base}/?scene=game_synth&noground&nophys`); await page.waitForFunction(() => (window as any).game?.scanLibrary); }
  await host.evaluate(() => (window as any).sessionLink.connect('test-paired-devices', 'host'));
  await companion.evaluate(() => (window as any).sessionLink.connect('test-paired-devices', 'companion'));
  await companion.waitForFunction(() => document.getElementById('session-status')?.textContent?.includes('synchronized'));
  await companion.evaluate(async () => { const g = (window as any).game; await g.sharedEdit(g.items[0], () => g.removeObject(g.items[0])); });
  await host.waitForFunction(() => (window as any).game.layout().poses[0].removed);
  await companion.waitForFunction(() => (window as any).game.layout().poses[0].removed);
  console.log('PASS separate-device companion submits edits to the authoritative host and receives evaluated state');
  await companion.evaluate(() => (window as any).game.history.undo());
  await host.waitForFunction(() => !(window as any).game.layout().poses[0].removed);
  await companion.waitForFunction(() => !(window as any).game.layout().poses[0].removed);
  assert.equal(await companion.evaluate(() => (window as any).scanLibrary.switch('game_synth_narrow')), true);
  await companion.waitForFunction(() => (window as any).scanLibrary.current() === 'game_synth_narrow');
  assert.equal(await host.evaluate(() => (window as any).scanLibrary.current()), 'game_synth_narrow');
  console.log('PASS remote undo and scan changes stay synchronized');
  await companion.evaluate(() => (window as any).sessionLink.disconnect());
  assert.equal(await companion.evaluate(() => (window as any).game.remoteSession), false);
  assert.deepEqual(errors, []);
} catch (error) { for (const page of [host, companion]) console.log(await page.evaluate(() => ({ status: document.getElementById('session-status')?.textContent, pending: (window as any).game?.pending(), role: (window as any).sessionLink?.role() }))); throw error; } finally { await browser.close(); }
