import './frame.ts';
import * as THREE from 'three';
import { mountViewer } from './main.ts';
import { Lifetime, useLifetime } from './lifetime.ts';
import { groupScans, validScanId, type ScanEntry } from './scan-catalog.ts';
import './scan-library.css';
import { createSessionLink } from './session-link.ts';

// The renderer, entry button and XR session survive scene teardown.
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
const template = [...document.body.children].filter(e => e.tagName !== 'SCRIPT').map(e => e.outerHTML).join('');
const stage = document.createElement('div'); stage.id = 'viewer-stage';
for (const node of [...document.body.children]) if (node.tagName !== 'SCRIPT') node.remove();
document.body.append(stage);
const toolbar = document.createElement('div'); toolbar.id = 'scan-library';
toolbar.innerHTML = `<button id="scan-picker" aria-expanded="false" aria-controls="scan-gallery">Scans <span id="scan-current"></span> ▾</button>
  <section id="scan-gallery" aria-label="Scan library" hidden><div class="scan-heading"><h2>Explore scans</h2><button id="scan-close" aria-label="Close scan library">×</button></div><p>Real rooms, scan versions, and labeled sample scenes.</p><div class="scan-actions"><button id="scan-resume">Resume current room</button><button id="scan-restart">Restart demo</button></div><div id="scan-rooms"></div><details><summary>Connect another device</summary><p>Open this viewer on the laptop and headset. Use the same session name; choose Host on the headset and Companion on the laptop.</p><label>Session <input id="session-code" maxlength="48" placeholder="home-demo"></label><label>Role <select id="session-role"><option value="host">Host / headset</option><option value="companion">Companion / laptop</option></select></label><button id="session-connect">Connect</button><button id="session-disconnect">Disconnect</button><p id="session-status" role="status">Local viewer</p></details><p id="scan-message" role="status"></p></section>
  <div id="scan-loading" role="status" hidden></div>`;
document.body.append(toolbar);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const saved = new Map<string, any>();
let catalog: ScanEntry[] = [], current = new URLSearchParams(location.search).get('scene') ?? 'kitchen4_lighter';
let scope: Lifetime | undefined, game: any, busy = false;
const thumbnails = new Map<string, string>();
const loadingScene = new THREE.Scene(), loadingCamera = new THREE.PerspectiveCamera();
const loadingCanvas = document.createElement('canvas'); loadingCanvas.width = 1024; loadingCanvas.height = 1024;
const loadingTexture = new THREE.CanvasTexture(loadingCanvas); loadingTexture.colorSpace = THREE.SRGBColorSpace;
const loadingMaterial = new THREE.ShaderMaterial({ uniforms: { map: { value: loadingTexture } }, depthTest: false, depthWrite: false,
  vertexShader: 'varying vec2 uvOut; void main() { uvOut=uv; gl_Position=vec4(position.xy,0.0,1.0); }',
  fragmentShader: 'uniform sampler2D map; varying vec2 uvOut; void main() { gl_FragColor=texture2D(map,uvOut); }' });
const loadingPlane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), loadingMaterial); loadingPlane.frustumCulled = false; loadingScene.add(loadingPlane);
function showHeadsetLoading(id: string) {
  if (!renderer.xr.isPresenting) return;
  const ctx = loadingCanvas.getContext('2d')!; ctx.fillStyle = '#10202b'; ctx.fillRect(0, 0, 1024, 1024);
  ctx.fillStyle = '#bafff4'; ctx.font = '600 44px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Loading room', 512, 450);
  ctx.fillStyle = '#dbe6ed'; ctx.font = '30px system-ui'; ctx.fillText(catalog.find(e => e.id === id)?.title ?? id, 512, 520); loadingTexture.needsUpdate = true;
  renderer.setAnimationLoop(() => renderer.render(loadingScene, loadingCamera));
}

