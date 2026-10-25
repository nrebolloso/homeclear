// (software GL: this check reads the DOM and toggles, not frame rate, and a shared GPU loses its context.)
// Layers dock (layers.ts) against the synthetic scene: presets drive the real toggles, V hides the interface, the popover and the View-tab filters stay in sync.
import { chromium } from 'playwright-core';
import { CHROME } from './env.ts';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: [`--use-angle=${process.platform === 'win32' ? 'd3d11' : 'swiftshader'}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
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

  // Evidence: the legend names every kind of evidence and the floor split comes from the scan's coverage grid
  const legend = await page.locator('#lay-info [data-kind="legend"]').innerText();
  for (const w of ['Measured', 'Thinly filmed', 'Inferred', 'Estimated', 'Proposed', 'Designed, not built', 'Simulated']) assert.ok(legend.includes(w), w);
  assert.match(legend, /% of the floor/); assert.equal(await on('provenance'), true); check('Evidence shows the legend with the measured / inferred floor split');
  mkdirSync('e2e/artifacts', { recursive: true }); await page.screenshot({ path: 'e2e/artifacts/layers-evidence.png' });

  // Compare: with no change the strip says so; after a fix the room as it is stays solid and the strip counts hazards
  await page.click('[data-preset="compare"]');
  assert.equal(await on('compare-overlay'), true); assert.match(await page.locator('#lay-info [data-kind="compare"]').innerText(), /no changes yet/); check('Compare with no changes says so');
  await page.evaluate(`(async () => { await window.game.applyFix('remove_rug'); })()`);
  await page.waitForFunction(() => /cleared/.test(document.querySelector('#lay-info [data-kind="compare"]')?.textContent ?? ''), null, { timeout: 60000 });
  assert.match(await page.locator('#lay-info [data-kind="compare"]').innerText(), /\d+ changes?.*hazards? cleared.*remain.*new.*toe contacts\/month [\d.]+ → [\d.]+/);
  assert.equal(await page.evaluate(() => (window as any).game.reimagine.t()), 0); await page.screenshot({ path: 'e2e/artifacts/layers-compare.png' }); check('Compare strip: changes, hazards cleared / remaining / new, toe contacts before → after');
  const moved = await page.evaluate(`(async () => { const cs = await window.game.reimagine.run(); return cs.filter(c => c.kind === 'move').length; })()`) as number;
  if (moved) {   // a suggested move: the object stays at the old spot, a blue copy stands at the new one
    await page.click('[data-preset="compare"]'); await page.waitForFunction(() => (window as any).game.reimagine.overlay());
    assert.ok(await page.evaluate(() => (window as any).game.reimagine.proposedShapes()) >= moved); check('Compare draws a blue shape at each proposed spot');
    await page.screenshot({ path: 'e2e/artifacts/layers-compare-move.png' });
  } else console.log('SKIP no suggested move on this scene');
  await page.click('[data-preset="clean"]'); assert.equal(await page.evaluate(() => (window as any).game.reimagine.t()), 1); check('turning Compare off puts the proposed layout back');
  await page.evaluate(`(async () => { await window.game.resetAll?.(); })()`);
  await page.click('[data-preset="evidence"]');

  // Cost card: pick a moved object and read what the change takes; placeholders and pending fields are labelled
  await page.click('[data-preset="clean"]');
  const mv = await page.evaluate(`(async () => { const cs = await window.game.reimagine.run(); const m = cs.find(c => c.kind === 'move'); if (m) window.game.select(m.name); return m ? m.name : null; })()`) as string | null;
  if (mv) {
    await page.waitForSelector('#costcard:not([hidden])'); const card = await page.locator('#costcard').innerText();
    for (const w of ['Price', 'Time', 'People', 'Installation', 'Who might pay']) assert.ok(card.includes(w), w);
    assert.match(card, /placeholder/i); assert.match(card, /verify/i); assert.match(card, /not a promise of coverage/);
    await page.screenshot({ path: 'e2e/artifacts/layers-costcard.png' });
    await page.click('#costcard .cc-close'); assert.equal(await page.locator('#costcard').isVisible(), false); check('cost card: price, time, people, installation, funding; placeholders and pending fields are labelled');
  } else console.log('SKIP no suggested move for the cost card');
  await page.evaluate(`(async () => { await window.game.resetAll?.(); window.game.select(''); })()`).catch(() => {});

  // Review: dismiss hides the highlight but not the measurement; a second click restores; verdicts persist and export
  await page.click('[data-preset="hazards"]');
  const before = await page.evaluate(() => (window as any).game.spots().length) as number;
  await page.click('#rev-open'); assert.equal(await page.locator('#rev-panel').isVisible(), true);
  assert.equal(await page.locator('#rev-panel li[data-key]').count(), before);
  const hazardsListed = await page.locator('#hazards li').count();
  await page.locator('#rev-panel li[data-key]').first().locator('[data-act="dismissed"]').click();
  assert.equal(await page.evaluate(() => (window as any).game.spots().length), before - 1);
  assert.equal(await page.locator('#hazards li').count(), hazardsListed); check('dismissing hides the highlight; the measured findings list is unchanged');
  await page.locator('#rev-panel li[data-key]').first().locator('input').fill('edge is taped down'); await page.locator('#rev-panel li[data-key]').first().locator('input').press('Tab');
  const stored = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('homeclear.review.game_synth') ?? '{}')) as any[]);
  assert.equal(stored.length, 1); assert.equal(stored[0].verdict, 'dismissed'); assert.equal(stored[0].note, 'edge is taped down'); check('verdict and note are saved in the browser');
  await page.reload(); await page.waitForFunction(() => (window as any).game?.review, null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => (window as any).game.spots().length), before - 1); check('a dismissal survives a reload');
  await page.click('#rev-open'); await page.locator('#rev-panel li[data-key]').first().locator('[data-act="dismissed"]').click();
  assert.equal(await page.evaluate(() => (window as any).game.spots().length), before); check('a second click on Dismiss puts the highlight back');
  await page.locator('#rev-panel li[data-key]').first().locator('[data-act="confirmed"]').click();
  assert.equal(await page.locator('#rev-panel li[data-verdict="confirmed"]').count(), 1); assert.match(await page.locator('#rev-panel .rev-note').innerText(), /not the blind answer key/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#rev-export')]); assert.match(dl.suggestedFilename(), /^hazard_review_game_synth\.json$/); check('review exports as JSON and says it is not the answer key');
  await page.screenshot({ path: 'e2e/artifacts/layers-review.png' });
  await page.keyboard.press('Escape'); await page.evaluate(() => localStorage.removeItem('homeclear.review.game_synth'));

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
