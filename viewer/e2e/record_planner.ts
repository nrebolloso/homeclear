// Record the planner / personalization proof videos (proof/demo/): node e2e/record_planner.ts <planner|planner_vs_judge|personalization|ghosts_kitchen|futures_fan|futures_fan_fridge> <out.mp4> [url]
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
  // the live futures fan (demo mode), standing at the fridge before the walker moves: the fork over / around the mat with
  // the average foot lift, then the low-clearance shuffler (more red at the mat edge), then the mat taped (grid.ts
  // TAPED_EDGE_M: a ~1.5 mm edge, below bump_min) and the fan goes green; then a walk on toward the mat
  futures_fan_fridge: { panel: 'fanpanel', run: `const wait = ms => new Promise(r => setTimeout(r, ms)), key = (t, code) => dispatchEvent(new KeyboardEvent(t, { code }));
    game.setFree(-0.7, 2.2, -0.91); game.setThird(true, 0.9, 1.1); game.fan.setLift('average'); game.fan.set(true); await wait(5000);
    game.fan.setLift('shuffler'); await wait(5000);
    await game.fan.tapeMat(); await wait(5000);
    key('keydown', 'KeyW'); await wait(2500); key('keyup', 'KeyW'); await wait(3000)` },
  // the scripted demo (roundtrip.ts): at the fridge, average vs shuffler lift; then the shuffler's round trip, entrance ->
  // fridge -> entrance under live physics with the fan following each leg; then the mat taped and the fan goes green
  futures_fan: { panel: 'fanpanel', run: `const wait = ms => new Promise(r => setTimeout(r, ms));
    game.setFree(-0.7, 2.2, -0.91); game.setThird(true, 0.9, 1.1); game.fan.setLift('average'); game.fan.set(true); await wait(8000);
    game.fan.setLift('shuffler'); await wait(8000);   // 8 s each: a lift's first fan or two can still be the previous lift's
    await game.roundTrip.set(true); game.setAuto(); const legs = [game.roundTrip.leg()];
    for (let i = 0; i < 300 && legs.length < 3; i++) { await wait(250); if (game.roundTrip.leg() !== legs.at(-1)) legs.push(game.roundTrip.leg()); }
    game.setFree(game.body.x, game.body.y, game.body.yaw); await game.fan.tapeMat(); await wait(5000)` },
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
