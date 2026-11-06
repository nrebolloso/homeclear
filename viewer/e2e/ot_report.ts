// The OT report PDF for the demo (proof/demo/OT_report.pdf): seed 7, the scripted round trip run to the fold, then the
// report page (report.ts, with the planner's options) printed by headless Chrome.
//   node e2e/ot_report.ts [out.pdf] [url]      needs `npm run dev` (5179)
import { CHROME, ROOT } from './env.ts';
import { chromium } from 'playwright-core';
const [out = `${ROOT}proof/demo/OT_report.pdf`, url = 'http://localhost:5179/?scene=kitchen4_lighter&demo=1&rugfold=1&seed=7'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('pageerror', String(e)));
await p.goto(url);
await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 180000 });
await p.click('#resetdemo'); await p.waitForTimeout(3000);
// configs/demo.json's run: the shuffler's round trip until the rug corner folds, then settle
const r = await p.evaluate(`(async () => { const game = window.game, folded = () => !!(game.livephys?.fold() ?? game.rugFolds.folds()[0]); await game.planfix.ready;
  game.fan.setLift('shuffler'); await game.roundTrip.set(true); game.setAuto(); game.manual = true;
  for (let t = 0; t < 60; t += 0.25) { await game.tick(0.25); if (folded()) break; }
  await game.tick(2); return { seed: game.lockstep.seed, folds: folded(), per_month: game.current().per_month }; })()`) as any;
console.log('state', JSON.stringify(r));
if (r.seed !== 7 || !r.folds) throw new Error('not the demo state (seed 7, rug folded)');
const [rep] = await Promise.all([ctx.waitForEvent('page'), p.evaluate('window.game.openReport().then(() => 0)')]);
await rep.waitForURL(/report\.html/); await rep.waitForSelector('h1');
await rep.pdf({ path: out, format: 'Letter', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
console.log('wrote', out);
await browser.close();
