// Record the planner / personalization proof videos (proof/demo/): node e2e/record_planner.ts <planner|planner_vs_judge|personalization|ghosts_kitchen> <out.mp4> [url]
// Needs `npm run dev` (5179), ffmpeg, and the published planner search + persona (planner/publish.sh, worldmodel/persona.py).
import { CHROME } from './env.ts';
import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const [shot, out, url = 'http://localhost:5179/?scene=kitchen4_lighter'] = process.argv.slice(2);
const SHOTS: Record<string, { panel: string; run: string }> = {
  // the B200 search replayed: chairs glide, fans of imagined trips, the risk-vs-effort chart fills, ends on the options
  planner: { panel: 'planfixpanel', run: 'await game.planfix.play(30); await new Promise(r => setTimeout(r, 5000))' },
  // a judge's edit (chair8 pushed toward the wall, mat edges taped) -> the critic searches from it -> "your layout X -> AI Y"
  planner_vs_judge: { panel: 'planfixpanel', run: `await game.moveObject('chair8', 1.6, -0.9, 0); document.getElementById('pfmattaped').checked = true;
    await new Promise(r => setTimeout(r, 2500)); await game.planfix.improve(4000); await new Promise(r => setTimeout(r, 6000))` },
  // a held-out PhysioNet walker as "the user": the embedding is fitted live from walker + head, then "Re-plan for me"
  personalization: { panel: 'gaitfitpanel', run: `await game.gait.play(8); document.getElementById('planfixpanel').scrollIntoView();
    await game.gait.replan(); await new Promise(r => setTimeout(r, 6000))` },
  // the world model life-size (demo mode: pass ...&demo=1): two gait styles from the fridge, a swap, the futures fan near the
  // mat, then a month of trips as scanned and after the planner's fixes
  ghosts_kitchen: { panel: 'wmghostpanel', run: `const W = game.wmghosts, wait = ms => new Promise(r => setTimeout(r, ms));
    await W.twoStyles('P07 (training)'); await wait(11000); await W.twoStyles('P10 (training)'); await wait(3000);
    await W.twoStyles('P10 (training)'); game.setFly(-0.9, -0.6, 1.7, 54, -40); await wait(8000);
    await W.month('before'); await wait(21000); await W.month('after'); await wait(21000); W.stop(); await game.planfix.goto(game.planfix.layouts().scan)` },
};
const S = SHOTS[shot];
if (!S || !out) { console.error(`usage: record_planner.ts <${Object.keys(SHOTS).join('|')}> <out.mp4> [url]`); process.exit(2); }
const dir = mkdtempSync(`${tmpdir()}/rec-`);
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-accelerated-video-decode'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir, size: { width: 1600, height: 900 } } });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('pageerror', String(e)));
const tg = Date.now();
await p.goto(url);
await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 120000 });
await p.evaluate(`(async () => { const game = window.game; game.setFly(0.4, 0.1, 5.2, -90, -89); await game.planfix.ready;
  document.getElementById('${S.panel}').scrollIntoView(); })()`);   // top-down over the kitchen, the panel in view
await p.waitForTimeout(1500);
const t0 = Date.now();
await p.evaluate(`(async () => { const game = window.game; ${S.run} })()`);
await ctx.close(); await browser.close();
const webm = `${dir}/${readdirSync(dir)[0]}`;
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String((t0 - tg) / 1000 - 1), '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out], { stdio: 'inherit' });
rmSync(dir, { recursive: true });
process.exit(r.status ?? 1);
