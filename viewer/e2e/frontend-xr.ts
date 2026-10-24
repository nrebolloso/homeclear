import { chromium } from 'playwright-core';
import { CHROME } from './env.ts';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = []; page.on('pageerror', e => errors.push(String(e)));
const G = (code: string) => page.evaluate(`(async () => { const game = window.game; ${code} })()`);
const wait = () => page.waitForTimeout(350);
try {
  await page.goto(`${process.argv[2] ?? 'http://127.0.0.1:5180'}/?scene=game_synth&emulate=quest2`);
  await page.waitForFunction(() => (window as any).game?.frontendXR, null, { timeout: 60000 });
  await page.getByText('ENTER VR', { exact: true }).click(); await page.waitForFunction(() => (window as any).game.xr);
  await wait();
  await G(`window.__aimUI = label => {
    const menu = game.frontendXR.root, target = menu.children.find(c => c.userData.label === label);
    if (!target) throw Error('No VR control: ' + label);
    const rig = game.debug.rig, V = rig.position.constructor, Q = rig.quaternion.constructor;
    const h = game.xrPose().head, origin = new V(h[0], h[1], h[2] - .3), point = target.getWorldPosition(new V());
    rig.updateWorldMatrix(true, false); const lo = rig.worldToLocal(origin), lt = rig.worldToLocal(point);
    const m = new rig.matrix.constructor().lookAt(lo, lt, new V(0, 1, 0)), q = new Q().setFromRotationMatrix(m);
    const ctl = game.debug.xrDevice.controllers.right; ctl.position.set(lo.x, lo.y, lo.z); ctl.quaternion.set(q.x,q.y,q.z,q.w);
  };`);
  const stick = async () => { await G("game.debug.xrDevice.controllers.left.updateButtonValue('thumbstick', 1)"); await wait(); await G("game.debug.xrDevice.controllers.left.updateButtonValue('thumbstick', 0)"); await wait(); };
  const select = async (label: string) => { await G(`__aimUI(${JSON.stringify(label)})`); await wait(); await G("game.debug.xrDevice.controllers.right.updateButtonValue('trigger', 1)"); await wait(); await G("game.debug.xrDevice.controllers.right.updateButtonValue('trigger', 0)"); await wait(); };
  assert.equal(await G('return game.frontendXR.isOpen()'), false); await stick(); assert.equal(await G('return game.frontendXR.isOpen()'), true);
  assert.equal(await page.locator('#frontend').isVisible(), false); console.log('PASS controller opens spatial menu; desktop DOM is hidden');
  const before = await G('return JSON.stringify(game.layout())');
  await select('View filters'); await select('Off · Night view'); assert.equal(await page.isChecked('#night'), true);
  await select('On · Particle path'); assert.equal(await G('return game.debug.overlays[0].visible'), false);
  assert.equal(await G('return JSON.stringify(game.layout())'), before); console.log('PASS VR ray selects shared filters without editing scene objects');
  await select('Back'); await select('Changes & cost');
  assert.equal(await G("return game.frontendXR.root.children.some(c => c.userData.label?.includes('Cost estimate pending'))"), true); console.log('PASS VR cost view preserves pending estimates');
  await select('Back'); await select('Inspect items'); await wait();
  assert.equal(await G('return game.frontendXR.inspectionRoot.visible'), true); console.log('PASS Inspect uses an in-scene detail card');
  await stick(); await select('Explore'); assert.equal(await G('return game.frontendXR.isOpen()'), false); console.log('PASS navigation selection closes the menu and returns control to the scene');
  assert.deepEqual(errors, []); console.log('PASS no VR browser exceptions');
} finally { await browser.close(); }
