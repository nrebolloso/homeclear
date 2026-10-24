// Headless checks for the physics debug views, hazard highlights and the hazard tour (SYNTHETIC scene):
//   npx vite --port 5179 &   node e2e/physdebug.ts [http://localhost:5179]
// SHOTS=<dir> saves a screenshot at each visual check. Needs the synthetic scene (tests/make_game_scene.py), no Python at run time.
import { CHROME } from './env.ts';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://localhost:5179';
const results: { check: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => { results.push({ check: name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };
const shot = (p: Page, name: string) => process.env.SHOTS ? p.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : null;
const G = (p: Page, f: string) => p.evaluate(`(async () => { const game = window.game; ${f} })()`) as Promise<any>;

const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-accelerated-video-decode'] });
try {
  const p = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`${BASE}/?scene=game_synth`);
  await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 60000 });
  await p.waitForTimeout(1500);

  // hazard highlights: the objects behind measured hazards glow, the toggle turns them off
  const sp = await G(p, 'return game.spots().map(s => ({ kind: s.kind, object: s.object, label: s.label, sev: s.severity }))');
  check('spotlights: measured hazards listed, worst first, bumps tied to their object', sp.length >= 2 && sp.every((s: any) => s.kind === 'measured') && sp.some((s: any) => s.object >= 0), JSON.stringify(sp));
  await G(p, 'game.setFree(1.2, 1.3, 0)');
  await p.waitForTimeout(500);
  await shot(p, 'spot_on');
  await p.evaluate(() => { (document.getElementById('spot') as HTMLInputElement).click(); });
  await p.waitForTimeout(300);
  const off = await G(p, 'return game.spots().length');
  check('spotlights: toggle off keeps the list, clears the glow', off === sp.length, `${off} spots`);
  await p.evaluate(() => { (document.getElementById('spot') as HTMLInputElement).click(); });

  // height overlay
  await p.evaluate(() => { (document.getElementById('heights') as HTMLInputElement).click(); });
  await p.waitForTimeout(400);
  await shot(p, 'heights');
  check('bump heights overlay switches on without errors', errors.length === 0, errors.join('; ') || 'no errors');
  await p.evaluate(() => { (document.getElementById('heights') as HTMLInputElement).click(); });

  // physics: summary, chart, trail, replay
  const ph = await G(p, `const r = await game.physicsPass(); const c = document.getElementById('pushchart');
    return { n: r.length, trace: r[0].trace.length, done: r.every(x => x.done), chart: !c.hidden, info: document.getElementById('physinfo').textContent,
             replayBtn: !document.getElementById('replay').hidden }`);
  check('physics pass records a trace and shows the push chart + summary', ph.trace > 20 && ph.chart && ph.replayBtn && /hardest push/.test(ph.info), JSON.stringify(ph));
  await p.evaluate(() => document.getElementById('physinfo')!.scrollIntoView());
  await shot(p, 'physics_chart');
  await G(p, 'game.startReplay()');
  await p.waitForTimeout(1200);
  const rp = await G(p, 'return { ...game.replayState(), cap: document.getElementById("replaycap").textContent }');
  check('replay: the pushed walker moves along its recorded trace with a caption', rp.on && rp.t > 0.5 && /push \d+\/\d+ N/.test(rp.cap), JSON.stringify(rp));
  await shot(p, 'replay');
  await G(p, 'game.stopReplay()');
  check('replay stops and gives the live walker back', !(await G(p, 'return game.replayState().on')), 'stopped');

  // a walker that never gets there is reported as stuck, not as "no snags"
  await G(p, 'game.physicsCfg = { push_max_n: 20, stall_s: 600 }');
  const stuck = await G(p, `const r = await game.physicsPass(); const li = [...document.querySelectorAll("#snags li")].map(x => x.textContent);
    const bad = r.filter(x => !x.done); return { stuck: bad.length, flagged: bad.filter(x => li.some(t => t.startsWith(x.name + ": walker STUCK"))).length,
      wronglyClear: bad.filter(x => li.some(t => t.startsWith(x.name + ": no snags"))).length }`);
  check('stuck walker is reported as STUCK in the panel (not "no snags")', stuck.stuck >= 1 && stuck.flagged === stuck.stuck && stuck.wronglyClear === 0, JSON.stringify(stuck));
  await G(p, 'game.physicsCfg = undefined; await game.physicsPass()');

  // hazard tour
  await G(p, 'game.startTour()');
  await p.waitForTimeout(2200);
  const t1 = await G(p, 'return { ...game.tourState(), cap: !document.getElementById("tourcap").hidden, text: document.getElementById("tourcap").textContent }');
  check('hazard tour flies to the worst hazard and holds with its caption', t1.on && t1.phase === 'hold' && t1.cap && /1\//.test(t1.text), JSON.stringify(t1));
  await shot(p, 'tour_1');
  await p.keyboard.press('KeyX');
  await p.waitForTimeout(200);
  check('a key press ends the tour', !(await G(p, 'return game.tourState().on')), 'ended');

  check('no page errors', errors.length === 0, errors.join('; ') || 'none');
  await p.close();
} finally {
  await browser.close();
}
process.exit(results.length && results.every(r => r.pass) ? 0 : 1);
