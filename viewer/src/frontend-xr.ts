import { onThree, own } from './lifetime.ts';
import * as THREE from 'three';
import type { FrontendAdapter, mountFrontend } from './frontend.ts';
import { summarizeChanges } from './frontend-model.ts';
import { pulse, MENU_HOLD_S } from './controls.ts';
import { LAYERS, PRESETS } from './layers.ts';
import { PROFILES } from './vision.ts';
import { groupScans } from './scan-catalog.ts';

// Scene meshes, not DOM: the same frontend actions remain available in WebXR.
// Holding the left stick click opens the menu (a tap is too easy to hit by accident; clicking while it is open closes it).
// Renovation marking doesn't use it; trigger gestures are consumed while the menu is open.
export function createFrontendXR(D: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera; adapter: FrontendAdapter; frontend: ReturnType<typeof mountFrontend> }) {
  const root = new THREE.Group(); root.name = 'frontend-xr-menu'; root.visible = false; D.scene.add(root);
  const ray = new THREE.Raycaster(), v = new THREE.Vector3(), dir = new THREE.Vector3();
  const controllers = [D.renderer.xr.getController(0), D.renderer.xr.getController(1)];
  const sources = new Map<THREE.Object3D, XRInputSource>(); const consumed = new Set<THREE.Object3D>();
  let stickWas = false, stickSince = 0, stickFired = false, page = 'main', fingerprint = '', offset = 0, notice = '';
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
  function tile(text: string, x: number, y: number, width: number, height: number, action?: () => void, accent = false, parent = root) {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = Math.round(1024 * height / width);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = accent ? '#244a46' : '#18252f'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = accent ? '#49d4c7' : '#455b6b'; ctx.lineWidth = 4; ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
    const lines = text.split('\n').flatMap(line => line.match(/.{1,42}(?:\s|$)|.{1,42}/g)?.map(s => s.trim()) ?? ['']), font = Math.min(60, (canvas.height - 28) / lines.length * .68);
    ctx.font = `600 ${font}px system-ui`; ctx.fillStyle = accent ? '#bafff4' : '#e8f2f8'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    lines.forEach((line, i) => ctx.fillText(line, 512, canvas.height / 2 + (i - (lines.length - 1) / 2) * (font * 1.5), 960));
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const geometry = new THREE.PlaneGeometry(width, height), material = new THREE.MeshBasicMaterial({ map: texture, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, 0); mesh.renderOrder = 10; mesh.userData.label = text; parent.add(mesh);
    (parent === root ? disposable : parent === toastRoot ? toastResources : inspectionResources).push(texture, geometry, material);
    if (action) { mesh.userData.activate = action; hitTargets.push(mesh); }
  }
  function box(id: string) { return document.getElementById(id) as HTMLInputElement; }
  function toggle(id: string) { const el = box(id); el.checked = !el.checked; el.dispatchEvent(new Event('change', { bubbles: true })); fingerprint = ''; }
  function draw() {
    clear(); const s = D.adapter.snapshot(), costs = summarizeChanges(s.changes);
    const titles: Record<string, string> = { main: 'Room controls', filters: 'View filters', costs: 'Changes & effort', scans: 'Scan library', experience: 'Experience', vision: 'Vision simulation', findings: 'Findings', changes: 'Changes', layers: 'Display layers', presets: 'Display presets', comfort: 'Comfort', bookmarks: 'Saved viewpoints', patients: 'Patient / device', routes: 'Routes' };
    tile('Cleared · ' + (titles[page] ?? page.replace('room:', '')), 0, .43, .96, .09);
    type Row = [string, () => unknown, boolean?];
    const back = () => go('main');
    const rows = (entries: Row[], parent = 'main') => {
      const count = 5, slice = entries.slice(offset, offset + count);
      slice.forEach(([text, action, on], i) => tile(text, 0, .30 - i * .115, .96, .095, () => void act(action), !!on));
      tile('Back', -.33, -.34, .29, .085, () => go(parent));
      if (offset > 0) tile('Previous', 0, -.34, .29, .085, () => { offset -= count; fingerprint = ''; });
      if (offset + count < entries.length) tile('More', .33, -.34, .29, .085, () => { offset += count; fingerprint = ''; });
    };
    if (page === 'main') {
      const entries: Row[] = [
        ['Explore', () => { D.frontend.setNavigation('explore'); close(); }],
        ['Follow route\nContinuous movement', () => { D.frontend.setNavigation('route'); close(); }],
        ['Inspect items', () => { D.frontend.setNavigation('inspect'); close(); }], ['Scans', () => go('scans')],
        ['Experience', () => go('experience')], ['Findings', () => go('findings')],
        ['Changes', () => go('changes')], ['View filters', () => go('filters')],
        ['Changes & cost', () => go('costs')], ['Comfort', () => go('comfort')],
        ['Saved viewpoints', () => go('bookmarks')], ['Close', close],
      ];
      entries.forEach(([text, action], i) => tile(text, i % 2 ? .25 : -.25, .30 - Math.floor(i / 2) * .115, .47, .095, () => void act(action)));
    } else if (page === 'filters') {
      const entries = [['night', 'Night view'], ['particle-path', 'Particle path'], ['spot', 'Hazard highlights']] as const;
      rows([...entries.map(([id, title]): Row => [`${box(id).checked ? 'On' : 'Off'} · ${title}`, () => toggle(id), box(id).checked]), ['Vision profiles', () => go('vision')], ['Presets & all layers', () => go('presets')]]);
    } else if (page === 'vision') {
      const select = document.getElementById('vision') as HTMLSelectElement;
      rows(Object.entries(PROFILES).map(([id, text]): Row => [text, () => { select.value = id; select.dispatchEvent(new Event('change')); fingerprint = ''; }, select.value === id]), 'experience');
    } else if (page === 'experience') {
      rows([['Patient / device', () => go('patients')], ['Route', () => go('routes')], ['Vision profiles', () => go('vision')], [`${box('night').checked ? 'On' : 'Off'} · Night view`, () => toggle('night')], [s.paused ? 'Play route' : 'Pause route', () => D.adapter.pause()]]);
    } else if (page === 'patients' || page === 'routes') {
      const select = document.getElementById(page === 'patients' ? 'persona' : 'routesel') as HTMLSelectElement;
      rows([...select.options].map(o => [o.text, () => { select.value = o.value; select.dispatchEvent(new Event('change')); fingerprint = ''; }, o.selected]), 'experience');
    } else if (page === 'presets') {
      rows([...Object.entries(PRESETS).map(([id, preset]): Row => [preset.label, () => game().layers.apply(id)]), ['All layers', () => go('layers')]], 'filters');
    } else if (page === 'layers') {
      rows(LAYERS.filter(l => document.getElementById(l.id)).map(l => {
        const el = document.getElementById(l.id) as HTMLInputElement & HTMLSelectElement;
        const text = l.options ? `${l.label}: ${l.options.find(o => o.value === el.value)?.label ?? el.value}` : `${el.checked ? 'On' : 'Off'} · ${l.label}`;
        return [text, () => { if (l.options) { const i = l.options.findIndex(o => o.value === el.value); el.value = l.options[(i + 1) % l.options.length].value; el.dispatchEvent(new Event('change')); } else toggle(l.id); }, el.checked];
      }), 'presets');
    } else if (page === 'scans') {
      const entries = library()?.entries() ?? [];
      rows(groupScans(entries).map(({ room }): Row => [room, () => go('room:' + room)]).concat([['Restart current demo', () => { close(); return library().restart(); }]]));
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
      rows([['Normal vision', () => game().setVision('normal')], ['Recenter at route start', () => game().recenter()], [`Movement: ${game().comfort?.movement ?? 'all'}`, () => game().comfort.cycle()], ['Toggle larger menu', () => { root.scale.setScalar(root.scale.x > 1 ? 1 : 1.2); }], ['Pause route', () => { if (!s.paused) D.adapter.pause(); }], [game().comfort.seated ? 'Standing height' : 'Seated viewing height', () => { game().comfort.seated = !game().comfort.seated; }]]);
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
  function open() {
    D.camera.getWorldPosition(v); D.camera.getWorldDirection(dir);
    root.position.copy(v).addScaledVector(dir, 1.25); root.position.z -= .08;
    root.quaternion.copy(D.camera.getWorldQuaternion(new THREE.Quaternion()));
    root.visible = true; fingerprint = ''; draw();
  }
  function close() { root.visible = false; pointers.forEach(p => p.visible = false); }
  function intersection(controller: THREE.XRTargetRaySpace) { controller.updateWorldMatrix(true, false); ray.setFromXRController(controller); root.updateWorldMatrix(true, true); return ray.intersectObjects(hitTargets, false)[0]; }
  onThree(D.renderer.xr, 'sessionstart', () => { document.body.classList.add('xr-active'); close(); });
  onThree(D.renderer.xr, 'sessionend', () => { document.body.classList.remove('xr-active'); close(); inspectionRoot.visible = false; fade.visible = false; transition = null; consumed.clear(); stickWas = false; });
  return {
    root, inspectionRoot, open, close, notify(text: string) { notice = text; fingerprint = ''; toastRoot.clear(); toastResources.splice(0).forEach(r => r.dispose()); tile(text, 0, 0, .8, .13, undefined, false, toastRoot); toastUntil = performance.now() + 4500; }, showPage(name: string) { go(name); open(); }, isOpen: () => root.visible,
    transition(task: () => void) { transition = { start: performance.now(), task }; fade.visible = true; },
    activate(controller: THREE.XRTargetRaySpace) {
      if (!root.visible) return false;
      consumed.add(controller); const hit = intersection(controller); (hit?.object.userData.activate as (() => void) | undefined)?.(); return true;
    },
    release(controller: THREE.XRTargetRaySpace) { return consumed.delete(controller); },
    update() {
      if (!D.renderer.xr.isPresenting) return;
      toastRoot.visible = performance.now() < toastUntil;
      if (toastRoot.visible) { D.camera.getWorldPosition(v); D.camera.getWorldDirection(dir); toastRoot.position.copy(v).addScaledVector(dir, 1.3); toastRoot.position.z -= .3; toastRoot.quaternion.copy(D.camera.getWorldQuaternion(new THREE.Quaternion())); }
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
          inspectionRoot.position.set(item.at[0], item.at[1], 1.15);
        }
        inspectionRoot.quaternion.copy(D.camera.getWorldQuaternion(new THREE.Quaternion()));
      }
      const left = [...D.renderer.xr.getSession()?.inputSources ?? []].find(s => s.handedness === 'left');
      const pressed = !!left?.gamepad?.buttons[3]?.pressed;
      if (pressed && !stickWas) { stickSince = performance.now(); stickFired = false; }
      if (pressed && !stickFired && (root.visible || performance.now() - stickSince >= MENU_HOLD_S * 1000)) { stickFired = true; root.visible ? close() : open(); pulse(left?.gamepad, 0.4, 40); }
      stickWas = pressed;
      if (!root.visible) return;
      const s = D.adapter.snapshot(), next = JSON.stringify([page, offset, notice, (document.getElementById('vision') as HTMLSelectElement).value, s.patient, s.route, game().comfort?.movement, s.paused, s.comparison === 0, s.changes.length, ...['night', 'particle-path', 'spot', 'improvement-highlights', 'reimghosts'].map(id => box(id).checked)]);
      if (fingerprint !== next) { fingerprint = next; draw(); }
      controllers.forEach((c, i) => { pointers[i].visible = sources.has(c); if (pointers[i].visible) { const hit = intersection(c); pointers[i].scale.z = hit?.distance ?? 1.5; } });
    },
  };
}
