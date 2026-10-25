import { onThree, own } from './lifetime.ts';
import * as THREE from 'three';
import type { FrontendAdapter, mountFrontend } from './frontend.ts';
import { summarizeChanges } from './frontend-model.ts';
import { pulse } from './controls.ts';
import { LAYERS, PRESETS } from './layers.ts';
import { PROFILES } from './vision.ts';
import { groupScans } from './scan-catalog.ts';
import type { XrButton } from './xr.ts';

// Scene meshes, not DOM: the same frontend actions remain available in WebXR.
// The one panel in the headset: tabs World / Vision / Device / Tour / More and a Fly switch, fixed to the off-hand controller
// (the left, the one on the walker) like the Google Earth VR menu: a small tilted tablet just above the handle, the wand
// hand pointing at it. The view is empty until it opens; the story buttons (xr.ts actions) are its Tour tab. A click of the
// off-hand stick opens it and another closes it; a click made while the stick leans hard (walking the walker) doesn't count.
// Renovation marking doesn't use it; trigger gestures are consumed while it is open.
export function createFrontendXR(D: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera; adapter: FrontendAdapter; frontend: ReturnType<typeof mountFrontend>; actions?: () => XrButton[]; hand?: () => XRHandedness; fly?: (on?: boolean) => boolean }) {
  const root = new THREE.Group(); root.name = 'frontend-xr-menu'; root.visible = false; D.scene.add(root);
  const ray = new THREE.Raycaster(), v = new THREE.Vector3(), dir = new THREE.Vector3();
  const controllers = [D.renderer.xr.getController(0), D.renderer.xr.getController(1)];
  const sources = new Map<THREE.Object3D, XRInputSource>(); const consumed = new Set<THREE.Object3D>();
  let stickWas = false, stickSince = 0, stickLean = 0, page = 'scans', fingerprint = '', offset = 0, notice = '';
  const game = () => (window as any).game;
  const library = () => (window as any).scanLibrary;
  function go(next: string) { page = next; offset = 0; notice = ''; fingerprint = ''; }
  async function act(task: () => unknown) { try { const g = game(), before = g.xrUIAction; g.xrUIAction = true; let result: unknown; try { result = task(); } finally { g.xrUIAction = before; } await result; } catch (error) { notice = String(error).slice(0, 90); } fingerprint = ''; }
  const hitTargets: THREE.Mesh[] = []; const disposable: { dispose(): void }[] = [];
  const inspectionRoot = new THREE.Group(); inspectionRoot.name = 'frontend-xr-inspection'; inspectionRoot.visible = false; D.scene.add(inspectionRoot);
  const toastRoot = new THREE.Group(); toastRoot.name = 'frontend-xr-notice'; toastRoot.visible = false; D.scene.add(toastRoot);
  const toastResources: { dispose(): void }[] = []; let toastUntil = 0;
  const inspectionResources: { dispose(): void }[] = []; let inspectionKey = '';
  const fade = new THREE.Mesh(new THREE.SphereGeometry(.2, 16, 12), new THREE.MeshBasicMaterial({ color: 0, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
  fade.renderOrder = 100; fade.visible = false; D.scene.add(fade);
  let transition: { start: number; task: (() => void) | null } | null = null;
  const pointers = controllers.map(c => {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x49d4c7 }));
    line.visible = false; c.add(line);
    own(() => { line.removeFromParent(); line.geometry.dispose(); (line.material as THREE.Material).dispose(); });
    const source = [...D.renderer.xr.getSession()?.inputSources ?? []][controllers.indexOf(c)]; if (source) sources.set(c, source);
    onThree(c, 'connected', e => sources.set(c, e.data)); onThree(c, 'disconnected', () => sources.delete(c));
    return line;
  });
  function clear() { root.clear(); hitTargets.length = 0; disposable.splice(0).forEach(x => x.dispose()); }
  // Tiles are flat rounded shapes on one dark sheet: rows a step lighter than the sheet, the open tab (and Fly when on) a
  // light pill, a setting that is on a teal dot (the only colour), the pointed-at tile at full brightness and the rest dimmed.
  const DIM = new THREE.Color(.8, .8, .8), FULL = new THREE.Color(1, 1, 1), PX = 1400;
  function tile(text: string, x: number, y: number, width: number, height: number, action?: () => void, accent = false, parent = root, sheet = false) {
    const canvas = document.createElement('canvas'); canvas.width = Math.round(width * PX); canvas.height = Math.round(height * PX);   // one pixel density, so type is the same size on every tile
    const ctx = canvas.getContext('2d')!, W = canvas.width, H = canvas.height, tab = parent === root && y > .4, row = !!action && width > .5;
    ctx.beginPath(); ctx.roundRect(2, 2, W - 4, H - 4, sheet ? 44 : Math.min(H * .3, 34));
    ctx.fillStyle = sheet ? 'rgba(13,17,21,.94)' : tab && accent ? '#e7ecef' : tab ? 'rgba(255,255,255,.06)' : action ? '#2b343d' : '#1b2228'; ctx.fill();
    if (sheet) { ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 3; ctx.stroke(); }
    if (row && accent) { ctx.fillStyle = '#5fd3c4'; ctx.beginPath(); ctx.arc(W - 56, H / 2, 14, 0, Math.PI * 2); ctx.fill(); }
    const lines = text.split('\n').flatMap(line => line.match(/.{1,38}(?:\s|$)|.{1,38}/g)?.map(s => s.trim()) ?? ['']).filter(Boolean);
    const font = Math.min(56, (H - 20) / (Math.max(1, lines.length) * 1.3)), left = row || (!action && width > .5 && lines.length > 1);
    ctx.textAlign = left ? 'left' : 'center'; ctx.textBaseline = 'middle';
    lines.forEach((line, i) => {
      ctx.font = `${i ? 400 : 600} ${i ? font * .78 : font}px system-ui, sans-serif`;
      ctx.fillStyle = tab ? (accent ? '#0d1216' : '#a7b2bb') : i ? '#93a1ad' : '#eef2f5';
      ctx.fillText(line, left ? 44 : W / 2, H / 2 + (i - (lines.length - 1) / 2) * font * 1.3, W - (left ? 130 : 24));
    });
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const geometry = new THREE.PlaneGeometry(width, height), material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, color: action ? DIM : FULL });
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, 0); mesh.renderOrder = sheet ? 9 : 10; if (!sheet) mesh.userData.label = text; parent.add(mesh);
    (parent === root ? disposable : parent === toastRoot ? toastResources : inspectionResources).push(texture, geometry, material);
    if (action) { mesh.userData.activate = action; hitTargets.push(mesh); }
  }
  function box(id: string) { return document.getElementById(id) as HTMLInputElement; }
  function toggle(id: string) { const el = box(id); el.checked = !el.checked; el.dispatchEvent(new Event('change', { bubbles: true })); fingerprint = ''; }
  // One panel, five tabs. A tab's own page is its root; the other pages hang off the tab that owns them (Back returns).
  const TABS: [string, string][] = [['World', 'scans'], ['Vision', 'vision'], ['Device', 'patients'], ['Tour', 'tour'], ['More', 'main']];
  const OWNER: Record<string, string> = { scans: 'scans', vision: 'vision', patients: 'patients', routes: 'patients', tour: 'tour' };   // anything else is under More
  const tabOf = (p: string) => (p.startsWith('room:') ? 'scans' : OWNER[p] ?? 'main');
  function draw() {
    clear(); const s = D.adapter.snapshot(), costs = summarizeChanges(s.changes);
    tile('', 0, -.03, 1.04, 1.1, undefined, false, root, true);
    type Row = [string, () => unknown, boolean?];
    const here = tabOf(page);
    TABS.forEach(([name, target], i) => tile(name, -.42 + i * .165, .43, .155, .09, () => go(target), here === target));
    if (D.fly) { const on = D.fly(); tile(on ? 'Flying' : 'Fly', .415, .43, .16, .09, () => { D.fly!(!on); fingerprint = ''; if (!on) close(); }, on); }   // on the right, apart from the tabs; turning it on closes the panel so you can go
    const back = () => go('main');
    const rows = (entries: Row[], parent = 'main') => {
      const count = 5, slice = entries.slice(offset, offset + count);
      slice.forEach(([text, action, on], i) => tile(text, 0, .30 - i * .115, .96, .095, () => void act(action), !!on));
      if (page !== parent) tile('Back', -.33, -.34, .29, .085, () => go(parent));
      if (offset > 0) tile('Previous', 0, -.34, .29, .085, () => { offset -= count; fingerprint = ''; });
      if (offset + count < entries.length) tile('Next', .33, -.34, .29, .085, () => { offset += count; fingerprint = ''; });
    };
    if (page === 'main') {
      rows([
        ['Explore', () => { D.frontend.setNavigation('explore'); close(); }],
        ['Follow route\nContinuous movement', () => { D.frontend.setNavigation('route'); close(); }],
        ['Inspect items', () => { D.frontend.setNavigation('inspect'); close(); }],
        ['Changes & cost', () => go('costs')], ['Findings', () => go('findings')], ['Changes', () => go('changes')],
        ['Comfort', () => go('comfort')], ['Saved viewpoints', () => go('bookmarks')], ['Presets & all layers', () => go('presets')],
        [s.paused ? 'Play route' : 'Pause route', () => D.adapter.pause()], ['Close panel', close],
      ]);
    } else if (page === 'vision') {
      const select = document.getElementById('vision') as HTMLSelectElement;
      const toggles = [['night', 'Night view'], ['particle-path', 'Particle path'], ['spot', 'Hazard highlights']] as const;
      rows([...toggles.map(([id, title]): Row => [`${box(id).checked ? 'On' : 'Off'} · ${title}`, () => toggle(id), box(id).checked]),
        ...Object.entries(PROFILES).map(([id, text]): Row => [text, () => { select.value = id; select.dispatchEvent(new Event('change')); fingerprint = ''; }, select.value === id])], 'vision');
    } else if (page === 'patients' || page === 'routes') {
      const select = document.getElementById(page === 'patients' ? 'persona' : 'routesel') as HTMLSelectElement;
      const top = document.getElementById('topdevice') as HTMLSelectElement | null;
      const options: Row[] = [...select.options].map(o => [o.text, () => { select.value = o.value; select.dispatchEvent(new Event('change')); fingerprint = ''; }, o.selected]);
      rows(page === 'routes' ? options : [...options, ['Route…', () => go('routes')], ...(top ? [[`Device at the top of stairs: ${top.selectedOptions[0]?.text ?? ''}`, () => { top.value = top.value === 'walker' ? 'rollator' : 'walker'; top.dispatchEvent(new Event('change')); fingerprint = ''; }] as Row] : [])], 'patients');
    } else if (page === 'tour') {
      const actions = D.actions?.() ?? [];
      rows(actions.map((b): Row => [b.text()[0] ?? '', () => { const r = b.press(); close(); return r; }, b.tone?.() === 'go']), 'tour');
    } else if (page === 'presets') {
      rows([...Object.entries(PRESETS).map(([id, preset]): Row => [preset.label, () => game().layers.apply(id)]), ['All layers', () => go('layers')]], 'main');
    } else if (page === 'layers') {
      rows(LAYERS.filter(l => document.getElementById(l.id)).map(l => {
        const el = document.getElementById(l.id) as HTMLInputElement & HTMLSelectElement;
        const text = l.options ? `${l.label}: ${l.options.find(o => o.value === el.value)?.label ?? el.value}` : `${el.checked ? 'On' : 'Off'} · ${l.label}`;
        return [text, () => { if (l.options) { const i = l.options.findIndex(o => o.value === el.value); el.value = l.options[(i + 1) % l.options.length].value; el.dispatchEvent(new Event('change')); } else toggle(l.id); }, el.checked];
      }), 'presets');
    } else if (page === 'scans') {
      const entries = library()?.entries() ?? [];
      rows(groupScans(entries).map(({ room }): Row => [room, () => go('room:' + room)]).concat([['Restart current demo', () => { close(); return library().restart(); }]]), 'scans');
    } else if (page.startsWith('room:')) {
      rows((library()?.entries() ?? []).filter((e: any) => e.room === page.slice(5)).map((e: any) => [`${e.version}\n${e.objects ? e.objects + ' objects' : 'Explore · no object edits'}`, () => { close(); return library().switch(e.id); }, e.id === library().current()]), 'scans');
    } else if (page === 'findings') {
      rows([['Review concerns', () => { D.frontend.setNavigation('inspect'); close(); }], ['Previous item', () => { D.frontend.inspectPrevious(); close(); }], ['Next item', () => { D.frontend.inspectNext(); close(); }], ['Flag selected finding for measurement', () => {
        const item = D.frontend.inspection(); const spot = item && s.spots.find(p => p.id === item.id);
        if (spot) { game().review.note(spot, 'Needs measurement / occupational therapist review'); notice = 'Flag saved for desktop review'; } else notice = 'Inspect a finding first';
      }], ['Save viewpoint', () => { game().bookmarks?.save(); notice = 'Viewpoint saved'; }]]);
    } else if (page === 'changes') {
      rows([['Find proposed layouts', async () => { await D.adapter.suggest(); notice = 'Options ready. Choose on desktop or try proposed layout.'; }], ['Try proposed layout / restore room', () => game().debug.xrPress(2)], [s.comparison === 0 ? 'Show proposed' : 'Show original', () => D.adapter.compare(s.comparison === 0 ? 1 : 0)], ['Undo last edit', () => game().history.undo()], ['Redo last edit', () => game().history.redo()], ['Light the path at night', () => D.adapter.lightPath?.()], ['Changes & cost', () => go('costs')]]);
    } else if (page === 'comfort') {
      rows([['Normal vision', () => game().setVision('normal')], ['Recenter at route start', () => game().recenter()], [`Movement: ${game().comfort?.movement ?? 'all'}`, () => game().comfort.cycle()], ['Toggle larger menu', () => { big = !big; root.scale.setScalar(PANEL_SCALE * (big ? 1.3 : 1)); }], ['Pause route', () => { if (!s.paused) D.adapter.pause(); }], [game().comfort.seated ? 'Standing height' : 'Seated viewing height', () => { game().comfort.seated = !game().comfort.seated; }]]);
    } else if (page === 'bookmarks') {
      rows([['Save current viewpoint', () => { game().bookmarks.save(); notice = 'Viewpoint saved'; }], ...(game().bookmarks?.list() ?? []).map((b: any): Row => [b.label, () => { game().bookmarks.restore(b.id); close(); }])]);
    } else {
      tile(`${costs.count} changes · ${costs.unpriced} unpriced\n${costs.unpriced || !costs.count ? 'Cost estimate pending' : `Known subtotal $${costs.knownSubtotal}`}\n${costs.untimed || !costs.count ? 'Setup time pending' : `${costs.setupMinutes} min hands-on`}\nHelpers: ${costs.helpers ?? 'pending'}`, 0, .12, .96, .32);
      tile('Selected item cost labels', 0, -.13, .96, .095, () => { const el = document.getElementById('reimtags') as HTMLSelectElement; el.value = 'selected'; el.dispatchEvent(new Event('change')); close(); });
      tile('Back', 0, -.34, .96, .085, back);
    }
    if (!notice && page === 'presets' && game().perf.on()) tile('Performance mode keeps heavier layers off', 0, -.47, .96, .10);
    if (notice) tile(notice, 0, -.47, .96, .10);
  }
  // The panel rides on the off-hand controller, never out in the room: about 28 cm across, 15 cm above the controller, turned
  // the way the controller points (its back toward you) and leaned back TILT so you read it by glancing down, like a tablet
  // held in that hand. Only the controller's heading counts, so a strap that rolls it doesn't tip the panel.
  const PANEL_SCALE = .28, PANEL_ABOVE = .15, TILT = 50 * Math.PI / 180, CLICK_S = .8, LEAN = .75;
  let big = false;
  const menuHand = () => D.hand?.() ?? 'left', up = new THREE.Vector3(0, 0, 1), back = new THREE.Vector3();
  const handCtl = () => controllers.find(c => sources.get(c)?.handedness === menuHand()) ?? null;
  function place(o: THREE.Object3D, above: number) {
    const c = handCtl(); if (!c) return;
    c.updateWorldMatrix(true, false); c.getWorldPosition(v); c.getWorldDirection(back).setZ(0);   // +z of the ray space: back toward you
    if (back.lengthSq() < .01) { D.camera.getWorldPosition(dir); back.subVectors(dir, v).setZ(0); }   // pointing straight up or down
    o.position.copy(v).setZ(v.z + above); o.up.copy(up); o.lookAt(dir.copy(o.position).add(back.normalize())); o.rotateX(-TILT);
  }
  function open() { root.scale.setScalar(PANEL_SCALE * (big ? 1.3 : 1)); root.visible = true; fingerprint = ''; place(root, PANEL_ABOVE); draw(); }
  function close() { root.visible = false; pointers.forEach(p => p.visible = false); }
  function intersection(controller: THREE.XRTargetRaySpace) { controller.updateWorldMatrix(true, false); ray.setFromXRController(controller); root.updateWorldMatrix(true, true); return ray.intersectObjects(hitTargets, false)[0]; }
  onThree(D.renderer.xr, 'sessionstart', () => { document.body.classList.add('xr-active'); close(); });
  onThree(D.renderer.xr, 'sessionend', () => { document.body.classList.remove('xr-active'); close(); inspectionRoot.visible = false; fade.visible = false; transition = null; consumed.clear(); stickWas = false; });
  return {
    root, inspectionRoot, open, close, notify(text: string) { notice = text; fingerprint = ''; toastRoot.clear(); toastResources.splice(0).forEach(r => r.dispose()); tile(text, 0, 0, .9, .13, undefined, false, toastRoot); toastRoot.scale.setScalar(PANEL_SCALE); toastUntil = performance.now() + 4500; }, showPage(name: string) { go(name); open(); }, isOpen: () => root.visible,
    transition(task: () => void) { transition = { start: performance.now(), task }; fade.visible = true; },
    activate(controller: THREE.XRTargetRaySpace) {
      if (!root.visible) return false;
      consumed.add(controller); if (controller === handCtl()) return true;   // the hand holding the panel doesn't point at it
      const hit = intersection(controller); (hit?.object.userData.activate as (() => void) | undefined)?.(); return true;
    },
    release(controller: THREE.XRTargetRaySpace) { return consumed.delete(controller); },
    update() {
      if (!D.renderer.xr.isPresenting) return;
      toastRoot.visible = performance.now() < toastUntil;
      if (toastRoot.visible) place(toastRoot, PANEL_ABOVE + (root.visible ? .19 : 0));   // on the hand too, over the panel when it is open
      if (transition) {
        const elapsed = (performance.now() - transition.start) / 160;
        D.camera.getWorldPosition(fade.position); (fade.material as THREE.MeshBasicMaterial).opacity = Math.min(1, elapsed < 1 ? elapsed : 2 - elapsed);
        if (elapsed >= 1 && transition.task) { transition.task(); D.camera.getWorldPosition(fade.position); transition.task = null; }
        if (elapsed >= 2) { transition = null; fade.visible = false; }
      }
      const item = game().xrInspection ? D.frontend.inspection() : null;
      inspectionRoot.visible = !!item && !root.visible;
      if (item) {
        const key = JSON.stringify([item.id, item.detail, item.change?.cost]);
        if (key !== inspectionKey) {
          inspectionKey = key; inspectionRoot.clear(); inspectionResources.splice(0).forEach(r => r.dispose());
          const title = item.title.match(/.{1,42}(?:\s|$)|.{1,42}/g)?.map(s => s.trim()).join('\n') ?? item.title;
          const cost = item.change ? item.change.cost.source === 'placeholder' ? 'Cost & installation: pending estimate' : `$${item.change.cost.usd} · ${item.change.cost.minutes} min · ${item.change.cost.helpers} helper(s)` : 'Finding for occupational therapist review';
          tile(`${title}\n${item.detail.slice(0, 90)}\n${cost}\nMenu: Findings to flag or save`, 0, 0, .7, .25, undefined, false, inspectionRoot);
          inspectionRoot.position.set(item.at[0], item.at[1], 1.3); inspectionRoot.scale.setScalar(1.6);
        }
        inspectionRoot.quaternion.copy(D.camera.getWorldQuaternion(new THREE.Quaternion()));
      }
      const pad = [...D.renderer.xr.getSession()?.inputSources ?? []].find(s => s.handedness === menuHand())?.gamepad;
      const pressed = !!pad?.buttons[3]?.pressed;
      if (pressed && !stickWas) { stickSince = performance.now(); stickLean = 0; }
      if (pressed) stickLean = Math.max(stickLean, Math.hypot(pad?.axes[2] ?? 0, pad?.axes[3] ?? 0));
      if (!pressed && stickWas && stickLean < LEAN && performance.now() - stickSince < CLICK_S * 1000) { root.visible ? close() : open(); pulse(pad, 0.4, 40); }
      stickWas = pressed;
      if (!root.visible) return;
      place(root, PANEL_ABOVE);
      const s = D.adapter.snapshot(), next = JSON.stringify([page, offset, notice, (document.getElementById('vision') as HTMLSelectElement).value, s.patient, s.route, game().comfort?.movement, D.fly?.(), s.paused, s.comparison === 0, s.changes.length, ...(page === 'tour' ? (D.actions?.() ?? []).map(b => [b.text()[0], b.tone?.()]) : []),...['night', 'particle-path', 'spot', 'improvement-highlights', 'reimghosts'].map(id => box(id).checked)]);
      if (fingerprint !== next) { fingerprint = next; draw(); }
      let hot: THREE.Object3D | undefined;
      controllers.forEach((c, i) => { pointers[i].visible = sources.has(c) && sources.get(c)!.handedness !== menuHand(); if (pointers[i].visible) { const hit = intersection(c); hot ??= hit?.object; pointers[i].scale.z = hit?.distance ?? .6; } });
      hitTargets.forEach(m => (m.material as THREE.MeshBasicMaterial).color.copy(m === hot ? FULL : DIM));
    },
  };
}