function message(text: string) { $('scan-message').textContent = text; }
function gallery(open: boolean) { $('scan-gallery').hidden = !open; $('scan-picker').setAttribute('aria-expanded', String(open)); if (open) $('scan-close').focus(); }
$('scan-picker').onclick = () => gallery(Boolean($('scan-gallery').hidden));
$('scan-resume').onclick = () => gallery(false);
$('scan-restart').onclick = () => void switchScan(current, false);
$('scan-close').onclick = () => { gallery(false); $('scan-picker').focus(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('scan-gallery').hidden) { gallery(false); $('scan-picker').focus(); } });
function drawCatalog() {
  $('scan-rooms').replaceChildren();
  function card(entry: ScanEntry, primary = false) {
    const button = document.createElement('button'); button.className = 'scan-card'; button.disabled = busy;
    button.setAttribute('aria-pressed', String(entry.id === current));
    if (primary && (thumbnails.has(entry.id) || entry.map)) {
      const image = document.createElement('img'); image.src = thumbnails.get(entry.id) ?? entry.map!;
      image.alt = thumbnails.has(entry.id) ? `${entry.title} saved viewpoint` : `${entry.title} floor map`; button.append(image);
    }
    const title = document.createElement('strong'); title.textContent = primary ? entry.title : entry.version;
    const capabilities = document.createElement('small'); capabilities.textContent = [primary ? entry.version : '', entry.sample ? 'Synthetic / sample' : 'Real scan', 'Explore', entry.routes ? 'Routes' : '', entry.objects ? `${entry.objects} objects` : 'No object edits', entry.fixes ? 'Configured fixes' : '', `${Math.round(entry.bytes / 1048576)} MB`].filter(Boolean).join(' · ');
    button.append(title, capabilities); button.title = entry.scaleNote; button.onclick = () => void switchScan(entry.id); return button;
  }
  for (const group of groupScans(catalog)) {
    const section = document.createElement('section'); section.className = 'scan-room';
    const preferred = group.scans.find(e => e.id === current) ?? group.scans.find(e => e.id === 'kitchen4_lighter_v1.0.3') ?? group.scans.at(-1)!;
    section.append(card(preferred, true));
    if (group.scans.length > 1) {
      const versions = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = `Other ${preferred.sample ? 'samples' : 'versions'} · ${group.scans.length - 1}`;
      versions.append(summary); for (const entry of group.scans) if (entry !== preferred) versions.append(card(entry)); section.append(versions);
    }
    $('scan-rooms').append(section);
  }
  $('scan-current').textContent = catalog.find(e => e.id === current)?.title ?? current;
}
async function preflight(id: string) {
  if (!validScanId(id)) throw Error('Invalid scan identity');
  const root = `scene/${id}/`, response = await fetch(root + 'scene.json');
  if (!response.ok) throw Error('Scene definition is unavailable');
  const sc = await response.json();
  const paths = [sc.splat, sc.walker, sc.persona, sc.route, sc.hazards, sc.grid?.floor, sc.grid?.obstacles, sc.grid?.bump_height_m, sc.grid?.coverage, sc.routes, sc.personas, ...((sc.objects ?? []).map((o: any) => o.splat))].filter(Boolean);
  await Promise.all(paths.map(async path => { const r = await fetch(root + path, { method: 'HEAD' }); if (!r.ok) throw Error(`Missing scan asset: ${path}`); }));
}
function restoreDOM() {
  renderer.domElement.remove(); stage.innerHTML = template;
  document.body.classList.remove('frontend', 'panel-collapsed', 'xr-active');
}
async function mount(id: string, resume: boolean) {
  const url = new URL(location.href); url.searchParams.set('scene', id); history.replaceState(null, '', url);
  restoreDOM(); scope = new Lifetime(); useLifetime(scope);
  const before = new Set(document.body.children);
  scope.own(() => { for (const node of [...document.body.children]) if (!before.has(node) && node !== toolbar && !node.hasAttribute('data-xr-persistent')) node.remove(); });
  game = await mountViewer({ renderer, scope });
  if (resume && saved.has(id)) await game.restoreSession(saved.get(id));
  if (renderer.xr.isPresenting) document.body.classList.add('xr-active');
  game.scanLibrary = library; sessionLink.attach(game);
  current = id; drawCatalog();
  // Save a real rendered thumbnail, never a generated room image.
  requestAnimationFrame(() => { if (!renderer.xr.isPresenting && current === id) { try { const thumb = document.createElement('canvas'); thumb.width = 240; thumb.height = 150; thumb.getContext('2d')!.drawImage(renderer.domElement, 0, 0, 240, 150); thumbnails.set(id, thumb.toDataURL()); } catch { /* preview is optional */ } } });
}
async function switchScan(id: string, resume = true, fromHost = false) {
  if (sessionLink.role() === 'companion' && !fromHost) return !!await sessionLink.request('scan', [id]);
  if (busy || id === current && game?.ready && resume) return false;
  busy = true; drawCatalog(); gallery(false); message('');
  const previous = current;
  $('scan-loading').hidden = false; $('scan-loading').textContent = `Loading ${catalog.find(e => e.id === id)?.title ?? id}…`;
  let disposed = false;
  const preferences = game ? { vision: (document.getElementById('vision') as HTMLSelectElement).value, night: (document.getElementById('night') as HTMLInputElement).checked, layers: game.layers.state(), movement: game.comfort.movement, seated: game.comfort.seated, display: game.companion.mode() } : null;
  try {
    await preflight(id);
    if (game) {
      game.sessionBusy = true;
      const start = performance.now();
      while (game.pending()) { if (performance.now() - start > 60000) throw Error('Room is still calculating. Try again after it finishes.'); await new Promise(r => setTimeout(r, 50)); }
      saved.set(current, game.saveSession());
      if (game.editLocks?.busy()) throw Error('Release the edited object before switching scans.');
    }
    scope?.dispose(); disposed = true; showHeadsetLoading(id);
    await mount(id, resume);
    if (preferences) {
      game.setVision(preferences.vision); game.setNight(preferences.night); game.comfort.movement = preferences.movement; game.comfort.seated = preferences.seated; game.companion.setMode(preferences.display);
      for (const [key, value] of Object.entries(preferences.layers)) { const control = document.getElementById(key) as HTMLInputElement & HTMLSelectElement; if (!control) continue; if (typeof value === 'boolean') control.checked = value; else control.value = String(value); control.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    return true;
  } catch (error) {
    if (disposed && game) { scope?.dispose(); try { await mount(previous, true); } catch (recovery) { console.error('Room recovery failed', recovery); } }
    message(String(error)); gallery(true); return false;
  } finally {
    busy = false; if (game) game.sessionBusy = false; $('scan-loading').hidden = true; drawCatalog();
  }
}
const library = { entries: () => catalog, current: () => current, busy: () => busy, switch: switchScan, open: () => gallery(true), restart: () => switchScan(current, false) };
(window as any).scanLibrary = library;
const sessionLink = createSessionLink({ game: () => game, scan: () => current, switchScan: id => switchScan(id, true, true), status: text => $('session-status').textContent = text });
(window as any).sessionLink = sessionLink;
$('session-connect').onclick = () => { try { sessionLink.connect($<HTMLInputElement>('session-code').value, $<HTMLSelectElement>('session-role').value); } catch (error) { $('session-status').textContent = String(error); } };
$('session-disconnect').onclick = () => sessionLink.disconnect();
try {
  const response = await fetch('scan-catalog.json'); if (response.ok) catalog = await response.json();
  await switchScan(current);
} catch (error) { message(String(error)); gallery(true); }
