// Pick the demo seed (configs/demo.json): the scripted round trip (fan on, shuffler lift, entrance -> fridge -> entrance)
// under the lockstep clock for each seed; a good seed folds the mat corner on the way in and turns the fan red at the
// fold on the way out. Prints one line per seed; run twice with the same seed to see the trace repeat.
// THROTTLE=n: CPU slowed n× (a laptop on battery). WALL=1: the live page clock (rAF) instead of the recorder's game.tick (the same trace if lockstep holds)
//   node e2e/seed_search.ts '<demo url, e.g. http://localhost:5179/?scene=kitchen4_lighter&demo=1>' <seed> [seed...]
import { CHROME } from './env.ts';
import { chromium } from 'playwright-core';

const [url, ...seeds] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const seed of seeds) {
  const p = await browser.newPage({ viewport: { width: 480, height: 270 } });
  p.on('pageerror', e => console.log('pageerror', String(e)));
  if (process.env.THROTTLE) await (await p.context().newCDPSession(p)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE) });
  await p.goto(`${url}&seed=${seed}`);
  await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 180000 });
  const r = await p.evaluate(`(async () => {
    const game = window.game, mat = game.items.indexOf('mat');
    await game.resetDemo(); game.fan.setLift('shuffler'); game.fan.set(true);
    await game.roundTrip.set(true); game.setAuto(); game.manual = ${!process.env.WALL};
    const w0 = performance.now(), f0 = game.fps, m0 = { ...game.layout().poses[mat] }, out = { seed: ${seed}, foldAt: null, foldLeg: null, lift: 0, outRed: 0, outCatch: 0, outLabel: '', matMoved: 0, end: 0 };
    let legs = [game.roundTrip.leg()];
    for (let t = 0; t < 240 && legs.length < 3; t += 0.25) {
      if (game.manual) await game.tick(0.25);
      else { const k = game.lockstep.ticks() + 15; while (game.lockstep.ticks() < k) await new Promise(r => setTimeout(r, 1)); }
      const leg = game.roundTrip.leg(), f = game.livephys?.fold() ?? game.rugFolds.folds()[0], s = game.fan.state().fan, q = game.layout().poses[mat];
      if (leg !== legs.at(-1)) legs.push(leg);
      if (f && out.foldAt === null) { out.foldAt = +t.toFixed(2); out.foldLeg = leg; }
      if (f) out.lift = Math.max(out.lift, f.lift_m);
      if (leg === 'out' && f && s && s.red > out.outRed) { out.outRed = s.red; out.outCatch = s.catches_month; out.outLabel = game.fan.state().label; }
      out.matMoved = Math.max(out.matMoved, Math.hypot(q.x - m0.x, q.y - m0.y));
      out.end = t;
    }
    out.legs = legs.join('>'); out.wall_s = +((performance.now() - w0) / 1000).toFixed(1); out.fps = +game.fps.toFixed(0); out.ticks = game.lockstep.ticks(); out.events = game.livephys?.events.map(e => e.kind.split('_').map(w => w[0]).join('') + e.t.toFixed(1)).join(' ');
    return out;
  })()`);
  console.log(JSON.stringify(r));
  await p.close();
}
await browser.close();
