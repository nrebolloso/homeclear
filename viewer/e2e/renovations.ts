// Guided marking and renovation regressions on the desktop and an IWER Quest 2. Real stair measurements are checked
// only when that local export is present. No hardware headset or cluster access needed.
import { chromium, type Page } from 'playwright-core';
import { existsSync, writeFileSync } from 'node:fs';
import { CHROME, ROOT } from './env.ts';

const BASE = process.argv[2] ?? 'http://localhost:5179';
const results: { check: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: unknown) => {
  results.push({ check: name, pass, detail: JSON.stringify(detail) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
};
const G = (p: Page, f: string) => p.evaluate(`(async () => { const game = window.game; ${f} })()`) as Promise<any>;
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const errors: string[] = [];
async function open(scene: string, xr = false) {
  const p = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  p.on('pageerror', e => errors.push(String(e)));
  await p.goto(`${BASE}/?scene=${scene}${xr ? '&emulate=quest2' : ''}`);
  await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 60000 });
  return p;
}
try {
  const p = await open('game_synth');
  await G(p, 'game.setFree(1, 1, 0); game.body.pitch = -0.8; game.marker.begin("door")');
  await p.mouse.move(800, 450); await p.waitForTimeout(300);
  const pointer = await G(p, 'return game.marker.state().pointer');
  check('desktop surface pointer updates each frame', !!pointer, pointer);
  await p.mouse.click(800, 450); await p.waitForTimeout(150);
  const one = await G(p, 'return game.marker.state().marking?.pts.length');
  await p.mouse.move(800, 450); await p.mouse.down(); await p.mouse.move(900, 480, { steps: 8 }); await p.mouse.up();
  const drag = await G(p, 'return game.marker.state().marking?.pts.length');
  check('click places one point; dragging the view places none', one === 1 && drag === 1, { one, drag });
  await p.mouse.click(900, 480, { button: 'right' });
  const undo = await G(p, 'return game.marker.state().marking?.pts.length');
  await p.keyboard.press('Space');
  const centre = await G(p, 'return game.marker.state().marking?.pts.length');
  await p.keyboard.press('Escape');
  check('right click undoes, Space places at centre, Escape cancels', undo === 0 && centre === 1 && !await G(p, 'return game.marker.state().marking'), { undo, centre });
  await G(p, 'game.marker.begin("door"); await game.marker.place([4.05, 1.1, 1]); await game.marker.place([4.05, 1.9, 1])');
  const marked = await G(p, 'return game.marker.state()');
  check('finishing a doorway exposes editable handles', marked.editing && marked.handles.length === 2, marked.handles);
  const owner = marked.handles[0].owner;
  await G(p, `await game.marker.dragHandle(${JSON.stringify(owner)}, 'b', [4.05, 1.95, 1])`);
  const edited = await G(p, 'return game.doors.list()[0]');
  check('dragging a jamb remeasures and persists the doorway', Math.abs(edited.b[1] - 1.95) < 1e-6, edited);
  await G(p, 'game.marker.done()'); await p.reload();
  await p.waitForFunction(() => (window as any).game?.ready);
  check('saved annotations load without initialization errors', await G(p, 'return game.doors.list()[0].b[1] === 1.95'), 'reload');
  await p.close();

  const real = ['kitchen4_lighter_objects', 'kitchen4_lighter'].find(s => existsSync(`${ROOT}viewer/public/scene/${s}/scene.json`));
  if (real) {
    const k = await open(real);
    await G(k, 'game.marker.begin("stairs"); await game.marker.place([4.28, -0.68, 0.18]); await game.marker.place([3.48, -0.68, 0.18]); await game.marker.place([3.88, -1.6, 0.72])');
    const st = await G(k, 'return game.stairs.list()[0]');
    check('REAL scan: guided stair marking records the clicked landing height and measured treads', st.top_z === 0.72 && st.treads_z.length >= 3, st);
    await G(k, `await game.applyFix('stair_walker:${st.name}'); game.marker.done()`);
    const park = await G(k, `const s = game.stairs.list()[0], x = (s.bottom[0][0] + s.bottom[1][0]) / 2, y = (s.bottom[0][1] + s.bottom[1][1]) / 2,
      yaw = Math.atan2(s.top[1] - y, s.top[0] - x); return { x: s.top[0] + Math.cos(yaw) * 0.1, y: s.top[1] + Math.sin(yaw) * 0.1, yaw }`);
    await G(k, `await game.marker.moveWalker(${JSON.stringify(st.name)}, ${JSON.stringify(park)})`);
    const placed = await G(k, `const id = 'stair_walker:${st.name}', f = game.debug.stairs.children.flatMap(c => c.children).find(c => c.children.some(x => x.userData.parked === id));
      return { p: game.layout().placed[id], z: f?.position.z, changes: game.describeChanges(), receipt: document.getElementById('receipt').textContent }`);
    check('parked walker stays at landing height and moves its receipt/report position', placed.z === st.top_z && placed.p && placed.receipt.includes('parked') && placed.changes.some((c: any) => c.at?.[0] === placed.p.x), placed);
    await G(k, `await game.marker.moveWalker(${JSON.stringify(st.name)}, null)`);
    check('putting a parked walker back clears its placement override', await G(k, `return !game.layout().placed?.['stair_walker:${st.name}']`), 'default pose');
    await G(k, 'game.stairs.view(); game.marker.edit()'); await k.waitForTimeout(300);
    if (process.env.SHOTS) await k.screenshot({ path: `${process.env.SHOTS}/renovation_marks.png` });
    await k.close();
  }

  const v = await open('game_synth', true);
  await v.getByText('ENTER VR', { exact: true }).click();
  await v.waitForFunction(() => (window as any).game.xr);
  await G(v, `window.__aimMark = (target, roll = 0) => {
    const rig = game.debug.rig, V = rig.position.constructor, Q = rig.quaternion.constructor, c = game.debug.xrDevice.controllers.right,
      h = game.xrPose().head, o = rig.worldToLocal(new V(h[0], h[1], h[2] - 0.1)), t = rig.worldToLocal(new V(...target)),
      m = new rig.matrix.constructor().lookAt(o, t, new V(0, 1, 0)), q = new Q().setFromRotationMatrix(m).multiply(new Q().setFromAxisAngle(new V(0, 0, -1), roll));
    c.position.set(o.x, o.y, o.z); c.quaternion.set(q.x, q.y, q.z, q.w);
  }`);
  const button = async (hand: string, name: string) => {
    await G(v, `game.debug.xrDevice.controllers.${hand}.updateButtonValue('${name}', 1)`); await v.waitForTimeout(150);
    await G(v, `game.debug.xrDevice.controllers.${hand}.updateButtonValue('${name}', 0)`); await v.waitForTimeout(150);
  };
  await button('left', 'x-button');
  check('VR off-hand X starts doorway marking', await G(v, 'return game.marker.state().marking?.kind === "door"'), 'controller event');
  await G(v, `const rig = game.debug.rig, V = rig.position.constructor, Q = rig.quaternion.constructor, c = game.debug.xrDevice.controllers.right,
    h = game.xrPose().head, o = rig.worldToLocal(new V(h[0], h[1], h[2] - 0.45)), t = rig.worldToLocal(new V(3, 1, 0)),
    m = new rig.matrix.constructor().lookAt(o, t, new V(0, 1, 0)), q = new Q().setFromRotationMatrix(m);
    c.position.set(o.x, o.y, o.z); c.quaternion.set(q.x, q.y, q.z, q.w)`);
  await v.waitForTimeout(300); await button('right', 'trigger');
  const vrPoint = await G(v, 'return { state: game.marker.state(), tp: game.debug.wand().teleport, sprites: game.debug.marker.children.filter(c => c.type === "Sprite" && c.visible).length }');
  check('VR trigger places on scan with a scene prompt and no teleport', vrPoint.state.marking?.pts.length === 1 && !vrPoint.tp && vrPoint.sprites > 0, vrPoint);
  await button('right', 'b-button');
  check('VR B undoes the last point', await G(v, 'return game.marker.state().marking?.pts.length === 0'), 'controller event');
  await button('right', 'squeeze');
  check('VR grip cancels marking', !await G(v, 'return game.marker.state().marking'), 'controller event');
  await button('left', 'y-button');
  check('VR off-hand Y starts stairs', await G(v, 'return game.marker.state().marking?.kind === "stairs"'), 'controller event');
  await button('right', 'squeeze'); await button('right', 'b-button');
  check('VR B opens saved-mark editing', await G(v, 'return game.marker.state().editing'), 'controller event');
  await button('right', 'a-button');
  check('VR A finishes editing', !await G(v, 'return game.marker.state().editing'), 'controller event');
  await G(v, `await game.doors.mark([4.05, 1.1], [4.05, 1.9]); game.marker.edit(); __aimMark([4.05, 1.9, 1])`);
  await v.waitForTimeout(300);
  await G(v, "game.debug.xrDevice.controllers.right.updateButtonValue('trigger', 1)"); await v.waitForTimeout(150);
  const heldHandle = await G(v, 'return game.marker.state().dragging');
  await G(v, '__aimMark([4.05, 2.05, 1])'); await v.waitForTimeout(300);
  await G(v, "game.debug.xrDevice.controllers.right.updateButtonValue('trigger', 0)"); await v.waitForTimeout(400);
  const door = await G(v, 'return game.doors.list()[0]');
  check('VR trigger drags a jamb handle along the scan and remeasures on release', heldHandle === 'b' && Math.abs(door.b[1] - 1.9) > 0.02, { heldHandle, door });
  await G(v, 'await game.stairs.mark([2.5, 1], [3.4, 1], [2.95, 2], 0.72); game.marker.edit()');
  const railTarget = await G(v, `const t = game.debug.marker.children.flatMap(c => c.children).find(c => c.userData.toggle === 'stairs|left');
    t.geometry.computeBoundingSphere(); return t.localToWorld(t.geometry.boundingSphere.center.clone()).toArray()`);
  await G(v, `__aimMark(${JSON.stringify(railTarget)})`); await v.waitForTimeout(300); await button('right', 'trigger');
  check('VR trigger toggles the rail side', await G(v, 'return game.stairs.list()[0].rails_set?.left === "seen"'), railTarget);
  await button('left', 'x-button');
  check('VR off-hand X changes the top device while editing', await G(v, 'return game.stairs.list()[0].top_device === "rollator"'), 'controller event');
  await G(v, 'await game.applyFix("stair_walker:stairs"); game.marker.done()');
  await button('right', 'b-button');   // editing hides the family story card, which can otherwise sit in front of the device
  check('VR editing hides story buttons so renovation triggers stay unambiguous', await G(v, 'return game.marker.state().editing && game.debug.xrButtons().every(b => b.at === null)'), 'edit mode');
  const proxy = await G(v, `const w = game.debug.stairs.children.flatMap(c => c.children).flatMap(c => c.children).find(c => c.userData.parked);
    return w.getWorldPosition(new game.debug.rig.position.constructor()).toArray()`);
  await G(v, `__aimMark(${JSON.stringify(proxy)})`); await v.waitForTimeout(300);
  await G(v, "game.debug.xrDevice.controllers.right.updateButtonValue('trigger', 1)"); await v.waitForTimeout(150);
  const heldWalker = await G(v, 'return game.marker.state().dragging');
  const floor = await G(v, `const rig = game.debug.rig, V = rig.position.constructor, c = game.debug.xrDevice.controllers.right,
    o = rig.localToWorld(new V(c.position.x, c.position.y, c.position.z)), target = new V(...${JSON.stringify(proxy)}), d = target.sub(o).normalize(), t = (0.72 - o.z) / d.z;
    return [o.x + d.x * t + 0.1, o.y + d.y * t, 0.72]`);
  await G(v, `__aimMark(${JSON.stringify(floor)})`); await v.waitForTimeout(300);
  await G(v, "game.debug.xrDevice.controllers.right.updateButtonValue('trigger', 0)"); await v.waitForTimeout(400);
  const movedWalker = await G(v, 'return game.layout().placed?.["stair_walker:stairs"]');
  check('VR drags the second walker on the landing plane', heldWalker === 'stair_walker:stairs' && movedWalker && Math.abs(movedWalker.x - 3.05) < 0.03, { heldWalker, movedWalker });
  await G(v, 'await game.marker.moveWalker("stairs", null)');
  await G(v, `game.reimagine.setT(0); game.reimagine.play(0.2)`); await v.waitForTimeout(500);
  check('VR advances renovation animation', await G(v, 'return game.reimagine.t() === 1 && !game.reimagine.playing()'), 'XR frame loop');
  await v.close();
  check('no page errors', errors.length === 0, errors);
} finally {
  await browser.close();
  writeFileSync(new URL('renovations-results.json', import.meta.url), JSON.stringify(results, null, 1));
}
process.exit(results.length && results.every(r => r.pass) ? 0 : 1);
