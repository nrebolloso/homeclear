import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createVision, PROFILES, type Profile } from './vision.ts';
import { every, onDocument, onWindow, own, onCanvas } from './lifetime.ts';
import './companion.css';

export function createCompanion(D: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; head: THREE.PerspectiveCamera; game: any; centre: [number, number]; size: number }) {
  const { renderer, scene, game } = D;
  const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, .05, 100);
  camera.position.set(D.centre[0] - D.size * .65, D.centre[1] - D.size * .65, Math.max(2, D.size * .6));
  const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(...D.centre, .8); controls.enableDamping = true; controls.enabled = false; controls.update();
  const vision = createVision(renderer, scene, camera);
  let mode = 'companion', last = -Infinity, linked = true, localVision: Profile = 'normal', localOverlays = true, presenting = false;
  // Steady headset view: the raw head pose shakes and rolls, which onlookers find hard to watch; ease it and keep the horizon level.
  let steady = true, held: { at: THREE.Vector3; fwd: THREE.Vector3; t: number } | null = null;
  const UP = new THREE.Vector3(0, 0, 1), ORIGIN = new THREE.Vector3(), level = new THREE.Matrix4();
  const panel = document.createElement('section'); panel.id = 'companion-controls'; panel.hidden = true; panel.setAttribute('aria-label', 'VR desktop companion');
  panel.innerHTML = `<label>Desktop view <select id="companion-mode"><option value="companion">Companion workspace</option><option value="headset">Headset perspective</option><option value="split">Workspace + headset preview</option></select></label>
    <label><input id="companion-steady" type="checkbox" checked> Steady headset view (smoothed, level)</label>
    <label><input id="companion-link" type="checkbox" checked> Match headset vision</label>
    <label>Desktop vision <select id="companion-vision"></select></label>
    <label><input id="companion-overlays" type="checkbox" checked> Desktop overlays</label>
    <button id="companion-save">Save viewpoint</button><button id="companion-demo">Demo / operator</button><button id="companion-full">Fullscreen</button><button id="companion-clean">Clean view (Esc to undo)</button><button id="companion-reset">Reset VR</button><button id="companion-exit">Exit VR</button>
    <details><summary>Edit shared room</summary><label>Object <select id="companion-object"></select></label>
    <div class="companion-pose"><label>X (m)<input id="companion-x" type="number" step="0.05"></label><label>Y (m)<input id="companion-y" type="number" step="0.05"></label><label>Turn (°)<input id="companion-yaw" type="number" step="90"></label></div>
    <button id="companion-move">Apply move</button><button id="companion-remove">Remove</button><button id="companion-undo">Undo</button><button id="companion-redo">Redo</button>
    <button id="companion-proposals">Prepare layouts</button><select id="companion-plan" aria-label="Prepared layouts"></select><button id="companion-apply">Apply selected layout</button></details>
    <details><summary>Saved viewpoints</summary><select id="companion-bookmarks" aria-label="Saved viewpoints"></select><button id="companion-restore">Go to viewpoint</button><button id="companion-delete">Delete viewpoint</button></details>
    <p id="companion-action" role="status"></p><p id="companion-state" role="status">Camera controls affect desktop only. Room edits are shared.</p>`;
  document.body.append(panel);
  const q = <T extends HTMLElement>(id: string) => panel.querySelector<T>('#' + id)!;
  const select = q<HTMLSelectElement>('companion-vision');
  Object.entries(PROFILES).forEach(([id, label]) => select.add(new Option(label, id)));
  q<HTMLSelectElement>('companion-mode').onchange = e => setMode((e.target as HTMLSelectElement).value);
  q<HTMLInputElement>('companion-link').onchange = e => { linked = (e.target as HTMLInputElement).checked; select.disabled = linked; };
  select.disabled = true; select.onchange = () => localVision = select.value as Profile;
  q<HTMLInputElement>('companion-overlays').onchange = e => localOverlays = (e.target as HTMLInputElement).checked;
  q('companion-save').onclick = () => { game.bookmarks.save('Desktop viewpoint', { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() }); q('companion-state').textContent = 'Viewpoint saved for this scan.'; };
  q('companion-demo').onclick = () => document.body.classList.toggle('companion-demo');
  // Stray presses in the headset (vision, night, who is walking, the safer room, Fly...) undone in one click from the laptop.
  q('companion-reset').onclick = () => void Promise.resolve(game.resetVR?.()).then(() => q('companion-action').textContent = 'Headset reset to how VR started.', error => q('companion-action').textContent = String(error));
  q('companion-exit').onclick = () => void renderer.xr.getSession()?.end();
  // Recording or a projector: only the picture, no desktop controls; Esc brings them back.
  q('companion-clean').onclick = () => document.body.classList.add('companion-clean');
  onDocument('keydown', e => { if (e.code === 'Escape') document.body.classList.remove('companion-clean'); });
  q<HTMLInputElement>('companion-steady').onchange = e => { steady = (e.target as HTMLInputElement).checked; held = null; };
  q('companion-full').onclick = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen().catch(() => {}); };
  const objects = q<HTMLSelectElement>('companion-object');
  game.items.forEach((name: string) => objects.add(new Option(name.replaceAll('_', ' '), name)));
  function readObject() {
    const k = game.items.indexOf(objects.value), pose = game.layout().poses[k]; if (!pose) return;
    q<HTMLInputElement>('companion-x').value = pose.x.toFixed(2); q<HTMLInputElement>('companion-y').value = pose.y.toFixed(2); q<HTMLInputElement>('companion-yaw').value = String(Math.round(pose.yaw * 180 / Math.PI));
    game.select(objects.value);
  }
  objects.onchange = readObject;
  async function action(task: () => unknown) { try { const result: any = await task(); if (result?.ok === false) throw Error('Move refused: check filmed floor and object clearance.'); q('companion-action').textContent = 'Shared room updated.'; } catch (error) { q('companion-action').textContent = String(error); } }
  q('companion-move').onclick = () => void action(() => {
    const x = Number(q<HTMLInputElement>('companion-x').value), y = Number(q<HTMLInputElement>('companion-y').value), yaw = Number(q<HTMLInputElement>('companion-yaw').value);
    if (![x, y, yaw].every(Number.isFinite)) throw Error('Enter finite coordinates.');
    return game.sharedEdit(objects.value, () => game.moveObject(objects.value, x, y, yaw));
  });
  q('companion-remove').onclick = () => void action(() => game.sharedEdit(objects.value, () => game.removeObject(objects.value)));
  q('companion-undo').onclick = () => void action(() => game.history.undo()); q('companion-redo').onclick = () => void action(() => game.history.redo());
  const plans = q<HTMLSelectElement>('companion-plan');
  q('companion-proposals').onclick = () => void action(async () => {
    q('companion-action').textContent = 'Preparing layouts; the shared room stays as it is…';
    const options = await game.suggest(); plans.replaceChildren(); options.forEach((o: any, i: number) => plans.add(new Option(`${o.name}: ${o.actions.length} changes`, String(i))));
    q('companion-action').textContent = options.length ? 'Layouts prepared. Apply when ready.' : 'No layout options found.';
  });
  q('companion-apply').onclick = () => void action(async () => {
    if (!plans.options.length) throw Error('Prepare a layout first.');
    await game.editLocks.run('*', 'desktop', () => game.applyPreparedOption(Number(plans.value)));
  });
  const bookmarks = q<HTMLSelectElement>('companion-bookmarks'); let bookmarkSignature = '';
  every(() => { const points = game.bookmarks?.list() ?? [], signature = JSON.stringify(points); if (signature !== bookmarkSignature) { bookmarkSignature = signature; bookmarks.replaceChildren(); points.forEach((p: any) => bookmarks.add(new Option(p.label, p.id))); } }, 500);
  q('companion-restore').onclick = () => { const point = game.bookmarks.list().find((p: any) => p.id === bookmarks.value); if (point) thisRestore(point); };
  const thisRestore = (point: { position: number[]; quaternion: number[] }) => { camera.position.fromArray(point.position); camera.quaternion.fromArray(point.quaternion); controls.target.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(2)); controls.update(); };
  q('companion-delete').onclick = () => game.bookmarks.remove(bookmarks.value);
  let down: { x: number; y: number } | null = null;
  onCanvas(renderer.domElement, 'pointerdown', e => { if ((renderer.xr.isPresenting || game.remoteSession) && controls.enabled && e.button === 0) down = { x: e.clientX, y: e.clientY }; });
  onWindow('pointerup', e => {
    if (!down) return; const distance = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null; if (distance > 4) return;
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, 1 - e.clientY / innerHeight * 2), camera);
    const hit = ray.intersectObjects(game.debug.items.filter((_: unknown, k: number) => !game.layout().poses[k].removed).map((i: any) => i.proxy))[0];
    if (hit) { const k = game.debug.items.findIndex((i: any) => i.proxy === hit.object); objects.value = game.items[k]; readObject(); }
  });
  function setMode(value: string) {
    mode = value === 'goggles' ? 'headset' : value;   // a saved preference from before Goggles was dropped
    controls.enabled = presenting && (mode === 'companion' || mode === 'split');
    document.body.classList.toggle('companion-headset', mode === 'headset');
    q<HTMLSelectElement>('companion-mode').value = mode; last = -Infinity; held = null;
  }
  const annotationDefaults = new Map<string, { disabled: boolean; title: string }>(); let wasRemote = false;
  every(() => {
    const next = renderer.xr.isPresenting || !!game.remoteSession;
    if (next !== presenting) { presenting = next; panel.hidden = !next; desktop.hidden = !next; document.body.classList.toggle('companion-active', next); setMode(mode); }
    if (!!game.remoteSession !== wasRemote) {
      for (const id of ['markstairs', 'markdoor', 'editstairs', 'editdoors']) { const button = document.getElementById(id) as HTMLButtonElement; if (!button) continue; if (game.remoteSession) { annotationDefaults.set(id, { disabled: button.disabled, title: button.title }); button.disabled = true; button.title = 'Mark from the host/headset, or disconnect to annotate this device locally.'; } else { const saved = annotationDefaults.get(id); if (saved) { button.disabled = saved.disabled; button.title = saved.title; } } }
      wasRemote = !!game.remoteSession;
    }
    const shared = (document.getElementById('vision') as HTMLSelectElement)?.value;
    if (linked && shared) select.value = shared;
    q('companion-state').textContent = game.sessionBusy ? 'Loading room…' : game.pending() ? 'Results updating for the shared layout…' : 'Desktop camera is independent. Room edits are shared.';
  }, 250);
  onWindow('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); vision.resize(); });
  // Keep typing in operator controls out of movement shortcuts.
  panel.addEventListener('keydown', e => e.stopPropagation());
  onDocument('keydown', e => { if (renderer.xr.isPresenting && (e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !(e.target as HTMLElement).closest('input,textarea,select')) { e.preventDefault(); void game.history[e.shiftKey ? 'redo' : 'undo'](); } });
  const marker = new THREE.Mesh(new THREE.ConeGeometry(.12, .35, 12), new THREE.MeshBasicMaterial({ color: 0x49d4c7 })); marker.name = 'companion-head-position'; marker.visible = false; scene.add(marker);
  const desktop = document.createElement('canvas'); desktop.id = 'companion-canvas'; desktop.hidden = true; document.body.append(desktop);
  const output = new THREE.WebGLRenderTarget(1, 1); let inFlight = false;
  const inset = document.createElement('canvas'); inset.id = 'headset-preview'; inset.width = 480; inset.height = 270; inset.hidden = true; document.body.append(inset);
  function renderCamera(cam: THREE.PerspectiveCamera, applyVision: Profile) {
    vision.set(applyVision);
    if (cam === camera) vision.renderTo(output); else { renderer.setRenderTarget(output); renderer.render(scene, cam); }
  }
  own(() => { controls.dispose(); vision.dispose(); output.dispose(); desktop.remove(); panel.remove(); inset.remove(); marker.removeFromParent(); marker.geometry.dispose(); (marker.material as THREE.Material).dispose(); document.body.classList.remove('companion-active', 'companion-headset', 'companion-demo', 'companion-clean'); });
  return {
    focus(p: { x: number; y: number; z: number; yaw: number; pitch: number }) { camera.position.set(p.x, p.y, p.z); controls.target.copy(camera.position).add(new THREE.Vector3(Math.cos(p.yaw) * Math.cos(p.pitch), Math.sin(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch))); controls.update(); },
    camera, controls, mode: () => mode, setMode,
    capture() { return { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() }; },
    restore(point: { position: number[]; quaternion: number[] }) { camera.position.fromArray(point.position); camera.quaternion.fromArray(point.quaternion); controls.target.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(2)); controls.update(); },
    frame(now: number) {
      if (now - last < 50 || game.sessionBusy || inFlight) return; last = now;
      const width = Math.min(1280, innerWidth), height = Math.round(width * innerHeight / innerWidth);
      if (output.width !== width || output.height !== height) { output.setSize(width, height); desktop.width = width; desktop.height = height; }
      const capture = (canvas: HTMLCanvasElement) => { const data = new Uint8Array(width * height * 4); return renderer.readRenderTargetPixelsAsync(output, 0, 0, width, height, data).then(() => { if (!canvas.isConnected) return; canvas.width = width; canvas.height = height; canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data.buffer), width, height), 0, 0); }); };
      const captures: Promise<void>[] = [];
      const target = renderer.getRenderTarget(), xrEnabled = renderer.xr.enabled, viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
      const saved: [THREE.Object3D, boolean][] = [];
      const hide = (o?: THREE.Object3D) => { if (o) { saved.push([o, o.visible]); o.visible = false; } };
      const head = game.remoteHead?.position ? new THREE.Vector3().fromArray(game.remoteHead.position) : D.head.getWorldPosition(new THREE.Vector3()), rotation = game.remoteHead?.quaternion ? new THREE.Quaternion().fromArray(game.remoteHead.quaternion) : D.head.getWorldQuaternion(new THREE.Quaternion());
      const selected = (document.getElementById('vision') as HTMLSelectElement)?.value as Profile ?? 'normal';
      if (steady && mode !== 'companion') {
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rotation);
        if (!held || held.at.distanceTo(head) > 1.5) held = { at: head.clone(), fwd, t: now };   // a teleport or a Fly jump cuts, it doesn't glide
        else { const dt = Math.min(.5, (now - held.t) / 1000); held.t = now; held.at.lerp(head, 1 - Math.exp(-dt / .12)); held.fwd.lerp(fwd, 1 - Math.exp(-dt / .3)).normalize(); }
        head.copy(held.at); rotation.setFromRotationMatrix(level.lookAt(ORIGIN, held.fwd, UP));
      }
      try {
        renderer.xr.enabled = false; renderer.setRenderTarget(null); renderer.setViewport(0, 0, innerWidth, innerHeight); renderer.setScissorTest(false);
        if (mode === 'headset' || mode === 'split') {
          // A mono perspective at the tracked head pose, with the same illustrative vision profile.
          const previous = this.capture(); camera.position.copy(head); camera.quaternion.copy(rotation); camera.updateMatrixWorld(true);
          renderCamera(camera, linked ? selected : localVision);
          if (mode === 'split') captures.push(capture(inset)); else captures.push(capture(desktop));
          this.restore(previous);
        }
        inset.hidden = mode !== 'split';
        if (mode === 'companion' || mode === 'split') {
          hide(scene.getObjectByName('frontend-xr-menu')); hide(scene.getObjectByName('frontend-xr-inspection')); hide(scene.getObjectByName('xr-story-menu')); hide(game.debug.rig);
          if (!localOverlays) for (const o of game.debug.overlays) hide(o);
          marker.position.copy(head); marker.position.z += .25; marker.visible = true;
          controls.update(); renderCamera(camera, linked ? selected : localVision); captures.push(capture(desktop)); marker.visible = false;
        }
        inFlight = true; void Promise.all(captures).catch(error => console.warn('Companion capture', error)).finally(() => inFlight = false);
      } finally { saved.forEach(([o, visible]) => o.visible = visible); renderer.xr.enabled = xrEnabled; renderer.setRenderTarget(target); renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest); }
    },
  };
}
