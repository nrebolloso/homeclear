import { onThree } from './lifetime.ts';
import * as THREE from 'three';
import type { FrontendAdapter, mountFrontend } from './frontend.ts';
import { summarizeChanges } from './frontend-model.ts';
import { pulse, MENU_HOLD_S } from './controls.ts';

// Scene meshes, not DOM: the same frontend actions remain available in WebXR.
// Holding the left stick click opens the menu (a tap is too easy to hit by accident; clicking while it is open closes it).
// Renovation marking doesn't use it; trigger gestures are consumed while the menu is open.
export function createFrontendXR(D: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera; adapter: FrontendAdapter; frontend: ReturnType<typeof mountFrontend> }) {
  const root = new THREE.Group(); root.name = 'frontend-xr-menu'; root.visible = false; D.scene.add(root);
  const ray = new THREE.Raycaster(), v = new THREE.Vector3(), dir = new THREE.Vector3();
  const controllers = [D.renderer.xr.getController(0), D.renderer.xr.getController(1)];
  const sources = new Map<THREE.Object3D, XRInputSource>(); const consumed = new Set<THREE.Object3D>();
  let stickWas = false, stickSince = 0, stickFired = false, page: 'main' | 'filters' | 'costs' = 'main', fingerprint = '';
  const hitTargets: THREE.Mesh[] = []; const disposable: { dispose(): void }[] = [];
  const inspectionRoot = new THREE.Group(); inspectionRoot.name = 'frontend-xr-inspection'; inspectionRoot.visible = false; D.scene.add(inspectionRoot);
  const inspectionResources: { dispose(): void }[] = []; let inspectionKey = '';
  const fade = new THREE.Mesh(new THREE.SphereGeometry(.2, 16, 12), new THREE.MeshBasicMaterial({ color: 0, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
  fade.renderOrder = 100; fade.visible = false; D.scene.add(fade);
  let transition: { start: number; task: (() => void) | null } | null = null;
  const pointers = controllers.map(c => {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x49d4c7 }));
    line.visible = false; c.add(line);
    onThree(c, 'connected', e => sources.set(c, e.data)); onThree(c, 'disconnected', () => sources.delete(c));
    return line;
  });
  function clear() { root.clear(); hitTargets.length = 0; disposable.splice(0).forEach(x => x.dispose()); }
  function tile(text: string, x: number, y: number, width: number, height: number, action?: () => void, accent = false, parent = root) {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = Math.round(1024 * height / width);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = accent ? '#244a46' : '#18252f'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = accent ? '#49d4c7' : '#455b6b'; ctx.lineWidth = 4; ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
    const lines = text.split('\n'), font = Math.min(60, (canvas.height - 28) / lines.length * .68);
    ctx.font = `600 ${font}px system-ui`; ctx.fillStyle = accent ? '#bafff4' : '#e8f2f8'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    lines.forEach((line, i) => ctx.fillText(line, 512, canvas.height / 2 + (i - (lines.length - 1) / 2) * (font * 1.5), 960));
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const geometry = new THREE.PlaneGeometry(width, height), material = new THREE.MeshBasicMaterial({ map: texture, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x, y, 0); mesh.renderOrder = 10; mesh.userData.label = text; parent.add(mesh);
    (parent === root ? disposable : inspectionResources).push(texture, geometry, material);
    if (action) { mesh.userData.activate = action; hitTargets.push(mesh); }
  }
  function box(id: string) { return document.getElementById(id) as HTMLInputElement; }
  function toggle(id: string) { const el = box(id); el.checked = !el.checked; el.dispatchEvent(new Event('change', { bubbles: true })); fingerprint = ''; }
  function draw() {
    clear(); const s = D.adapter.snapshot(), costs = summarizeChanges(s.changes);
    tile('Cleared · ' + (page === 'main' ? 'Room controls' : page === 'filters' ? 'View filters' : 'Changes & effort'), 0, .37, .9, .1);
    if (page === 'main') {
      tile('Explore', -.235, .23, .43, .1, () => { D.frontend.setNavigation('explore'); close(); });
      tile('Follow route\nContinuous movement', .235, .23, .43, .1, () => { D.frontend.setNavigation('route'); close(); });
      tile('Inspect items', -.235, .10, .43, .1, () => { D.frontend.setNavigation('inspect'); close(); });
      tile(s.paused ? 'Play route' : 'Pause route', .235, .10, .43, .1, () => { D.adapter.pause(); fingerprint = ''; });
      tile('Previous item', -.235, -.03, .43, .1, () => { D.frontend.inspectPrevious(); close(); });
      tile('Next item', .235, -.03, .43, .1, () => { D.frontend.inspectNext(); close(); });
      tile(s.comparison === 0 ? 'Show proposed' : 'Show original', -.235, -.16, .43, .1, () => { D.adapter.compare(s.comparison === 0 ? 1 : 0); fingerprint = ''; }, s.comparison === 0);
      tile('View filters', .235, -.16, .43, .1, () => { page = 'filters'; fingerprint = ''; });
      tile('Changes & cost', -.235, -.29, .43, .1, () => { page = 'costs'; fingerprint = ''; });
      tile('Close', .235, -.29, .43, .1, close);
    } else if (page === 'filters') {
      const entries = [['night', 'Night view'], ['particle-path', 'Particle path'], ['spot', 'Hazard highlights'], ['improvement-highlights', 'Improvements'], ['reimghosts', 'Original positions']] as const;
      entries.forEach(([id, title], i) => tile(`${box(id).checked ? 'On' : 'Off'} · ${title}`, 0, .23 - i * .105, .9, .085, () => toggle(id), box(id).checked));
      const vision = document.getElementById('vision') as HTMLSelectElement;
      tile(`Vision: ${vision.selectedOptions[0]?.textContent ?? 'Normal'}\nSelect to cycle`, 0, -.30, .9, .10, () => { vision.selectedIndex = (vision.selectedIndex + 1) % vision.options.length; vision.dispatchEvent(new Event('change', { bubbles: true })); fingerprint = ''; });
      tile('Back', 0, -.43, .9, .085, () => { page = 'main'; fingerprint = ''; });
    } else {
      tile(`${costs.count} changes · ${costs.unpriced} unpriced\n${costs.unpriced || !costs.count ? 'Cost estimate pending' : `Known subtotal $${costs.knownSubtotal}`}\n${costs.untimed || !costs.count ? 'Setup time pending' : `${costs.setupMinutes} min hands-on`}\nHelpers: ${costs.helpers ?? 'pending'}`, 0, .1, .9, .35);
      tile('Selected item cost labels', 0, -.16, .9, .1, () => { const el = document.getElementById('reimtags') as HTMLSelectElement; el.value = 'selected'; el.dispatchEvent(new Event('change')); close(); });
      tile('Back', 0, -.29, .9, .1, () => { page = 'main'; fingerprint = ''; });
    }
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
    root, inspectionRoot, open, close, isOpen: () => root.visible,
    transition(task: () => void) { transition = { start: performance.now(), task }; fade.visible = true; },
    activate(controller: THREE.XRTargetRaySpace) {
      if (!root.visible) return false;
      consumed.add(controller); const hit = intersection(controller); (hit?.object.userData.activate as (() => void) | undefined)?.(); return true;
    },
    release(controller: THREE.XRTargetRaySpace) { return consumed.delete(controller); },
    update() {
      if (!D.renderer.xr.isPresenting) return;
      if (transition) {
        const elapsed = (performance.now() - transition.start) / 160;
        D.camera.getWorldPosition(fade.position); (fade.material as THREE.MeshBasicMaterial).opacity = Math.min(1, elapsed < 1 ? elapsed : 2 - elapsed);
        if (elapsed >= 1 && transition.task) { transition.task(); D.camera.getWorldPosition(fade.position); transition.task = null; }
        if (elapsed >= 2) { transition = null; fade.visible = false; }
      }
      const item = D.frontend.inspection();
      inspectionRoot.visible = !!item && !root.visible;
      if (item) {
        const key = JSON.stringify([item.id, item.detail, item.change?.cost]);
        if (key !== inspectionKey) {
          inspectionKey = key; inspectionRoot.clear(); inspectionResources.splice(0).forEach(r => r.dispose());
          const title = item.title.match(/.{1,42}(?:\s|$)|.{1,42}/g)?.map(s => s.trim()).join('\n') ?? item.title;
          const cost = item.change ? item.change.cost.source === 'placeholder' ? 'Cost & installation: pending estimate' : `$${item.change.cost.usd} · ${item.change.cost.minutes} min · ${item.change.cost.helpers} helper(s)` : 'Finding for occupational therapist review';
          tile(`${title}\n${cost}\nHold left stick click: previous / next controls`, 0, 0, .7, .25, undefined, false, inspectionRoot);
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
      const s = D.adapter.snapshot(), next = JSON.stringify([page, s.paused, s.comparison === 0, s.changes.length, ...['night', 'particle-path', 'spot', 'improvement-highlights', 'reimghosts'].map(id => box(id).checked)]);
      if (fingerprint !== next) { fingerprint = next; draw(); }
      controllers.forEach((c, i) => { pointers[i].visible = sources.has(c); if (pointers[i].visible) { const hit = intersection(c); pointers[i].scale.z = hit?.distance ?? 1.5; } });
    },
  };
}
