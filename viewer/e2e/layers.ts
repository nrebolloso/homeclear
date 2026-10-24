// (software GL: this check reads the DOM and toggles, not frame rate, and a shared GPU loses its context.)
// Layers dock (layers.ts) against the synthetic scene: presets drive the real toggles, V hides the interface, the popover and the View-tab filters stay in sync.
import { chromium } from 'playwright-core';
import { CHROME } from './env.ts';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors: string[] = []; page.on('pageerror', e => errors.push(String(e)));
const check = (name: string) => console.log('PASS ' + name);
const on = (id: string) => page.isChecked('#' + id);
try {
  await page.goto(`${base}/?scene=game_synth`);
  await page.waitForFunction(() => (window as any).game?.layers, null, { timeout: 60000 });
  assert.equal(await page.locator('#layers').isVisible(), true); check('layers dock is visible without opening any panel');

  await page.click('[data-preset="clean"]');
  for (const id of ['spot', 'heights', 'ghosts', 'heat', 'reimghosts', 'improvement-highlights']) assert.equal(await on(id), false, id);
  assert.equal(await page.inputValue('#reimtags'), 'off');
  assert.equal(await page.getAttribute('[data-preset="clean"]', 'aria-pressed'), 'true'); check('Clean turns every highlight, footstep and label layer off');
  assert.equal(await page.evaluate(() => (window as any).game.debug.overlays[0].visible), false); check('Clean reaches the scene (particle path hidden)');

  await page.click('[data-preset="hazards"]');
  for (const id of ['spot', 'heights', 'ghosts']) assert.equal(await on(id), true, id);
  assert.equal(await on('heat'), false); check('Hazards turns highlights, bump heights and footsteps on');

  await page.click('[data-preset="compare"]');
  assert.equal(await on('reimghosts'), true); assert.equal(await on('spot'), false); assert.equal(await page.inputValue('#reimtags'), 'all'); check('Compare shows old positions and all cost labels');

  await page.click('[data-preset="evidence"]');
  assert.equal(await on('imagfill'), true); assert.equal(await on('heights'), true); check('Evidence shows imagined floor and estimated heights');

  // a toggle changed in the View tab updates the dock; one changed in the popover updates the View tab
  await page.click('#tab-view'); await page.uncheck('#spot');
  assert.equal(await page.locator('#lay-custom').isVisible(), true); check('changing a layer by hand reads as Custom');
  await page.click('#lay-more'); assert.equal(await page.locator('#lay-pop').isVisible(), true);
  await page.locator('#lay-pop [data-layer="spot"] input').check();
  assert.equal(await on('spot'), true); check('popover writes the real control');
  await page.click('#tab-view'); await page.uncheck('#spot');
  assert.equal(await page.locator('#lay-pop [data-layer="spot"] input').isChecked(), false); check('popover follows the View-tab filter');
  await page.keyboard.press('Escape');

  // V hides everything but the room
  await page.mouse.click(800, 400); await page.keyboard.press('v');
  assert.equal(await page.evaluate(() => document.body.classList.contains('clean')), true);
  assert.equal(await page.locator('#planning-panel').isVisible(), false); assert.equal(await page.locator('#status-pills').isVisible(), false);
  assert.equal(await page.locator('#lay-show').isVisible(), true); assert.equal(await page.locator('[data-preset="clean"]').isVisible(), false);
  mkdirSync('e2e/artifacts', { recursive: true }); await page.screenshot({ path: 'e2e/artifacts/layers-hidden.png' }); check('V hides the panels and HUD, leaving a Show UI chip');
  await page.keyboard.press('v');
  assert.equal(await page.locator('#planning-panel').isVisible(), true); check('V brings the interface back');

  // typing in a field never toggles it
  await page.click('[data-preset="hazards"]'); await page.click('#tab-view');
  await page.locator('#route-speed').focus(); await page.keyboard.press('v');
  assert.equal(await page.evaluate(() => document.body.classList.contains('clean')), false); check('V is ignored in a form field');

  await page.click('[data-preset="hazards"]'); await page.screenshot({ path: 'e2e/artifacts/layers-hazards.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); check('mobile layout has no horizontal overflow');
  assert.deepEqual(errors, []); check('no browser exceptions');
} finally { await browser.close(); }
