import { onThree, own } from './lifetime.ts';
import * as THREE from 'three';
import type { FrontendAdapter, mountFrontend } from './frontend.ts';
import { summarizeChanges, orderedProposals } from './frontend-model.ts';
import { costText } from './reimagine.ts';
import { pulse, MENU_HOLD_S } from './controls.ts';
import { LAYERS, PRESETS } from './layers.ts';
import { PROFILES } from './vision.ts';
import { groupScans } from './scan-catalog.ts';
import type { XrButton } from './xr.ts';

// Scene meshes, not DOM: the same frontend actions remain available in WebXR.
// The one panel in the headset: tabs World / Vision / Device / Tour / More, standing 2 m out where you faced. The view is
// empty until it opens; the story buttons (xr.ts actions) are its Tour tab.
// Holding the left stick click opens the menu (a tap is too easy to hit by accident; clicking while it is open closes it).
// Renovation marking doesn't use it; trigger gestures are consumed while the menu is open.
export function createFrontendXR(D: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera; adapter: FrontendAdapter; frontend: ReturnType<typeof mountFrontend>; actions?: () => XrButton[] }) {
  const root = new THREE.Group(); root.name = 'frontend-xr-menu'; root.visible = false; D.scene.add(root);
  const ray = new THREE.Raycaster(), v = new THREE.Vector3(), dir = new THREE.Vector3();
  const controllers = [D.renderer.xr.getController(0), D.renderer.xr.getController(1)];
  const sources = new Map<THREE.Object3D, XRInputSource>(); const consumed = new Set<THREE.Object3D>();
  let stickWas = false, stickSince = 0, stickFired = false, page = 'scans', fingerprint = '', offset = 0, notice = '', proposal = 0;
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
    const lines = text.split('\n').flatMap(line => line.match(/.{1,34}(?:\s|$)|.{1,34}/g)?.map(s => s.trim()) ?? ['']), font = Math.min(76, (canvas.height - 28) / lines.length * .82);
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
  // One panel, five tabs. A tab's own page is its root; the other pages hang off the tab that owns them (Back returns).
  const TABS: [string, string][] = [['World', 'scans'], ['Vision', 'vision'], ['Device', 'patients'], ['Tour', 'tour'], ['More', 'main']];
  const OWNER: Record<string, string> = { scans: 'scans', vision: 'vision', patients: 'patients', routes: 'patients', tour: 'tour' };   // anything else is under More
  const tabOf = (p: string) => (p.startsWith('room:') ? 'scans' : OWNER[p] ?? 'main');
  function draw() {
    clear(); const s = D.adapter.snapshot(), costs = summarizeChanges(s.changes);
    type Row = [string, () => unknown, boolean?];
    const here = tabOf(page);
    TABS.forEach(([name, target], i) => tile(name, (i - 2) * .195, .43, .185, .09, () => go(target), here === target));
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
      const list = orderedProposals(s.options), at = Math.min(proposal, Math.max(0, list.length - 1)), shown = list[at]?.option;
      const stepTo = async (to: number) => { if (to < 0 || to >= list.length) return; proposal = to; await D.adapter.preview?.(list[to].index); notice = `Proposal ${to + 1} of ${list.length}: ${list[to].option.name}`; };
      rows([['Generate proposals', async () => { await D.adapter.suggest(); const first = orderedProposals(D.adapter.snapshot().options); proposal = 0; if (first.length) { await D.adapter.preview?.(first[0].index); notice = `Proposal 1 of ${first.length}: ${first[0].option.name}`; } else notice = 'No suggested changes'; }],
        ...(list.length ? [
          [`Next option\n${at + 1} of ${list.length} · ${shown.name} · ${shown.per_month.toFixed(1)}/month`, () => stepTo(at + 1)] as Row,
          ['Previous option', () => stepTo(at - 1)] as Row,
          ['Apply this proposal', () => { D.adapter.commit?.(); notice = 'Applied. Review it under Changes & cost.'; }, true] as Row,
          ['Reset room', async () => { await D.adapter.reset?.(); notice = 'Room restored'; }] as Row] : []),
        ['Try proposed layout / restore room', () => game().debug.xrPress(2)], [s.comparison === 0 ? 'Show proposed' : 'Show original', () => D.adapter.compare(s.comparison === 0 ? 1 : 0)], ['Undo last edit', () => game().history.undo()], ['Redo last edit', () => game().history.redo()], ['Light the path at night', () => D.adapter.lightPath?.()], ['Changes & cost', () => go('costs')]]);
    } else if (page === 'comfort') {
      rows([['Normal vision', () => game().setVision('normal')], ['Recenter at route start', () => game().recenter()], [`Movement: ${game().comfort?.movement ?? 'all'}`, () => game().comfort.cycle()], ['Toggle larger menu', () => { root.scale.setScalar(root.scale.x > PANEL_SCALE ? PANEL_SCALE : PANEL_SCALE * 1.2); }], ['Pause route', () => { if (!s.paused) D.adapter.pause(); }], [game().comfort.seated ? 'Standing height' : 'Seated viewing height', () => { game().comfort.seated = !game().comfort.seated; }]]);
    } else if (page === 'bookmarks') {
      rows([['Save current viewpoint', () => { game().bookmarks.save(); notice = 'Viewpoint saved'; }], ...(game().bookmarks?.list() ?? []).map((b: any): Row => [b.label, () => { game().bookmarks.restore(b.id); close(); }])]);
    } else {
      tile(`${costs.count} changes · ${costs.unpriced} unpriced\n${costs.unpriced || !costs.count ? 'Cost estimate pending' : `Known subtotal $${costs.knownSubtotal}`}\n${costs.count ? `Effort cost ${costs.effortScore}/100` : 'Effort cost pending'}\nHelpers: ${costs.helpers ?? 'pending'}`, 0, .12, .96, .32);
      tile('Selected item cost labels', 0, -.13, .96, .095, () => { const el = document.getElementById('reimtags') as HTMLSelectElement; el.value = 'selected'; el.dispatchEvent(new Event('change')); close(); });
      tile('Back', 0, -.34, .96, .085, back);
    }
    if (!notice && page === 'presets' && game().perf.on()) tile('Performance mode keeps heavier layers off', 0, -.47, .96, .10);
    if (notice) tile(notice, 0, -.47, .96, .10);
  }
  // The panel is a wall screen, not a hand-held card: 2 m out, level with the eyes, standing where you faced when it opened
  // and staying there (it does not follow your head). Yaw only: it stays upright however you tilt your head.
  const PANEL_DIST = 2.0, PANEL_SCALE = 2.3, PANEL_DROP = .05;
  const basis = new THREE.Matrix4(), bx = new THREE.Vector3(), by = new THREE.Vector3(0, 0, 1), bz = new THREE.Vector3();
  function open() {
    D.camera.getWorldPosition(v); D.camera.getWorldDirection(dir);
    dir.z = 0; if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0); dir.normalize();   // looking straight up or down: fall back to +x
    root.position.copy(v).addScaledVector(dir, PANEL_DIST); root.position.z = v.z - PANEL_DROP;
    bz.copy(dir).negate(); bx.crossVectors(by, bz).normalize();
    root.quaternion.setFromRotationMatrix(basis.makeBasis(bx, by, bz)); root.scale.setScalar(PANEL_SCALE);
    root.visible = true; fingerprint = ''; draw();
  }
  function close() { root.visible = false; pointers.forEach(p => p.visible = false); }
  function intersection(controller: THREE.XRTargetRaySpace) { controller.updateWorldMatrix(true, false); ray.setFromXRController(controller); root.updateWorldMatrix(true, true); return ray.intersectObjects(hitTargets, false)[0]; }
  onThree(D.renderer.xr, 'sessionstart', () => { document.body.classList.add('xr-active'); close(); });
  onThree(D.renderer.xr, 'sessionend', () => { document.body.classList.remove('xr-active'); close(); inspectionRoot.visible = false; fade.visible = false; transition = null; consumed.clear(); stickWas = false; });
  return {
    root, inspectionRoot, open, close, notify(text: string) { notice = text; fingerprint = ''; toastRoot.clear(); toastResources.splice(0).forEach(r => r.dispose()); tile(text, 0, 0, .8, .13, undefined, false, toastRoot); toastRoot.scale.setScalar(1.6); toastUntil = performance.now() + 4500; }, showPage(name: string) { go(name); open(); }, isOpen: () => root.visible,
    transition(task: () => void) { transition = { start: performance.now(), task }; fade.visible = true; },
    activate(controller: THREE.XRTargetRaySpace) {
      if (!root.visible) return false;
      consumed.add(controller); const hit = intersection(controller); (hit?.object.userData.activate as (() => void) | undefined)?.(); return true;
    },
    release(controller: THREE.XRTargetRaySpace) { return consumed.delete(controller); },
    update() {
      if (!D.renderer.xr.isPresenting) return;
      toastRoot.visible = performance.now() < toastUntil;
      if (toastRoot.visible) { D.camera.getWorldPosition(v); D.camera.getWorldDirection(dir); toastRoot.position.copy(v).addScaledVector(dir, 1.6); toastRoot.position.z -= .75; toastRoot.quaternion.copy(D.camera.getWorldQuaternion(new THREE.Quaternion())); }   // low and ahead, off the line of sight
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
          const cost = item.change ? item.change.cost.source === 'placeholder' ? 'Cost & installation: pending estimate' : costText(item.change.cost) : 'Finding for occupational therapist review';
          tile(`${title}\n${item.detail.slice(0, 90)}\n${cost}\nMenu: Findings to flag or save`, 0, 0, .7, .25, undefined, false, inspectionRoot);
          inspectionRoot.position.set(item.at[0], item.at[1], 1.3); inspectionRoot.scale.setScalar(1.6);
        }
        inspectionRoot.quaternion.copy(D.camera.getWorldQuaternion(new THREE.Quaternion()));
      }
      const left = [...D.renderer.xr.getSession()?.inputSources ?? []].find(s => s.handedness === 'left');
      const pressed = !!left?.gamepad?.buttons[3]?.pressed;
      if (pressed && !stickWas) { stickSince = performance.now(); stickFired = false; }
      if (pressed && !stickFired && (root.visible || performance.now() - stickSince >= MENU_HOLD_S * 1000)) { stickFired = true; root.visible ? close() : open(); pulse(left?.gamepad, 0.4, 40); }
      stickWas = pressed;
      if (!root.visible) return;
      const s = D.adapter.snapshot(), next = JSON.stringify([page, offset, notice, (document.getElementById('vision') as HTMLSelectElement).value, s.patient, s.route, game().comfort?.movement, s.paused, s.comparison === 0, s.changes.length, proposal, ...(page === 'tour' ? (D.actions?.() ?? []).map(b => [b.text()[0], b.tone?.()]) : []),...['night', 'particle-path', 'spot', 'improvement-highlights', 'reimghosts'].map(id => box(id).checked)]);
      if (fingerprint !== next) { fingerprint = next; draw(); }
      controllers.forEach((c, i) => { pointers[i].visible = sources.has(c); if (pointers[i].visible) { const hit = intersection(c); pointers[i].scale.z = hit?.distance ?? 2.5; } });
    },
  };
}
