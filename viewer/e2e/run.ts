// End-to-end checks in headless Chrome on the laptop GPU, against `npm run dev`:
//   node e2e/run.ts [http://localhost:5179]        -> prints PASS/FAIL per check, writes e2e/results.json
// Needs the synthetic scenes (tests/make_game_scene.py) and the Python venv (for tests/make_test_clip.py).
import { CHROME, ROOT, PYTHON } from './env.ts';
import { chromium, type Page } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5179';

const results: { check: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => { results.push({ check: name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };
// SHOTS=<dir> also saves a screenshot at each visual check (proof/screenshots)
const shot = (p: Page, name: string) => process.env.SHOTS ? p.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : null;
const G = (p: Page, f: string) => p.evaluate(`(async () => { const game = window.game; ${f} })()`) as Promise<any>;

const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: [`--use-angle=${process.platform === 'win32' ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'gl'}`, '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
    '--disable-accelerated-video-decode'] });   // headless: HW decode + ANGLE stalls seeks and loses the WebGL context
async function open(scene: string) {
  const p = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`${BASE}/?scene=${scene}`);
  await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 60000 });
  if (/[&?](seed|demo=1)/.test(`&${scene}`)) await p.evaluate('game.resetDemo()');   // seeded (demorun.ts): every such check starts from Reset demo
  return { p, errors };
}

