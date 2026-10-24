// VR checks with no headset: Meta's IWER fakes a Quest 2 (?emulate=quest2), this script moves its head and
// controllers and presses buttons, then reads what the viewer did. Against `npm run dev`:
//   node e2e/xr.ts [http://localhost:5179]        -> PASS/FAIL per check, writes e2e/xr-results.json
// Needs the synthetic scene (tests/make_game_scene.py). Floor frame: metres, +z up; IWER poses are the headset's own
// y-up space, so targets go through the viewer's rig (game.debug.rig) like the real head and hands do.
import { chromium, type Page } from 'playwright-core';
import { CHROME } from './env.ts';
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5179';
const results: { check: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => { results.push({ check: name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };
const G = (p: Page, f: string) => p.evaluate(`(async () => { const game = window.game; ${f} })()`) as Promise<any>;
const f2 = (v: number[]) => `(${v.map(x => x.toFixed(2)).join(', ')})`;

// in-page helpers: point a controller or hand from just below the head at a floor-frame target, with an optional roll
// (radians about the ray, positive = clockwise looking along it), and the head's local yaw; IWER changes apply next frame
const HELPERS = `
window.__xr = {
  dev: () => game.debug.xrDevice,
  aim(input, target, roll = 0) {
    const rig = game.debug.rig, V = rig.position.constructor, Q = rig.quaternion.constructor;
    const h = game.xrPose().head, o = new V(h[0], h[1], h[2] - 0.45), t = new V(...target);
    rig.updateWorldMatrix(true, false);
    const lo = rig.worldToLocal(o.clone()), lt = rig.worldToLocal(t.clone());
    // like a wrist: -z at the target with the headset's up kept up (setFromUnitVectors would add a roll on big swings,
    // which the wand reads as a twist), then the deliberate roll about the ray
    const m = new rig.matrix.constructor().lookAt(lo, lt, new V(0, 1, 0));
    const q = new Q().setFromRotationMatrix(m).multiply(new Q().setFromAxisAngle(new V(0, 0, -1), roll));
    input.position.set(lo.x, lo.y, lo.z); input.quaternion.set(q.x, q.y, q.z, q.w);
  },
  ctl: (hand) => game.debug.xrDevice.controllers[hand],
  hand: (hand) => game.debug.xrDevice.hands[hand],
  headYaw(a) { const d = game.debug.xrDevice; d.quaternion.set(0, Math.sin(a / 2), 0, Math.cos(a / 2)); },
  proxy(name) { const it = game.debug.items[game.items.indexOf(name)], V = game.debug.rig.position.constructor; return it.proxy.getWorldPosition(new V()).toArray(); },
};`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`, '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`${BASE}/?scene=game_synth&emulate=quest2`);
  await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 60000 });
  await p.evaluate(HELPERS);
  const wait = (ms = 250) => p.waitForTimeout(ms);

  // 1. ENTER VR: the session starts, you stand on filmed floor, the walker is at your feet
  const s0perf = await G(p, 'return game.perf.on()');
  await p.getByText('ENTER VR', { exact: true }).click();
  await p.waitForFunction(() => (window as any).game.xr, null, { timeout: 10000 });
  await wait(500);
  const s0 = await G(p, 'const x = game.xrPose(); return { ...x, cell: game.cell(x.head[0], x.head[1]) }');
  check('enter VR on filmed floor, walker at your feet', s0.xr && s0.cell.floor && !s0.cell.obst && s0.cell.cov > 0 &&
    Math.hypot(s0.walker[0] - s0.head[0], s0.walker[1] - s0.head[1]) < 0.01,
    `head ${f2(s0.head)}, cell floor=${s0.cell.floor} cov=${s0.cell.cov}, walker ${f2(s0.walker)}, inputs ${s0.inputs.join(' ')}`);

  // 1b. in the headset hazard labels are scene cards (DOM labels don't render in WebXR); a standalone Quest is in performance mode
  const inVR = await G(p, "const lbl = () => game.debug.overlays[2].children.map(r => r.children[0]).filter(Boolean).map(o => o.isSprite ? 'card' : o.isCSS2DObject ? 'dom' : '?'); return { labels: lbl(), perf: game.perf.on(), tier: game.debug.xrTier, std: game.debug.spark.maxStdDev }");
  check('headset labels are scene cards, performance mode on', inVR.labels.length > 0 && inVR.labels.every((l: string) => l === 'card') && inVR.perf && inVR.tier === 'quest',
    `labels ${inVR.labels.join(' ')}, perf=${inVR.perf}, tier=${inVR.tier}, maxStdDev=${inVR.std}`);

  // 2. a real step: 0.5 m forward in the headset's space moves you 0.5 m along your heading
  await G(p, 'const d = __xr.dev(); d.position.set(d.position.x, d.position.y, d.position.z - 0.5)');
  await wait();
  const s1 = await G(p, 'return game.xrPose()');
  const yaw0 = s0.rig.yaw, moved = [s1.head[0] - s0.head[0], s1.head[1] - s0.head[1]];
  check('physical step is 1:1 along your heading', Math.abs(Math.hypot(...moved) - 0.5) < 0.02 && Math.abs(Math.atan2(moved[1], moved[0]) - yaw0) < 0.05,
    `moved ${Math.hypot(...moved).toFixed(3)} m at ${(Math.atan2(moved[1], moved[0]) * 180 / Math.PI).toFixed(0)} deg, heading ${(yaw0 * 180 / Math.PI).toFixed(0)} deg`);

  // 3. looking 90 deg left turns the walker with you (it eases at 4/s)
  await G(p, '__xr.headYaw(Math.PI / 2)');
  await wait(1500);
  const by = await G(p, 'return game.body.yaw');
  const dy = Math.atan2(Math.sin(by - yaw0 - Math.PI / 2), Math.cos(by - yaw0 - Math.PI / 2));
  check('looking left turns the walker', Math.abs(dy) < 0.1, `walker yaw ${(by * 180 / Math.PI).toFixed(0)} deg, expected ${((yaw0 + Math.PI / 2) * 180 / Math.PI).toFixed(0)}`);
  await G(p, '__xr.headYaw(0)');
  await wait(1500);

  // 4. left trigger held = walk forward, never off filmed floor
  const w0 = await G(p, 'return game.xrPose().head');
  await G(p, "__xr.ctl('left').updateButtonValue('trigger', 1)");
  await wait(1000);
  await G(p, "__xr.ctl('left').updateButtonValue('trigger', 0)");
  await wait();
  const w1 = await G(p, 'const h = game.xrPose().head; return { h, cell: game.cell(h[0], h[1]) }');
  const walked = Math.hypot(w1.h[0] - w0[0], w1.h[1] - w0[1]);
  check('left trigger walks forward on filmed floor', walked > 0.2 && w1.cell.floor && !w1.cell.obst && w1.cell.cov > 0,
    `walked ${walked.toFixed(2)} m to ${f2(w1.h)}`);

  // 5. teleport: point the wand at filmed floor, the ring shows, release lands you there
  const tp = [2.6, 0.5, 0];
  await G(p, `__xr.aim(__xr.ctl('right'), ${JSON.stringify(tp)}); `);
  await wait();
  await G(p, "__xr.ctl('right').updateButtonValue('trigger', 1)");
  await wait();
  const ring = await G(p, 'return game.debug.wand()');
  await G(p, "__xr.ctl('right').updateButtonValue('trigger', 0)");
  await wait();
  const t1 = await G(p, 'return game.xrPose().head');
  check('teleport lands where the wand points', ring.teleport && Math.hypot(t1[0] - tp[0], t1[1] - tp[1]) < 0.05,
    `ring shown=${ring.teleport}, landed ${f2(t1)} for target ${f2(tp)}`);

  // 6. drag + twist: grab the bed, move it to (2.0, 1.0) and roll the wrist a quarter turn (the desktop's known-good spot)
  const bed0 = await G(p, "return game.layout().poses[game.items.indexOf('bed')]");
  const len0 = await G(p, 'return game.current().length_m');
  const bedBox = await G(p, "return __xr.proxy('bed')");
  await G(p, `__xr.aim(__xr.ctl('right'), ${JSON.stringify(bedBox)})`);
  await wait();
  const hov = await G(p, 'return game.debug.wand()');
  await G(p, "__xr.ctl('right').updateButtonValue('trigger', 1)");
  await wait();
  const grabbed = await G(p, 'return game.debug.wand()');
  // the grab keeps the offset between the bed and where the ray met the floor: move that floor point by the same delta
  const fh = await G(p, `const r = game.debug.rig, V = r.position.constructor, h = game.xrPose().head, o = new V(h[0], h[1], h[2] - 0.45),
    t = new V(...${JSON.stringify(bedBox)}), d = t.clone().sub(o).normalize(), k = -o.z / d.z; return [o.x + d.x * k, o.y + d.y * k, 0]`);
  const goal = [fh[0] + 2.0 - bed0.x, fh[1] + 1.0 - bed0.y, 0];
  await G(p, `__xr.aim(__xr.ctl('right'), ${JSON.stringify(goal)}, -Math.PI / 2)`);
  await wait(400);
  await G(p, "__xr.ctl('right').updateButtonValue('trigger', 0)");
  // the release re-plans in the worker: wait for the new route (the desktop test's same move gives 3.67 -> 3.98 m)
  await p.waitForFunction((l0) => { const g = (window as any).game; return Math.abs(g.current().length_m - l0) > 0.01; }, len0, { timeout: 5000 }).catch(() => {});
  const bed1 = await G(p, "return { pose: game.layout().poses[game.items.indexOf('bed')], len: game.current().length_m, err: game.current().error }");
  check('wand hovers, grabs, drags and turns the bed; the route re-plans', hov.hover === 'bed' && grabbed.grab === 'bed' && Math.hypot(bed1.pose.x - 2.0, bed1.pose.y - 1.0) < 0.05 &&
    Math.abs(Math.abs(bed1.pose.yaw - bed0.yaw) - Math.PI / 2) < 0.01 && !bed1.err && Math.abs(bed1.len - len0) > 0.01,
    `hover=${hov.hover} grab=${grabbed.grab}; bed (${bed0.x.toFixed(2)}, ${bed0.y.toFixed(2)}, ${(bed0.yaw * 180 / Math.PI).toFixed(0)}) -> (${bed1.pose.x.toFixed(2)}, ${bed1.pose.y.toFixed(2)}, ${(bed1.pose.yaw * 180 / Math.PI).toFixed(0)} deg), route ${len0.toFixed(2)} -> ${bed1.len?.toFixed(2)} m`);

  // 7. hold still on the nightstand for 1.5 s: it's deleted; the outline goes red first
  const ns = await G(p, "return __xr.proxy('nightstand')");
  await G(p, `__xr.aim(__xr.ctl('right'), ${JSON.stringify(ns)})`);
  await wait();
  await G(p, "__xr.ctl('right').updateButtonValue('trigger', 1)");
  await wait(1000);
  const red = await G(p, "const it = game.debug.items[game.items.indexOf('nightstand')]; const c = it.outline.material.color; return { r: c.r, g: c.g, b: c.b, removed: !!game.layout().poses[game.items.indexOf('nightstand')].removed }");
  await wait(900);
  await G(p, "__xr.ctl('right').updateButtonValue('trigger', 0)");
  await wait();
  const gone = await G(p, "return !!game.layout().poses[game.items.indexOf('nightstand')].removed");
  check('hold still on furniture deletes it (outline reddens first)', !red.removed && red.r > 0.9 && red.g < 0.75 && gone,
    `at 1.0 s outline rgb (${red.r.toFixed(2)}, ${red.g.toFixed(2)}, ${red.b.toFixed(2)}), removed then=${red.removed}; after 1.9 s removed=${gone}`);

  // 8. hands instead of controllers: a right-hand pinch on the floor teleports, same as the trigger
  await G(p, "__xr.dev().primaryInputMode = 'hand'");
  await wait(500);
  const inputs = await G(p, 'return game.xrPose().inputs');
  const tp2 = [3.6, 1.5, 0];   // away from the bed, which now stands at (2.0, 1.0) between you and the room's far side
  await G(p, `__xr.aim(__xr.hand('right'), ${JSON.stringify(tp2)})`);
  await wait();
  await G(p, "__xr.hand('right').updatePinchValue(1)");
  await wait();
  await G(p, "__xr.hand('right').updatePinchValue(0)");
  await wait();
  const t2 = await G(p, 'return game.xrPose().head');
  check('hand pinch teleports like the trigger', inputs.includes('right:hand') && Math.hypot(t2[0] - tp2[0], t2[1] - tp2[1]) < 0.15,
    `inputs ${inputs.join(' ')}; landed ${f2(t2)} for target ${f2(tp2)}`);

  // 9. leaving VR puts the monitor back: DOM labels, performance mode as it was before entering
  await G(p, 'await game.debug.renderer.xr.getSession().end()');
  await p.waitForFunction(() => !(window as any).game.xr, null, { timeout: 5000 }).catch(() => {});
  await wait(300);
  const out = await G(p, "const lbl = () => game.debug.overlays[2].children.map(r => r.children[0]).filter(Boolean).map(o => o.isSprite ? 'card' : o.isCSS2DObject ? 'dom' : '?'); return { xr: game.xr, labels: lbl(), perf: game.perf.on() }");
  check('leaving VR restores DOM labels and performance mode', !out.xr && out.labels.length > 0 && out.labels.every((l: string) => l === 'dom') && out.perf === s0perf,
    `xr=${out.xr}, labels ${out.labels.join(' ')}, perf=${out.perf} (before VR: ${s0perf})`);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');
} finally {
  writeFileSync(new URL('xr-results.json', import.meta.url), JSON.stringify(results, null, 1));
  await browser.close();
}
process.exit(results.every(r => r.pass) ? 0 : 1);
