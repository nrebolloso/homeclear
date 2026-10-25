import './frame.ts';
import * as THREE from 'three';
import { mountViewer } from './main.ts';
import { Lifetime, useLifetime } from './lifetime.ts';
import { groupScans, validScanId, type ScanEntry } from './scan-catalog.ts';
import './scan-library.css';

// The renderer, entry button and XR session survive scene teardown.
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
const template = [...document.body.children].filter(e => e.tagName !== 'SCRIPT').map(e => e.outerHTML).join('');
const stage = document.createElement('div'); stage.id = 'viewer-stage';
for (const node of [...document.body.children]) if (node.tagName !== 'SCRIPT') node.remove();
document.body.append(stage);
const toolbar = document.createElement('div'); toolbar.id = 'scan-library';
toolbar.innerHTML = `<button id="scan-picker" aria-expanded="false" aria-controls="scan-gallery">Scans <span id="scan-current"></span> ▾</button>
  <section id="scan-gallery" aria-label="Scan library" hidden><div class="scan-heading"><h2>Explore scans</h2><button id="scan-close" aria-label="Close scan library">×</button></div><p>Real rooms, scan versions, and labeled sample scenes.</p><div id="scan-rooms"></div><p id="scan-message" role="status"></p></section>
  <div id="scan-loading" role="status" hidden></div>`;
document.body.append(toolbar);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const saved = new Map<string, any>();
let catalog: ScanEntry[] = [], current = new URLSearchParams(location.search).get('scene') ?? 'kitchen4_lighter';
let scope: Lifetime | undefined, game: any, busy = false;
const thumbnails = new Map<string, string>();
function message(text: string) { $('scan-message').textContent = text; }
function gallery(open: boolean) { $('scan-gallery').hidden = !open; $('scan-picker').setAttribute('aria-expanded', String(open)); if (open) $('scan-close').focus(); }
$('scan-picker').onclick = () => gallery(Boolean($('scan-gallery').hidden));
$('scan-close').onclick = () => { gallery(false); $('scan-picker').focus(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('scan-gallery').hidden) { gallery(false); $('scan-picker').focus(); } });
function drawCatalog() {
  $('scan-rooms').replaceChildren();
  for (const group of groupScans(catalog)) {
    const section = document.createElement('section'), heading = document.createElement('h3'); heading.textContent = group.room; section.append(heading);
    for (const entry of group.scans) {
      const button = document.createElement('button'); button.className = 'scan-card'; button.disabled = busy;
      button.setAttribute('aria-pressed', String(entry.id === current));
      if (thumbnails.has(entry.id)) { const image = document.createElement('img'); image.src = thumbnails.get(entry.id)!; image.alt = `${entry.title} saved viewpoint`; button.append(image); }
      const title = document.createElement('strong'); title.textContent = entry.sample ? entry.title : entry.version;
      const capabilities = document.createElement('small'); capabilities.textContent = [entry.sample ? 'Synthetic / sample' : 'Real scan', 'Explore', entry.routes ? 'Routes' : '', entry.objects ? `${entry.objects} objects` : 'No object edits', entry.fixes ? 'Configured fixes' : '', `${Math.round(entry.bytes / 1048576)} MB`].filter(Boolean).join(' · ');
      button.append(title, capabilities); button.title = entry.scaleNote;
      button.onclick = () => void switchScan(entry.id); section.append(button);
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
  game.scanLibrary = library;
  current = id; drawCatalog();
  // Save a real rendered thumbnail, never a generated room image.
  requestAnimationFrame(() => { if (!renderer.xr.isPresenting && current === id) { try { const thumb = document.createElement('canvas'); thumb.width = 240; thumb.height = 150; thumb.getContext('2d')!.drawImage(renderer.domElement, 0, 0, 240, 150); thumbnails.set(id, thumb.toDataURL()); } catch { /* preview is optional */ } } });
}
async function switchScan(id: string, resume = true) {
  if (busy || id === current && game?.ready && resume) return false;
  busy = true; drawCatalog(); gallery(false); message('');
  const previous = current;
  $('scan-loading').hidden = false; $('scan-loading').textContent = `Loading ${catalog.find(e => e.id === id)?.title ?? id}…`;
  let disposed = false;
  try {
    await preflight(id);
    if (game) {
      game.sessionBusy = true;
      const start = performance.now();
      while (game.pending()) { if (performance.now() - start > 60000) throw Error('Room is still calculating. Try again after it finishes.'); await new Promise(r => setTimeout(r, 50)); }
      saved.set(current, game.saveSession());
    }
    scope?.dispose(); disposed = true;
    await mount(id, resume); return true;
  } catch (error) {
    if (disposed && game) { scope?.dispose(); try { await mount(previous, true); } catch (recovery) { console.error('Room recovery failed', recovery); } }
    message(String(error)); gallery(true); return false;
  } finally {
    busy = false; if (game) game.sessionBusy = false; $('scan-loading').hidden = true; drawCatalog();
  }
}
const library = { entries: () => catalog, current: () => current, busy: () => busy, switch: switchScan, open: () => gallery(true), restart: () => switchScan(current, false) };
(window as any).scanLibrary = library;
try {
  const response = await fetch('scan-catalog.json'); if (response.ok) catalog = await response.json();
  await switchScan(current);
} catch (error) { message(String(error)); gallery(true); }