try {
  const { p, errors } = await open('game_synth&seed&nophys');   // no live physics: the synthetic route runs over the rug and slides it on every seed
  const gpu = await p.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2')!; const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
  await p.waitForTimeout(6000);
  const fps = await G(p, 'return game.fps');
  check('fps (autoplay, 1600x900)', fps >= 30, `${fps.toFixed(1)} fps on ${gpu}`);
  const base = await G(p, 'return { pm: game.current().per_month, len: game.current().length_m }');

  // 1. drive into the 1.5 cm rug: a leg flashes with the measured height
  await G(p, 'game.setFree(1.2, 1.3, 0)');
  await p.keyboard.down('KeyW');
  const flash = await p.waitForFunction(() => (window as any).game.state.legs.find((l: any) => l.flash), null, { timeout: 15000 }).then(h => h.jsonValue()).catch(() => null);
  await shot(p, 'hazard_rug_leg_flash');
  await p.keyboard.up('KeyW');
  const tag = await p.evaluate(() => [...document.querySelectorAll('.label3d.red')].map(e => e.textContent).find(t => t?.includes('bump')));
  check('rug bump flashes the leg with the measured height', !!flash && Math.abs(flash.h - 0.015) < 0.002 && tag === '1.5 cm bump',
    flash ? `leg at (${flash.x.toFixed(2)}, ${flash.y.toFixed(2)}) h=${(flash.h * 100).toFixed(2)} cm, label "${tag}"` : 'no leg flashed');

  // 1a. 5 mm cable: classified as thin, shown with the typical height labelled estimated (not a measurement)
  await G(p, 'game.setFree(2.6, 0.5, 0)');
  await p.keyboard.down('KeyW');
  const cab = await p.waitForFunction(() => (window as any).game.state.legs.find((l: any) => l.flash && l.est), null, { timeout: 15000 }).then(h => h.jsonValue()).catch(() => null);
  await shot(p, 'hazard_cable_estimated');
  await p.keyboard.up('KeyW');
  const ctag = await p.evaluate(() => [...document.querySelectorAll('.label3d.red')].map(e => e.textContent).find(t => t?.includes('cable')));
  const clist = await p.evaluate(() => document.querySelector('#hazards')?.textContent ?? '');
  check('cable classified as thin, height shown as estimated', !!cab && /estimated/.test(ctag ?? '') && /ESTIMATED/.test(clist),
    cab ? `leg at (${cab.x.toFixed(2)}, ${cab.y.toFixed(2)}), label "${ctag}"; hazard list mentions ESTIMATED: ${/ESTIMATED/.test(clist)}` : 'no leg flashed on the cable');

  // 1b. walker frame in the 0.80 m doorway: side clearance under the margin turns it red with the gap in cm
  await G(p, 'game.setFree(3.6, 1.5, 0)');
  await p.waitForTimeout(300);
  const st = await G(p, 'return { red: game.state.red, gap: game.state.gap }');
  await shot(p, 'hazard_doorway_red_frame');
  const gapTxt = await p.evaluate(() => [...document.querySelectorAll('.label3d.red')].map(e => e.textContent).find(t => t?.endsWith('gap')));
  check('frame turns red below the clearance margin (doorway)', st.red && st.gap > 0 && st.gap < 0.10 && gapTxt === `${Math.round(st.gap * 100)} cm gap`,
    `gap ${(st.gap * 100).toFixed(1)} cm (margin 10 cm), red=${st.red}, label "${gapTxt}"`);

  // 1c. free walk is fenced: into a wall, and into floor the capture never saw (far end of the bathroom)
  const walkInto = async (x: number, y: number, yaw: number) => {
    await G(p, `game.setFree(${x}, ${y}, ${yaw})`);
    await p.keyboard.down('KeyW'); await p.waitForTimeout(5000); await p.keyboard.up('KeyW');
    return G(p, 'return { x: game.body.x, y: game.body.y, ...game.cell(game.body.x, game.body.y) }');
  };
  const wallStop = await walkInto(3.0, 2.6, Math.PI / 2), covStop = await walkInto(5.0, 0.7, 0);   // below the open door leaf, which hides y > 1.9 from the bedroom cameras
  check('free walk stays on covered floor (walls, unseen floor)', wallStop.y < 3.3 && wallStop.floor && !wallStop.obst && covStop.cov > 0 && covStop.x < 6.2,
    `toward wall y=4.0: stopped at y=${wallStop.y.toFixed(2)} (front legs need 0.75 m); toward unseen x>6.2: stopped at x=${covStop.x.toFixed(2)} (coverage ${covStop.cov} views)`);

  // 2. fill shows only after a move; moving the bed replans within ~1 s and changes route + numbers; walls reject
  // overview from high behind the walker: route + ghost walkers (red = a rollout's toe contact)
  await G(p, "game.setFree(1.0, 1.5, 0); Object.assign(game.view, { third: true, back: 2.5, up: 3.5 })");
  await p.waitForTimeout(800);
  await shot(p, 'ghost_walkers_overview');
  await G(p, "Object.assign(game.view, { third: false, back: 1.6, up: 0.9 })");
  const fillBefore = await G(p, "return game.fillVisible('bed')");
  const mv = await G(p, "return game.moveObject('bed', 2.0, 1.0, 90)");
  await p.waitForTimeout(300);
  const after = await G(p, "return { pm: game.current().per_month, len: game.current().length_m, err: game.current().error, fill: game.fillVisible('bed'), rug: game.fillVisible('rug') }");
  check('fill appears only after the object moves', fillBefore === false && after.fill === true && after.rug === false,
    `bed fill before=${fillBefore}, after=${after.fill}; unmoved rug fill=${after.rug}`);
  check('moving the bed updates route and numbers within ~1 s', mv.ok && mv.ms < 1000 && !after.err && (Math.abs(after.len - base.len) > 0.01 || Math.abs(after.pm - base.pm) > 0.01),
    `replan ${mv.ms?.toFixed(0)} ms; route ${base.len.toFixed(2)} -> ${after.len?.toFixed(2)} m; contacts/month ${base.pm.toFixed(2)} -> ${after.pm?.toFixed(2)}`);
  const wall = await G(p, "return game.moveObject('bed', 4.0, 2.6, 0)");
  check('placement into a wall is blocked', wall.ok === false, `moveObject(bed, 4.0, 2.6) -> ok=${wall.ok}`);
  await G(p, "game.select('bed')");
  await p.keyboard.press('Delete');
  await p.waitForTimeout(500);
  const rm = await G(p, "const k = game.items.indexOf('bed'), q = game.layout().poses[k]; return { removed: !!q.removed, obst: game.cell(2.0, 1.0).obst, err: game.current().error }");
  check('Delete removes the selected object from the map', rm.removed && rm.obst === 0 && !rm.err, `removed=${rm.removed}, obstacle at old spot=${rm.obst}, replan error=${rm.err}`);
  await G(p, "game.frontend.setTab('changes')");
  await p.click('#reset');
  await p.waitForTimeout(500);

  // 3. plan fixes: ranked by reduction, applying the top one lowers the number
  await G(p, "game.frontend.setTab('reimagine')");
  await p.locator('summary').filter({ hasText: 'Explore individual fixes' }).click();
  await p.click('#planfixes');
  const fixes = await p.waitForFunction(() => (window as any).game.fixes, null, { timeout: 20000 }).then(h => h.jsonValue());
  const sorted = fixes.every((f: any, i: number) => i === 0 || fixes[i - 1].reduction >= f.reduction);
  const pm0 = await G(p, 'return game.current().per_month');
  await G(p, `await game.applyFix('${fixes[0].id}')`);
  await p.waitForTimeout(500);
  const pm1 = await G(p, 'return game.current().per_month');
  check('plan fixes ranked; applying the top fix lowers risk', sorted && fixes[0].reduction > 0 && pm1 < pm0,
    fixes.map((f: any) => `${f.id} -${f.reduction === null || !isFinite(f.reduction) ? 'blocked' : f.reduction.toFixed(2)}`).join(', ') + `; applied ${fixes[0].id}: ${pm0.toFixed(2)} -> ${pm1.toFixed(2)}/month`);
  await G(p, "game.frontend.setTab('changes')");
  await p.click('#reset');
  await p.waitForTimeout(500);

  // 4. night mode
  await p.click('#tab-view');
  await p.click('#night');
  await p.waitForTimeout(4000);
  const nfps = await G(p, 'return game.fps');
  await shot(p, 'night_mode');
  check('night mode toggles without errors', errors.length === 0, `${nfps.toFixed(1)} fps at night; page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  await p.click('#night');

  // 5. export for Cosmos: whole route at 16 fps, 93-frame chunks, one walker depth frame per camera
  await G(p, "game.setFree(2.25, 2.7, 0)");
  const job = await G(p, 'return await game.exportForCosmos()');
  const ex = await G(p, 'return game.lastExport');
  const dir = `${ROOT}viewer/public/exports/${job}`;
  const pngs = existsSync(`${dir}/walker`) ? readdirSync(`${dir}/walker`).length : 0;
  check('export for Cosmos', ex.frames % 93 === 0 && ex.chunks === ex.frames / 93 && pngs === ex.frames && existsSync(`${dir}/cosmos_job.json`) && ex.walkerPx > 0.02,
    `${job}: ${ex.frames} frames, ${ex.chunks} chunks, ${pngs} walker depth PNGs, walker covers ${(100 * ex.walkerPx).toFixed(1)}% of frame 0`);

  // 6. clip overlay alignment: synthetic clip with dots at the PYTHON projection + frame number bits
  const mk = spawnSync(PYTHON, [`${ROOT}tests/make_test_clip.py`, dir], { encoding: 'utf8' });
  if (mk.status !== 0) throw new Error(`make_test_clip failed: ${mk.stderr}`);
  const align = await G(p, `
    const clip = (await fetch('/api/clips').then(r => r.json())).find(c => c.file === 'test_${job}.mp4');
    const t = clip.test, busy = Object.keys(t.expected).filter(k => t.expected[k].length).map(Number);
    const picks = [busy[0], busy[Math.floor(busy.length / 2)], busy[busy.length - 1]];
    const video = game.openClip(clip);
    // a stalled decoder never fires these events (seen on macOS headless): fail with a reason instead of hanging
    const within = (pr, what) => Promise.race([pr, new Promise((_, no) => setTimeout(() => no(new Error(what + ' timed out after 10 s')), 10000))]);
    await within(new Promise(r => video.readyState >= 1 ? r() : video.addEventListener('loadedmetadata', r, { once: true })), 'clip metadata');
    video.pause();
    const cv = document.createElement('canvas'); cv.width = clip.width; cv.height = clip.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const out = [];
    for (const k of picks) {
      await within(new Promise(r => { video.addEventListener('seeked', r, { once: true }); video.currentTime = (k + 0.5) / clip.fps; }), 'seek to frame ' + k);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      ctx.drawImage(video, 0, 0);
      let shown = 0;
      for (let b = 0; b < t.bits; b++) if (ctx.getImageData(8 + t.bit_px * b + 7, t.bit_y + 7, 1, 1).data[0] > 128) shown |= 1 << b;
      const ov = game.overlay, err = [];
      for (const [x, y, label] of t.expected[k]) {
        const m = ov.markers.find(m => m.label === label);
        const px = m ? ctx.getImageData(Math.min(clip.width - 1, Math.round(m.x)), Math.min(clip.height - 1, Math.round(m.y)), 1, 1).data : null;
        err.push(m ? { d: Math.hypot(m.x - x, m.y - y), green: px[1] > 180 && px[0] < 120 } : { d: Infinity, green: false });
      }
      out.push({ k, shown, overlay: ov.frame, err });
    }
    return out;`);
  const ok = align.every((a: any) => a.shown === a.k && a.overlay === a.k && a.err.every((e: any) => e.d < 1 && e.green));
  check('clip overlay markers align at known frames', ok, align.map((a: any) =>
    `frame ${a.k}: video shows ${a.shown}, overlay ${a.overlay}, max err ${Math.max(...a.err.map((e: any) => e.d)).toFixed(2)} px, on dot ${a.err.every((e: any) => e.green)}`).join('; '));
  await p.close();
  // test artefacts would otherwise pile up in the game's clip list
  for (const f of [`${ROOT}viewer/public/clips/test_${job}.mp4`, `${ROOT}viewer/public/clips/test_${job}.json`, dir]) rmSync(f, { recursive: true, force: true });

  // 7. a doorway narrower than the walker blocks the route
  const n = await open('game_synth_narrow');
  await n.p.waitForTimeout(1000);
  const status = await n.p.textContent('#status');
  check('doorway narrower than the walker blocks the route', /^No route/.test(status ?? ''), `status: "${status}"`);
  await n.p.close();

  // 8. the newer layers on the synthetic scene
  const q = await open('game_synth');
  const Q = (f: string) => G(q.p, f);
  const r0 = await Q('return { pm: game.current().per_month, lo: game.current().per_month_lo, hi: game.current().per_month_hi, routes: game.current().routes.length, checks: game.current().checks.length }');
  check('risk range, routes and checks', r0.lo <= r0.pm && r0.pm <= r0.hi && r0.routes >= 2 && r0.checks >= 4, JSON.stringify(r0));
  const pk = await Q("await game.setPersona('parkinsons'); const a = game.current().per_month; await game.setPersona('patient'); return { a, b: game.current().per_month }");
  check('persona switch re-plans (Parkinson\'s > patient)', pk.a > pk.b, `${pk.a.toFixed(2)} vs ${pk.b.toFixed(2)}`);
  const px = async () => q.p.evaluate(() => { const c = document.querySelector('#view canvas') as HTMLCanvasElement; return c.toDataURL('image/jpeg', 0.5).length; });
  await Q('game.setVision("normal")'); await q.p.waitForTimeout(300); const n0 = await px();
  await Q('game.setVision("cataract")'); await q.p.waitForTimeout(300); const n1 = await px();
  await Q('game.setVision("normal")');
  check('vision pass changes the frame (cataract blurs: smaller JPEG)', n1 < n0 * 0.95, `${n0} -> ${n1} bytes`);
  await q.p.click('#tab-view');
  await q.p.locator('#filter-menu details').evaluate((el: HTMLDetailsElement) => { el.open = true; });
  await q.p.click('#heat'); await q.p.waitForTimeout(800);
  const heat = await Q('return !!game.current().heat');
  await q.p.click('#heat');
  check('heatmap: rollouts return per-cell counts when on', heat, String(heat));
  const t0 = Date.now();
  const opts = await Q('const o = await game.suggest(); return o.map(x => ({ n: x.name, pm: x.per_month, f: x.checks_failed }))');
  const pmNow = await Q('return game.current().per_month');
  await Q('await game.applyOption(game.suggestions.length - 1)');
  const applied = await Q('return { pm: game.current().per_month, err: game.current().error, key: game.layoutKey() }');
  check('suggest layouts, apply the full option, walkable', opts.length >= 2 && !applied.err && applied.pm <= pmNow + 1e-9 && applied.key !== 'original',
    `${opts.map((o: any) => `${o.n} ${o.pm.toFixed(2)}`).join(', ')} in ${((Date.now() - t0) / 1000).toFixed(1)} s; now ${applied.pm.toFixed(2)} (${applied.key.slice(0, 60)})`);
  const [rep] = await Promise.all([q.p.context().waitForEvent('page'), Q('game.openReport()')]);
  await rep.waitForURL(/report\.html/, { timeout: 60000 });   // the tab opens blank while the fixes roll out
  await rep.waitForLoadState('networkidle');
  const repText = await rep.textContent('body');
  check('OT report renders the live layout', /Expected toe (contacts|catches)/.test(repText ?? '') && /Changes in this layout/.test(repText ?? '') && (await rep.$$('img')).length >= 2,
    `${(repText ?? '').length} chars`);
  await rep.close();
  const url = await Q('return await game.openFixCard()');
  const card = await browser.newPage({ viewport: { width: 390, height: 900 } });   // a phone
  await card.goto(url.replace(/^https?:\/\/[^/]+/, BASE));
  await card.waitForSelector('#list li', { timeout: 20000 });
  const items = await card.$$eval('#list li', l => l.length);
  check('fix card opens from the QR link with numbered fixes', items >= 3, `${items} items, url ${url.length} chars`);
  await card.close();
  await Q("document.getElementById('third').click(); game.setAuto()");
  await q.p.waitForTimeout(1500);
  check('third person: mannequin walks the simulated footsteps', await Q('return game.mannequinVisible() && game.heroSteps().length > 4'), 'visible with footsteps');
  const ph = await Q(`const r = await game.physicsPass(); return { done: r.every(x => x.done), snags: r.reduce((n, x) => n + x.snags.length, 0),
    li: document.querySelectorAll('#snags li').length, ms: Math.round(r.reduce((n, x) => n + x.ms, 0)) }`);
  check('physics pass (Rapier): the walker reaches every goal, snags listed', ph.done && ph.li >= 2, JSON.stringify(ph));
  await q.p.close();
  // 9. reimagined room: the room morphs into the safest suggested layout, each change costed, undo takes one back
  const ri = await open('game_synth');
  const R = (f: string) => G(ri.p, f);
  const run = await R(`const cs = await game.reimagine.run(); const m = cs.find(c => c.kind === 'move');
    game.reimagine.setT(0); const at0 = m && game.reimagine.pose(m.name);
    game.reimagine.setT(1); const at1 = m && game.reimagine.pose(m.name);
    return { n: cs.length, m: m && { from: m.from, to: m.to, name: m.name }, at0, at1, costed: cs.every(c => c.cost && c.cost.minutes > 0),
      li: document.querySelectorAll('#receipt li').length, total: document.getElementById('reimtotal').textContent }`);
  const near = (a: any, b: any) => !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) < 1e-3;
  check('reimagine: morphs into the safest layout, every change costed in the receipt',
    run.n >= 1 && run.costed && run.li === run.n && (!run.m || (near(run.at0, run.m.from) && near(run.at1, run.m.to))), JSON.stringify(run).slice(0, 300));
  await R('game.reimagine.setT(0.5)'); await shot(ri.p, 'reimagine_half'); await R('game.reimagine.setT(1)'); await shot(ri.p, 'reimagine_full');
  const un = await R('await game.reimagine.undo(0); return game.reimagine.changes().length');
  check('reimagine: undo takes one change back', un === run.n - 1, `${run.n} -> ${un}; page errors: ${ri.errors.join(' | ') || 'none'}`);
  check('reimagine: no page errors', ri.errors.length === 0, ri.errors.join(' | ') || 'none');
  await ri.p.close();
  // 10. stairs on the real kitchen (its scene folder is generated, so skipped where it isn't exported): the lower flight
  // measured from the splat, checked against code and the stronger hand, then the three additions clear their checks
  const k4scene = ['kitchen4_lighter_objects', 'kitchen4_lighter'].find(s => existsSync(`${ROOT}viewer/public/scene/${s}/scene.json`));
  if (k4scene) {
    const k4 = await open(k4scene);
    const K = (f: string) => G(k4.p, f);
    if (k4scene.endsWith('_objects')) {   // the demo scene: detected furniture, so Reimagine has something to move
      const re = await K('const cs = await game.reimagine.run(); return { n: cs.length, labels: cs.map(c => c.label), msg: document.getElementById("reimtotal").textContent }');
      check('reimagine on the demo kitchen: at least one costed move', re.n >= 1, `${re.labels.join('; ') || re.msg}`);
    }
    const st = await K('return await game.stairs.mark([4.28, -0.68], [3.48, -0.68], [3.88, -1.6])');
    const risers = st.treads_z.map((z: number, k: number) => z - (k ? st.treads_z[k - 1] : 0));
    check('stairs: measured from the splat (treads, risers, rail side)', st.treads_z.length >= 3 && risers.every((r: number) => r > 0.13 && r < 0.24) && st.rails.right === 'seen',
      `${st.treads_z.length} treads, risers ${risers.map((r: number) => (r * 100).toFixed(0)).join('/')} cm, rails ${JSON.stringify(st.rails)}`);
    const v = (w: string) => `game.current().checks.find(c => c.id === 'stairs:stairs:${w}')?.verdict`;
    await K("game.stairs.setStrongSide('left'); await new Promise(r => setTimeout(r, 800))");
    const before = await K(`return [${v('rails')}, ${v('light')}, ${v('walker')}]`);
    for (const id of ['stair_rail:stairs:left', 'stair_lights:stairs', 'stair_walker:stairs']) await K(`await game.applyFix('${id}')`);
    const after = await K(`return [${v('rails')}, ${v('light')}, ${v('walker')}]`);
    check('stairs: rail for the stronger hand, step lights and a walker at the top clear their checks',
      before.every((x: string) => x !== 'ok') && after[0] === 'ok' && after[1] === 'ok' && after[2] === 'borderline, OT to verify', `${before.join(', ')} -> ${after.join(', ')}`);
    await K("game.setNight(true)"); await shot(k4.p, 'stairs_night');
    check('stairs: no page errors', k4.errors.length === 0, k4.errors.join(' | ') || 'none');
    await k4.p.close();
  }
  // 11. doorways: the 55 cm synthetic doorway blocks the walker; widening it (away from the open leaf) opens the route,
  // edits the scan (wall strip hidden, jamb shifted) and undo closes it again
  const dn = await open('game_synth_narrow');
  const D = (f: string) => G(dn.p, f);
  await D("await game.doors.mark([4.05, 1.225], [4.05, 1.775], 'bathroom door')");
  const d0 = await D("return { err: game.current().error ?? null, v: game.current().checks.find(c => c.id === 'door:bathroom door')?.verdict, ids: game.doors.list().map(d => d.hinge) }");
  await D("await game.doors.apply('bathroom door', 'widen')");
  const d1 = await D("return { err: game.current().error ?? null, v: game.current().checks.find(c => c.id === 'door:bathroom door')?.verdict, edits: game.doors.edits(), squeeze: game.current().hazards.filter(h => h.type === 'tight_clearance' && Math.abs(h.position[0] - 4.05) < 0.3).length }");
  check('doorway: blocked at 55 cm, open once widened away from the leaf, scan edited',
    !!d0.err && d0.v === 'fail' && d0.ids[0] === 'b' && !d1.err && d1.v === 'ok' && d1.edits === 2 && d1.squeeze === 0, `${JSON.stringify(d0)} -> ${JSON.stringify(d1)}`);
  await shot(dn.p, 'door_widened');
  const d2 = await D("await game.reimagine.undo(0); return { err: game.current().error ?? null, edits: game.doors.edits() }");
  check('doorway: undo closes it and removes the edits', !!d2.err && d2.edits === 0, JSON.stringify(d2));
  check('doorway: no page errors', dn.errors.length === 0, dn.errors.join(' | ') || 'none');
  await dn.p.close();
  // 12. reset: Z puts the picked object back, a blocked original refuses, Shift+Z / Reset all restore objects, removals and fixes
  {
  const rs = await open('game_synth&seed&nophys');   // frozen pushes: the walker slides the rug and nudges the bed on every seed
  const RS = (f: string) => G(rs.p, f);
  const bed = await RS("return { ...game.layout().poses[game.items.indexOf('bed')] }");   // as scanned, right after Reset demo
  await rs.p.waitForTimeout(1500);
  const r0 = await RS("return { poses: game.layout().poses.map(q => ({ ...q })), pm: game.current().per_month }");
  await RS("await game.moveObject('bed', 2.0, 1.0, 90); game.select('bed')");
  await rs.p.waitForTimeout(300);
  const lab = await RS("return { lines: game.label(), btn: !document.getElementById('resetobj').disabled }");
  check('selecting a moved object names it and says how far it moved', lab.lines[0] === 'Bed' && /moved .* m/.test(lab.lines[1] ?? '') && lab.btn, JSON.stringify(lab));
  await rs.p.keyboard.press('KeyZ');
  await rs.p.waitForTimeout(500);
  const z = await RS("const k = game.items.indexOf('bed'), q = game.layout().poses[k]; return { x: q.x, y: q.y, yaw: q.yaw, label: game.label() }");
  check('Z puts the selected object back where it started', Math.hypot(z.x - bed.x, z.y - bed.y) < 0.01 && Math.abs(z.yaw - bed.yaw) < 0.01 && z.label.length === 1,
    `bed at (${z.x.toFixed(2)}, ${z.y.toFixed(2)}) vs original (${bed.x.toFixed(2)}, ${bed.y.toFixed(2)}); label ${JSON.stringify(z.label)}`);
  const bedAway = await RS("return (await game.moveObject('bed', 2.0, 1.0, 90)).ok");
  const taken = await RS(`return (await game.moveObject('nightstand', ${bed.x}, ${bed.y}, 0)).ok`);
  await RS("game.resetObject('bed')");
  await rs.p.waitForTimeout(300);
  const blocked = await RS("const q = game.layout().poses[game.items.indexOf('bed')]; return { x: q.x, y: q.y }");
  check('reset refuses when something else has taken the original spot', bedAway === true && taken === true && Math.abs(blocked.x - 2.0) < 0.01 && Math.abs(blocked.y - 1.0) < 0.01,
    `bed moved away=${bedAway}, nightstand moved onto its old spot=${taken}; bed stays at (${blocked.x.toFixed(2)}, ${blocked.y.toFixed(2)})`);
  await RS("await game.resetAll()");
  await RS("await game.moveObject('bed', 2.0, 1.0, 90); game.removeObject('rug')");
  await RS("game.frontend.setTab('reimagine')");
  await rs.p.locator('summary').filter({ hasText: 'Explore individual fixes' }).click();
  await rs.p.click('#planfixes');
  const rf = await rs.p.waitForFunction(() => (window as any).game.fixes, null, { timeout: 20000 }).then(h => h.jsonValue());
  await RS(`await game.applyFix('${rf[0].id}')`);
  await rs.p.waitForTimeout(300);
  const evalsBeforeReset = await RS('return game.evals');
  await rs.p.keyboard.press('Shift+KeyZ');
  // Applying a fix also queues fix ranking. The reset evaluation waits behind it: a fixed 800 ms races that worker.
  await rs.p.waitForFunction(n => (window as any).game.evals > n, evalsBeforeReset, { timeout: 20000 });
  const all = await RS("const l = game.layout(); return { poses: l.poses, flat: l.flattened.length, gone: game.inventory(), reimt: game.reimagine.t(), changes: game.reimagine.changes().length, pm: game.current().per_month }");
  const same = all.poses.every((q: any, n: number) => !q.removed && Math.hypot(q.x - r0.poses[n].x, q.y - r0.poses[n].y) < 0.01 && Math.abs(q.yaw - r0.poses[n].yaw) < 0.01);
  check('Shift+Z restores every object, removal and fix', same && all.flat === 0 && all.gone.length === 0 && all.reimt === 1 && all.changes === 0 && Math.abs(all.pm - r0.pm) < 0.01,
    `poses restored=${same}, taped strips=${all.flat}, removed=${all.gone.length}, reimagine changes=${all.changes}; ${r0.pm.toFixed(2)} -> ${all.pm.toFixed(2)}/month`);
  check('reset: no page errors', rs.errors.length === 0, rs.errors.join(' | ') || 'none');
  await rs.p.close();
  }
  // 13. movement modes: Fly looks without turning the walker, Look around parks it, Walk takes it back, 1-4 switch modes
  {
  const mv = await open('game_synth');
  const MV = (f: string) => G(mv.p, f);
  await mv.p.waitForTimeout(1500);
  const m = await MV(`game.setFree(game.body.x, game.body.y, game.body.yaw); const w0 = { x: game.body.x, y: game.body.y, yaw: game.body.yaw };
    document.getElementById('mode-fly').click(); game.manual = true;
    for (let i = 0; i < 20; i++) { game.body.yaw += 0.1; game.tick(0.05); }   // look around while flying
    document.getElementById('mode-explore').click(); game.tick(0.05);
    const parked = game.explore().parked;
    document.getElementById('mode-walk').click(); game.tick(0.05); game.manual = false;
    return { w0, parked, back: { x: game.body.x, y: game.body.y, yaw: game.body.yaw }, pressed: [...document.querySelectorAll('#viewer-toolbar [id^=mode-][aria-pressed=true]')].map(b => b.id) };`);
  check('movement: Look around parks the walker where it was and Walk takes it back (Fly looking never turned it)',
    !!m.parked && Math.hypot(m.parked.x - m.w0.x, m.parked.y - m.w0.y) < 0.01 && Math.abs(m.parked.yaw - m.w0.yaw) < 0.01 && Math.hypot(m.back.x - m.w0.x, m.back.y - m.w0.y) < 0.01 && Math.abs(m.back.yaw - m.w0.yaw) < 0.01 && m.pressed.join() === 'mode-walk', JSON.stringify(m));
  await mv.p.keyboard.press('Digit4');
  const k4 = await MV("return [...document.querySelectorAll('#viewer-toolbar [id^=mode-][aria-pressed=true]')].map(b => b.id).join()");
  await mv.p.keyboard.press('Digit1');
  const k1 = await MV("return [...document.querySelectorAll('#viewer-toolbar [id^=mode-][aria-pressed=true]')].map(b => b.id).join()");
  check('movement: keys 4 and 1 switch to Fly and Follow route', k4 === 'mode-fly' && k1 === 'mode-route', `${k4}, ${k1}`);
  check('movement: no page errors', mv.errors.length === 0, mv.errors.join(' | ') || 'none');
  await mv.p.close();
  }
  // 14. kitchen planner + gait personalization (planfix.ts, gaitfit.ts; skipped where the B200 search isn't published):
  // the replay ends on options, the AI never loses to the judge, a bad judge layout says why, the gait fit converges
  if (existsSync(`${ROOT}viewer/public/planner/kitchen4_lighter/search.json`) && existsSync(`${ROOT}viewer/public/scene/kitchen4_lighter/scene.json`)) {
    const pk = await open('kitchen4_lighter');
    const P = (f: string) => G(pk.p, f);
    const pl = await P('await game.planfix.ready; const s = await game.planfix.play(8); return { frame: s.frame, frames: s.frames, opts: document.querySelectorAll("#pfoptions li").length, searched: s.stats.layouts_searched, gpu: s.stats.gpu }');
    check('planner: replay plays to the end and offers 2-3 Pareto options', pl.frame === pl.frames - 1 && pl.opts >= 2 && pl.opts <= 3, `${pl.frame + 1}/${pl.frames} frames, ${pl.opts} options; job: ${pl.searched} layouts on ${pl.gpu}`);
    const lv = await P("await game.moveObject('chair8', 1.6, -0.9, 0); const r = await game.planfix.improve(2000); return { j: r.judge.risk, b: r.best.risk, inv: r.invalid, kept: r.kept }");
    check('planner live: AI layout is never worse than the judge\'s', lv.inv.length === 0 && lv.b <= lv.j + 1e-9, `judge ${lv.j.toFixed(1)} -> AI ${lv.b.toFixed(1)}/month, kept: ${lv.kept.join(', ') || 'none'}`);
    const bad = await P("await game.moveObject('chair3', -0.4, 1.8, 0); const r = await game.planfix.improve(500); return { inv: r.invalid, msg: document.getElementById('pfresult').textContent }");
    check('planner live: an invalid judge layout is flagged with the reason', bad.inv.some((s: string) => /fridge swing/.test(s)) && /can't be used/.test(bad.msg), bad.inv.join('; '));
    const gf = await P("await game.gait.play(32); const s = game.gait.state(); const r = await game.planfix.replanFor(game.gait.worldModel(), 'e2e', 300); return { steps: s.steps, err: s.err_last10, r: !!r && Number.isFinite(r.best_you.risk) && r.best_you.risk <= r.current_you.risk + 1e-9 }");
    check('gait: fitted embedding predicts the held-out walker\'s head better than the mean; re-plan runs', gf.steps > 100 && gf.err.head.fit < gf.err.head.pop && gf.r,
      `${gf.steps} steps, head err (last 10) ${gf.err.head.pop.toFixed(1)} -> ${gf.err.head.fit.toFixed(1)} cm, re-plan ok=${gf.r}`);
    const km = await P(`const t = document.getElementById('pfkeepmat'); t.checked = true; t.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 2500));
      const s = game.planfix.state(), li = [...document.querySelectorAll('#pfoptions li')].map(l => l.textContent); t.checked = false;
      return { mats: s.options.map(o => o.layout.mat), li, now: game.planfix.layouts().now.mat }`);
    check('planner: "Keep my mat" shows only layouts that keep the mat and applies one', km.mats.length >= 1 && km.mats.every((m: string) => m !== 'removed') && km.now !== 'removed' && /^Easiest, mat kept/.test(km.li[0] ?? ''),
      `${km.li.map((l: string) => l.split(':')[0]).join(' / ')}; mats ${km.mats.join(', ')}; room now: mat ${km.now}`);
    check('planner + gait: no page errors', pk.errors.length === 0, pk.errors.join(' | ') || 'none');
    await pk.p.close();
  }
  // 15. the world model life-size in the kitchen (wmghosts.ts): two gait styles walk differently, the futures fan has 30
  // labelled futures, a month before fixes has more incidents than after
  if (existsSync(`${ROOT}viewer/public/gait/styles.json`) && existsSync(`${ROOT}viewer/public/planner/kitchen4_lighter/search.json`)) {
    const wg = await open('kitchen4_lighter');
    const W = (f: string) => G(wg.p, f);
    const two = await W("await game.planfix.ready; await game.wmghosts.twoStyles('P07 (training)'); await new Promise(r => setTimeout(r, 7000)); const s = game.wmghosts.state(); " +
      "const [a, b] = s.actors; const n = Math.min(a.heels.length, b.heels.length); let d = 0; for (let k = 0; k < n; k++) d += Math.hypot(a.heels[k][0] - b.heels[k][0], a.heels[k][1] - b.heels[k][1]) / n; " +
      "return { steps: [a.steps, b.steps], d, caught: [a.caught.length, b.caught.length], fan: s.fan, fps: game.fps }");
    check('world model ghosts: two gait styles place their feet differently and flash on what they catch', two.d > 0.05 && two.caught[0] + two.caught[1] > 0,
      `steps ${two.steps.join(' vs ')}, mean heel gap ${(two.d * 100).toFixed(1)} cm, caught ${two.caught.join(' / ')}; ${two.fps.toFixed(1)} fps`);
    check('world model ghosts: futures fan of 30 labelled futures at each heel strike', two.fan.n === 30, JSON.stringify(two.fan));
    const mo = await W("const run = async w => { await game.wmghosts.month(w); await new Promise(r => setTimeout(r, 22000)); const m = game.wmghosts.state().month; " +
      "return { n: m.trips, inc: Object.values(m.counts).reduce((a, b) => a + b, 0), risk: m.expected.risk }; }; const b = await run('before'), a = await run('after'); game.wmghosts.stop(); return { b, a }");
    check('world model ghosts: a month of 60 trips, fewer incidents after the fixes', mo.b.n === 60 && mo.a.n === 60 && mo.a.inc < mo.b.inc,
      `before ${mo.b.inc} incidents (evaluator ${mo.b.risk.toFixed(1)}/month) -> after ${mo.a.inc} (${mo.a.risk.toFixed(1)})`);
    check('world model ghosts: no page errors', wg.errors.length === 0, wg.errors.join(' | ') || 'none');
    await wg.p.close();
  }
  // 16. the live futures fan (futuresfan.ts): from the walker's current state during autoplay, red at the mat, green once
  // it is taped, the hand-rule toggle, and the fps stays within ~10% of the fan-off rate (adaptive count)
  {
    const ff = await open('kitchen4_lighter&seed');
    const F = (f: string) => G(ff.p, f);
    const watch = 'const seen = []; for (let i = 0; i < 28; i++) { await new Promise(r => setTimeout(r, 500)); const s = game.fan.state(); if (s.fan) seen.push(s); } return seen';
    await F('await new Promise(r => setTimeout(r, 6000))');
    await F('game.fan.set(true)');
    const before: any[] = await F(watch);
    await F('await game.fan.tapeMat()');
    const after: any[] = await F(watch);
    await F("game.fan.setModel('hand'); await new Promise(r => setTimeout(r, 1500))");
    const h = await F('return game.fan.state()');
    const mat = (s: any) => (s.fan.crossed.mat ?? 0) > 0;
    const hit = before.find(s => mat(s) && s.fan.red > 0 && / cross the mat /.test(s.label)) ?? before.find(s => mat(s) && s.fan.red > 0);   // near the cord the cord leads the label
    check('futures fan: 30 imagined futures from the current state, red at the mat, labelled', !!hit && hit.fan.n === 30 && /^World model: 30 futures · \d+ cross the mat · ≈[\d.]+ toe catches\/month here/.test(hit.label), hit ? `${hit.label}; ${hit.fan.red} likely catches, ${hit.fan.catches_month.toFixed(2)}/month` : `never red at the mat: ${before.map(s => s.label.split('· ')[1]).join(', ')}`);
    check('futures fan: no future hits the mat once it is taped flat', after.length > 10 && !after.some(mat), `${after.length} fans, mat crossings ${after.filter(mat).length}, max ${Math.max(...after.map(s => s.fan.catches_month)).toFixed(2)} catches/month`);
    check('futures fan: hand rule toggle', h.model === 'hand' && /^Hand rule:/.test(h.label), h.label);
    // a fixed seed keeps all 30 futures (demorun.ts: the numbers match the recordings), so the adaptive count is measured unseeded
    const fr = await open('kitchen4_lighter');
    const off = await G(fr.p, 'await new Promise(r => setTimeout(r, 6000)); return game.fps');
    const on = await G(fr.p, 'game.fan.set(true); await new Promise(r => setTimeout(r, 14000)); return { fps: game.fps, n: game.fan.state().fan?.n }');
    check('futures fan: fps within ~10% of the fan-off rate (adaptive count)', on.fps >= 0.9 * off, `${off.toFixed(1)} fps off -> ${on.fps.toFixed(1)} on, ${on.n} futures sampled (unseeded)`);
    check('futures fan: no page errors', ff.errors.length + fr.errors.length === 0, [...ff.errors, ...fr.errors].join(' | ') || 'none');
    await ff.p.close(); await fr.p.close();
  }
  // 17. the fan's fork and foot lift (futures.ts routeOptions, LIFTS): at the fridge facing the mat the way ahead forks
  // (over / around the mat), the low-clearance shuffler catches the mat edge more often than the average lift, a taped mat
  // catches neither, and the mat's physics steps during autoplay without breaking the route
  {
    const fk = await open('kitchen4_lighter&seed');
    const F = (f: string) => G(fk.p, f);
    const steps0 = await F('await new Promise(r => setTimeout(r, 3000)); return game.livephys.steps()');
    await F('await new Promise(r => setTimeout(r, 4000))');
    const auto = await F('return { steps: game.livephys.steps(), events: game.livephys.events.map(e => e.kind + ":" + e.object), err: game.current().error ?? null }');
    check('fan fork: the mat physics steps during autoplay, route intact', auto.steps > steps0 + 20 && !auto.err, `${auto.steps - steps0} worker steps in 4 s of autoplay, events [${auto.events.join(', ')}], route error ${auto.err}`);
    const at = "game.setFree(-0.7, 2.2, -0.91); game.fan.set(true); await new Promise(r => setTimeout(r, 1200));";
    const mats = (l: string) => `game.fan.setLift('${l}'); const n = []; for (let i = 0; i < 8; i++) { await new Promise(r => setTimeout(r, 600)); const s = game.fan.state(); if (s.fan && s.fan.lift === '${l}') n.push(s.fan.catches_month); } return { n, s: game.fan.state() }`;
    await F(at);
    const fork = await F("for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 400)); const s = game.fan.state(); if (s.fan?.routes.length > 1) return s; } return game.fan.state()");
    check('fan fork: over vs around the mat at the fridge, counts on the card', fork.fan?.routes.length >= 2 && fork.fan.routes.some((r: any) => r.label === 'around the mat') && / around the mat/.test(fork.lines[1] ?? ''), fork.lines.join(' | '));
    const avg = await F(mats('average')), sh = await F(mats('shuffler'));
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    check('fan lift: the shuffler catches the mat edge more than the average lift', avg.n.length >= 4 && sh.n.length >= 4 && sum(sh.n) / sh.n.length > sum(avg.n) / avg.n.length, `average [${avg.n.map(x => x.toFixed(2))}] vs shuffler [${sh.n.map(x => x.toFixed(2))}] catches/month; ${sh.s.lines.join(' | ')}`);
    await F('await game.fan.tapeMat()');
    const tp = await F(mats('shuffler'));
    check('fan lift: a taped mat catches no shuffler', tp.n.length >= 4 && sum(tp.n) / tp.n.length < 0.2 * sum(sh.n) / sh.n.length && !tp.s.fan.crossed.mat, `shuffler after tape [${tp.n.map(x => x.toFixed(2))}] catches/month (the cord the mat lay over); ${tp.s.lines[0]}`);
    check('fan fork: no page errors', fk.errors.length === 0, fk.errors.join(' | ') || 'none');
    await fk.p.close();
  }
  // 18. round-trip autoplay (roundtrip.ts, the scripted demo): from the route's goal back to its start, a turn, then out as
  // planned, with no jump between legs; the fan follows the leg being walked; one way is still the default
  {
    const rt = await open('kitchen4_lighter&seed');
    const F = (f: string) => G(rt.p, f);
    const one = await F('return game.roundTrip.leg()');
    const r = await F(`const c = game.current(); await game.roundTrip.set(true); game.fan.set(true);
      const goal = c.xy.at(-1), start = c.xy[0], cen = b => [b.x + 0.5 * Math.cos(b.yaw), b.y + 0.5 * Math.sin(b.yaw)], d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
      const b0 = cen(game.body); let prev = { ...game.body, t: performance.now() }, speed = 0, near = 9, legs = [game.roundTrip.leg()], fanIn = 0;
      for (let i = 0; i < 240; i++) { await new Promise(r => setTimeout(r, 250)); const b = game.body, t = performance.now();   // a full in-out cycle is ~40 s
        speed = Math.max(speed, Math.hypot(b.x - prev.x, b.y - prev.y) / ((t - prev.t) / 1000)); prev = { ...b, t };
        const leg = game.roundTrip.leg(); if (leg !== legs.at(-1)) legs.push(leg); if (leg === 'in') near = Math.min(near, d(cen(b), start));
        const s = game.fan.state(); if (leg === 'in' && s.fan?.path === 'route') fanIn++;
        if (legs.length === 3) break; }
      return { fromGoal: d(b0, goal), near, legs, speed, fanIn }`);
    check('round trip: starts at the route goal, reaches its start, turns and walks out as planned', one === 'out' && r.fromGoal < 0.3 && r.near < 0.3 && r.legs.join() === 'in,out,in',
      `one way by default (${one}); start ${r.fromGoal.toFixed(2)} m from the goal, inbound got within ${r.near.toFixed(2)} m of the start; legs ${r.legs.join(' -> ')}`);
    check('round trip: no jump between legs (body under 1.2 m/s)', r.speed < 1.2, `max ${r.speed.toFixed(2)} m/s`);
    check('round trip: the fan follows the inbound leg', r.fanIn >= 5, `${r.fanIn} fans on the reversed route`);
    check('round trip: no page errors', rt.errors.length === 0, rt.errors.join(' | ') || 'none');
    await rt.p.close();
  }
  // 19. reach map:
  // - the floor from the route's start, the same in every mode;
  // - the 55 cm doorway cuts the bathroom off and is named; widening opens it, undo closes it;
  // - picked points are targets that survive a reload;
  // - the width slider repaints without the worker;
  // - the coverage ghosts leave the start together.
  {
  const rm = await open('game_synth_narrow');
  const RM = (f: string) => G(rm.p, f);
  await rm.p.waitForTimeout(1500);
  await RM("localStorage.removeItem('homeclear:reach:game_synth_narrow'); await game.doors.mark([4.05, 1.225], [4.05, 1.775], 'bathroom door'); await game.reach.show(true)");
  // on the wardrobe route (the bathroom one is blocked here, so it has no planned path to compare)
  const modes = await RM(`await game.selectRoute(1); const out = {};
    for (const m of ['route', 'walk', 'explore']) { game.frontend.setNavigation(m); await new Promise(r => setTimeout(r, 300)); await game.reach.refresh();
      out[m] = { start: game.reach.state().start, xy0: game.current().xy[0], n: game.current().xy.length }; }
    game.frontend.setNavigation('route'); await game.selectRoute(0); await game.reach.refresh(); return out;`);
  const near = (a: number[], b: number[], tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  check('reach: Follow route, Walk and Look around share the route start, the planned path and the reach map',
    ['walk', 'explore'].every(m => near(modes[m].start, modes.route.start, 1e-6) && near(modes[m].xy0, modes.route.xy0, 1e-6) && modes[m].n === modes.route.n) && near(modes.route.xy0, modes.route.start, 0.6),
    JSON.stringify(modes));
  const bath = "s.report.targets.find(t => t.kind === 'goal' && /bathroom/.test(t.name))";
  const r0 = await RM(`const s = game.reach.state(), t = ${bath}; return { cut: s.report.areas.cut, status: t.status, pinch: t.pinch?.width_m, cause: t.cause, region: s.report.regions[0]?.cause,
    dots: s.dots, mesh: s.mesh, inScene: s.inScene, costs: game.reach.costs(), chart: !document.getElementById('reachcost').hidden }`);
  check('reach: the 55 cm doorway cuts the bathroom off, named as the marked doorway; the paint is a scene mesh',
    r0.cut > 2 && r0.status === 'cut' && r0.pinch <= 0.56 && r0.cause?.name === 'bathroom door' && r0.region?.kind === 'door' && r0.mesh === 'Mesh' && r0.inScene && r0.dots > 0,
    JSON.stringify({ ...r0, costs: undefined }));
  check('reach: the cost to get through it is charted per device width (placeholder prices)',
    r0.chart && r0.costs?.door === 'bathroom door' && r0.costs.steps.length > 40 && r0.costs.steps.some((s: any) => s.usd === 1500 && s.source === 'placeholder'),
    JSON.stringify(r0.costs?.steps.slice(0, 3)));
  await shot(rm.p, 'reach_cut_off');
  await RM("await game.doors.apply('bathroom door', 'widen'); await game.reach.refresh()");
  const r1 = await RM(`const s = game.reach.state(), t = ${bath}; return { cut: s.report.areas.cut, status: t.status }`);
  check('reach: widening the doorway opens the bathroom', r1.cut < 0.5 && r1.status !== 'cut', `${r0.cut.toFixed(1)} -> ${r1.cut.toFixed(1)} m² cut off; bathroom ${r1.status}`);
  await shot(rm.p, 'reach_widened');
  await RM("await game.reimagine.undo(0); await game.reach.refresh()");
  const r2 = await RM(`const s = game.reach.state(); return { cut: s.report.areas.cut, status: ${bath}.status }`);
  check('reach: undo closes it again', r2.cut > 2 && r2.status === 'cut', JSON.stringify(r2));
  // the slider: repaint only while it moves (no worker round-trip), the report when it settles
  const wp = await RM(`const a0 = game.reach.state().asks, w5 = game.reach.preview(0.5), w9 = game.reach.preview(0.9);
    const el = document.getElementById('reachwidth'); el.value = '55'; el.dispatchEvent(new Event('input'));
    return { w5, w9, asks: game.reach.state().asks - a0, slider: game.reach.state().width_m, out: document.getElementById('reachwidthout').textContent }`);
  check('reach: the width slider repaints without the worker; a narrower device reaches more',
    wp.asks === 0 && wp.w5.ok + wp.w5.tight > wp.w9.ok + wp.w9.tight && Math.abs(wp.slider - 0.55) < 1e-9 && /55 cm/.test(wp.out), JSON.stringify(wp));
  await RM('await game.reach.setWidth(null)');
  // picking: the marking tool's point kind (click / wand), and the API
  await RM("game.reach.pick(); await game.marker.place([1.0, 0.6, 0]); await game.reach.pick([5.6, 2.4], 'bath corner')");
  const pk = await RM("const s = game.reach.state(); return { points: game.reach.points().map(p => p.name), ts: s.report.targets.filter(t => t.kind === 'point').map(t => [t.name, t.status]), marking: game.marker.state().marking }");
  check('reach: a point picked on the floor and one given by the API are targets checked from the start',
    pk.points.join() === 'point 1,bath corner' && pk.ts.some((t: string[]) => t[0] === 'point 1' && t[1] !== 'cut') && pk.ts.some((t: string[]) => t[0] === 'bath corner' && t[1] === 'cut') && !pk.marking,
    JSON.stringify(pk));
  await rm.p.reload();
  await rm.p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 60000 });
  const kept = await RM("await game.reach.show(true); return { points: game.reach.points().map(p => p.name), yaml: await game.reach.copyYaml(), ts: game.reach.state().report.targets.filter(t => t.kind === 'point').length }");
  await RM("await game.reach.removePoint('bath corner')");
  const after = await RM('return game.reach.points().map(p => p.name)');
  check('reach: picked points survive a reload, copy as config YAML, and remove one by one',
    kept.points.join() === 'point 1,bath corner' && kept.ts === 2 && /reach_points:/.test(kept.yaml) && /"bath corner", at: \[5\.600, 2\.400\]/.test(kept.yaml) && after.join() === 'point 1',
    `${JSON.stringify(kept.points)} -> ${JSON.stringify(after)}; ${JSON.stringify(kept.yaml)}`);
  // ghosts: coverage (computed, from the start) vs contacts (simulated); the wave reveals the coverage ones by distance
  const gm = await RM(`game.reach.ghosts('contacts'); const a = game.reach.state(); game.reach.ghosts('coverage'); const b = game.reach.state();
    game.manual = true; game.reach.play(1); const t0 = game.reach.state().t, d0 = game.reach.state().drawn;
    for (let i = 0; i < 30; i++) game.tick(0.05);
    const c = game.reach.state(); game.manual = false;
    return { a: [a.coverage, a.contacts], b: [b.coverage, b.contacts], t0, d0, t: c.t, drawn: c.drawn, dots: c.dots }`);
  check('reach: ghost modes switch coverage and contact ghosts; the wave reveals every coverage ghost from the start',
    gm.a.join() === 'false,true' && gm.b.join() === 'true,false' && gm.t0 === 0 && gm.d0 < gm.dots && gm.t === 1 && gm.drawn === gm.dots && gm.dots > 0, JSON.stringify(gm));
  const mo = await RM("return await game.moveObject('nightstand', 3.0, 3.7, 0)");
  check('reach: moving furniture with the reach map on still replans within 1 s', mo.ok && mo.ms < 1000, `${mo.ms?.toFixed(0)} ms`);
  await RM("await game.reach.clearPoints(); localStorage.removeItem('homeclear:doors:game_synth_narrow')");
  check('reach: no page errors', rm.errors.length === 0, rm.errors.join(' | ') || 'none');
  await rm.p.close();
  }
  // 20. the storyboard in the planning drawer (frontend.ts), demo mode: every step clicked as a visitor would, so a control
  // that ends up in a hidden legacy panel fails here (Playwright only clicks what is visible). Selecting furniture stands in
  // for the canvas click (game.select runs the same handler); the move itself is real arrow-key presses.
  if (existsSync(`${ROOT}viewer/public/planner/kitchen4_lighter/search.json`) && existsSync(`${ROOT}viewer/public/scene/kitchen4_lighter/scene.json`)) {
    const sb = await open('kitchen4_lighter&demo=1'), sp = sb.p;
    const S = (f: string) => G(sp, f), step = async (name: string, f: () => Promise<string>) => {
      try { check(`storyboard: ${name}`, true, await f()); } catch (e) { check(`storyboard: ${name}`, false, String(e).split('\n')[0]); } };
    await S('await game.planfix.ready');
    const scan0 = await S('return game.layout().poses.map(q => ({ x: q.x, y: q.y }))');
    await step('futures fan on, learned vs hand rule, average vs shuffler (View tab)', async () => {
      await sp.click('#tab-view'); await sp.check('#fanon'); await sp.selectOption('#fanmodel', 'hand'); const hand = await S('return game.fan.state().model');
      await sp.selectOption('#fanmodel', 'learned'); await sp.selectOption('#fanlift', 'shuffler'); const st = await S('return game.fan.state()');
      if (!st.on || hand !== 'hand' || st.model !== 'learned' || st.lift !== 'shuffler') throw Error(JSON.stringify({ on: st.on, hand, model: st.model, lift: st.lift }));
      await sp.selectOption('#fanlift', 'average'); return `on, ${hand} -> ${st.model}, lift ${st.lift}`;
    });
    await step('round-trip autoplay from the Route menu', async () => {
      await sp.click('#workspace-toggle'); await sp.selectOption('#routesel', 'rt0'); await sp.waitForTimeout(500);
      const rt = await S('return { on: game.roundTrip.on(), leg: game.roundTrip.leg() }');
      await sp.selectOption('#routesel', '0'); await sp.keyboard.press('Escape');
      if (!rt.on) throw Error(JSON.stringify(rt)); return `round trip on, leg ${rt.leg}`;
    });
    await step('night view (View tab) and Light the path (Reimagine tab)', async () => {
      await sp.click('#tab-view'); await sp.check('#night'); await sp.click('#tab-reimagine'); await sp.click('#light-path');
      await sp.waitForFunction(() => document.getElementById('light-path-note')!.textContent!.length > 0, null, { timeout: 60000 });
      const n = await S('return game.lights.list().length'), note = await sp.textContent('#light-path-note');
      await S('await game.lights.clear()'); await sp.click('#tab-view'); await sp.uncheck('#night');
      if (!n && !/no |already/i.test(note ?? '')) throw Error(note ?? ''); return `${n} nightlight(s): ${note}`;
    });
    await step('move furniture with the arrow keys and the route re-plans', async () => {
      await S("game.select('chair8'); window.__e = game.current()"); await sp.waitForSelector('#selected-controls', { state: 'visible' });
      for (let i = 0; i < 3; i++) await sp.keyboard.press('ArrowRight');
      await sp.waitForFunction(() => (window as any).game.current() !== (window as any).__e, null, { timeout: 30000 });
      await sp.keyboard.press('Escape'); return `selected-controls shown, re-planned: ${(await S('return game.current().per_month')).toFixed(2)}/month`;
    });
    await step('Plan fixes replays the B200 search and ends on Easiest / Keep my mat / Safest (Reimagine tab)', async () => {
      await sp.click('#tab-reimagine'); await sp.click('#pfplay');
      await sp.waitForFunction(() => document.querySelectorAll('#pfoptions li').length >= 2 && !(window as any).game.planfix.state().playing, null, { timeout: 180000 })
        .catch(async e => { throw Error(`${String(e).split('\n')[0]} ${JSON.stringify(await S("const s = game.planfix.state(); return { playing: s.playing, frame: s.frame, res: document.getElementById('pfresult').textContent.slice(0, 90) }"))}`); });
      const li = await sp.$$eval('#pfoptions > li', ls => ls.map(l => l.textContent!.split(':')[0].trim()));
      if (!/^Easiest/.test(li[0]) || !li.some(l => /^Keep my mat/.test(l)) || !li.some(l => /^Safest/.test(l))) throw Error(li.join(' / ')); return li.join(' / ');
    });
    await step('Keep my mat shows only mat-keeping layouts; Apply works', async () => {
      await sp.check('#pfkeepmat'); await sp.waitForTimeout(2500);
      const li = await sp.$$eval('#pfoptions > li', ls => ls.map(l => l.textContent!.split(':')[0].trim()));
      const apply = sp.locator('#pfoptions button:not([disabled])').last(); if (await apply.count()) { await apply.click(); await sp.waitForTimeout(2500); }
      const mat = await S('return game.planfix.layouts().now.mat'); await sp.uncheck('#pfkeepmat');
      if (!/^Easiest, mat kept/.test(li[0] ?? '') || mat === 'removed') throw Error(`${li.join(' / ')}; mat ${mat}`); return `${li.join(' / ')}; room now: mat ${mat}`;
    });
    await step('judge vs AI: Improve my layout from a moved chair', async () => {
      await S("await game.moveObject('chair8', 1.6, -0.9, 0)"); await sp.check('#pfmattaped'); await sp.click('#pflive');
      await sp.waitForFunction(() => /→ AI/.test(document.getElementById('pfresult')!.textContent!), null, { timeout: 120000 });
      await sp.uncheck('#pfmattaped'); return (await sp.textContent('#pfresult'))!.split('/month')[0] + '/month';
    });
    await step('world model month replay and gait fit (View tab)', async () => {
      await sp.click('#tab-view'); await sp.click('#wgmonth'); await sp.waitForTimeout(1500); const wg = await sp.textContent('#wgstatus'); await sp.click('#wgstop');
      await sp.click('#gfplay'); await sp.waitForFunction(() => document.getElementById('gfstatus')!.textContent!.length > 0, null, { timeout: 30000 });
      if (!wg) throw Error('no month replay status'); return `${wg.slice(0, 60)} | ${(await sp.textContent('#gfstatus'))!.slice(0, 60)}`;
    });
    await step('Cosmos clip plays from Scan setup & advanced tools', async () => {
      await sp.click('#workspace-toggle'); await sp.locator('#workspace-menu summary').filter({ hasText: 'advanced' }).click();
      const play = sp.locator('#clips li:not(.dbg) button').first(); await play.click(); await sp.waitForSelector('#player', { state: 'visible' });
      const src = await sp.getAttribute('#video', 'src'); await sp.click('#closeplayer'); return `playing ${src}`;
    });
    await step('OT report and QR fix card from the workspace menu', async () => {
      if (await sp.locator('#workspace-menu').isHidden()) await sp.click('#workspace-toggle');
      const [rep] = await Promise.all([sp.context().waitForEvent('page'), sp.click('#report')]);
      await rep.waitForURL(/report\.html/, { timeout: 60000 }); const ok = /Expected toe (contacts|catches)/.test((await rep.textContent('body')) ?? ''); await rep.close();
      if (await sp.locator('#workspace-menu').isHidden()) await sp.click('#workspace-toggle');
      await sp.click('#fixcard'); await sp.waitForSelector('#qr', { state: 'visible' }); const href = await sp.getAttribute('#qrlink', 'href'); await sp.click('#closeqr');
      if (!ok || !/fixcard\.html#/.test(href ?? '')) throw Error(`report ${ok}, card ${href}`); return `report renders, card ${href!.split('#')[0]}`;
    });
    await step('VR entry button is mounted (WebXR itself needs a headset)', async () => {
      const xr = await sp.evaluate(() => { const b = document.querySelector('[data-xr-persistent]'); return b ? { text: b.textContent, legacy: !!b.closest('#left, #right') } : null; });
      if (!xr || xr.legacy) throw Error(JSON.stringify(xr)); return `"${xr.text}"`;
    });
    await step('demo mode hides the scan library, wheelchair / stroke and the reach map', async () => {
      await sp.click('#tab-view');
      const shown = await sp.evaluate(() => ['#scan-library', '#scan-picker', '.persona-card[data-persona=wheelchair]', '.persona-card[data-persona=stroke]', '#reach', '#coverage']
        .filter(q => [...document.querySelectorAll<HTMLElement>(q)].some(e => e.checkVisibility())));
      const cards = await sp.$$eval('#persona-cards .persona-card', bs => bs.filter(b => (b as HTMLElement).checkVisibility()).map(b => b.textContent));
      if (shown.length || cards.some(c => /Wheelchair|Stroke/.test(c ?? ''))) throw Error(`visible: ${shown.join(', ')}; cards ${cards.join(' | ')}`); return `${cards.length} persona cards: ${cards.join(' | ')}`;
    });
    await step('Reset demo (viewer toolbar) puts back the scan: poses, tape, removals, fan and replay; same seed', async () => {
      await S("await game.fan.tapeMat(); await game.moveObject('chair8', 1.6, -0.9, 0); game.fan.set(true)");
      await sp.click('#tab-reimagine'); await sp.click('#pfplay'); await sp.waitForTimeout(1500);
      await sp.click('#resetdemo'); await sp.waitForTimeout(3000);
      const r = await S(`const L = game.layout(), s0 = ${JSON.stringify(scan0)}; return { far: Math.max(...L.poses.map((q, k) => Math.hypot(q.x - s0[k].x, q.y - s0[k].y))),
        taped: L.poses.filter(q => q.taped).length, removed: L.poses.filter(q => q.removed).length, folds: game.rugFolds.folds().length, fan: game.fan.state().on,
        playing: game.planfix.state().playing, options: document.querySelectorAll('#pfoptions li').length, seed: game.lockstep.seed, auto: game.lockstep.on() }`);
      if (r.far > 0.05 || r.taped || r.removed || r.folds || r.fan || r.playing || r.options || !r.seed || !r.auto) throw Error(JSON.stringify(r));
      return `furthest object ${(r.far * 100).toFixed(1)} cm from the scan, nothing taped / removed / folded, fan off, replay stopped; seed ${r.seed}, lockstep autoplay`;
    });
    check('storyboard: no page errors', sb.errors.length === 0, sb.errors.join(' | ') || 'none');
    await sp.close();
  }
  // 20. walking gait ghosts (gaitghosts.ts, gaitplan.ts): one translucent walker per gait walks the planned route, each its own way round the mat
  // (the seed's draw: the average lift over it, the shuffler around it), the old path traces are off while they walk, the rug folds under the
  // one that crosses, the mannequin is off by default, and each gait can be switched off
  {
    const gk = await open('kitchen4_lighter');
    const GF = (f: string) => G(gk.p, f);
    await GF("game.setAuto(); game.gaitGhosts.set(true); for (let i = 0; i < 60 && !game.gaitGhosts.state().gaits.length; i++) await new Promise(r => setTimeout(r, 500)); return 1");
    const st0 = await GF('return game.gaitGhosts.state()');
    check('gait ghosts: one walk per gait, each with a way over and a way round the mat, odds summing to 1', st0.gaits.length === 2 && st0.gaits.every((x: any) => x.routes.length >= 2 && Math.abs(x.routes.reduce((a: number, r: any) => a + r.odds, 0) - 1) < 1e-9 && x.steps > 6), JSON.stringify(st0.gaits.map((x: any) => [x.gait, x.route, +x.odds.toFixed(2), x.steps])));
    check('gait ghosts: the draw sends the average lift over the mat and the shuffler around it (seed 13)', st0.seed === 13 && st0.gaits[0].route === 'over the mat' && st0.gaits[1].route === 'around the mat', st0.gaits.map((x: any) => `${x.gait}: ${x.route}`).join(', '));
    const st1 = await GF('for (let i = 0; i < 200 && !game.gaitGhosts.state().gaits.every(x => x.landed >= x.steps); i++) await game.tick(0.1); return { s: game.gaitGhosts.state(), traces: game.debug.overlays[1].visible, man: game.mannequinVisible() }');
    check('gait ghosts: both finish their walk, the rug folds under the one that crosses it, the old path traces and the mannequin are off', st1.s.gaits.every((x: any) => x.landed >= x.steps) && st1.s.gaits[0].folded && !st1.s.gaits[1].folded && !st1.traces && !st1.man, JSON.stringify({ landed: st1.s.gaits.map((x: any) => `${x.landed}/${x.steps}`), folded: st1.s.gaits.map((x: any) => x.folded), traces: st1.traces, man: st1.man }));
    const tg = await GF("const el = (i) => document.getElementById(i); el('gait-shuffler').checked = false; el('gait-shuffler').dispatchEvent(new Event('change')); await game.tick(0.1); return game.gaitGhosts.state().gaits.map(x => x.visible)");
    check('gait ghosts: a gait can be switched off', tg[0] === true && tg[1] === false, JSON.stringify(tg));
    check('gait ghosts: no page errors', gk.errors.length === 0, gk.errors.join(' | ') || 'none');
    await gk.p.close();
  }
} finally {
  await browser.close();
  writeFileSync(new URL('results.json', import.meta.url), JSON.stringify(results, null, 1));
}
process.exit(results.length && results.every(r => r.pass) ? 0 : 1);
