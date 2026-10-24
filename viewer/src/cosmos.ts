// Cosmos Transfer, precomputed: play finished clips with measured-hazard overlays, and export the current layout as a job.
import * as THREE from 'three';
import { projectCV } from './frame.ts';
import { rankClips } from './prerender.ts';

const $ = (id: string) => document.getElementById(id)!;
export const FPS = 16, W = 1280, H = 720, F = 900, CHUNK = 93;   // same camera as cosmos/render_route.py
const K = [[F, 0, W / 2], [0, F, H / 2], [0, 0, 1]];

// ---------- clip player ----------
let clips: any[] = [];
export async function initClips() {
  clips = await fetch('/api/clips').then(r => r.json()).catch(() => []);
  listClips('original', '');
  (window as any).game && Object.assign((window as any).game, { clips, openClip });
}

/** Re-list the clips for the layout on screen: pre-rendered for exactly this layout + route first ("this layout"),
 *  the rest marked as other pre-rendered scenarios. Called after every re-plan. */
export function listClips(key: string, route: string) {
  $('clips').innerHTML = clips.length ? '' : '<li>none yet (cosmos/prerender.py or Export below, then cosmos/fetch_cosmos.sh)</li>';
  for (const c of rankClips(clips, key, route)) {
    const li = document.createElement('li'), b = document.createElement('button');
    b.textContent = '▶';
    b.onclick = () => openClip(c);
    const tag = c.exact ? '<span class="delta-good">this layout</span>' : '<span class="dim">other scenario</span>';
    li.append(b);
    li.insertAdjacentHTML('beforeend', ` ${tag} ${c.title ?? c.file}${c.condition ? ` · ${c.condition}` : ''}${c.mode === 'hero' ? ' · hero' : ''} · ${c.layout ?? ''}`);
    li.title = c.prompt ?? '';
    $('clips').appendChild(li);
  }
  return rankClips(clips, key, route).filter(c => c.exact).length;
}

export function openClip(c: any) {
  const video = $('video') as HTMLVideoElement, cv = $('overlay') as HTMLCanvasElement;
  $('player').hidden = false;
  video.src = `clips/${c.file}`;
  const draw = (mediaTime: number) => {
    const f = Math.min(c.cameras.length - 1, Math.max(0, Math.floor(mediaTime * c.fps + 0.01)));   // frame k spans [k/fps, (k+1)/fps)
    const r = video.getBoundingClientRect();
    cv.width = r.width; cv.height = r.height;
    const s = Math.min(r.width / c.width, r.height / c.height), ox = (r.width - c.width * s) / 2, oy = (r.height - c.height * s) / 2;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.lineWidth = 3; ctx.font = '600 13px system-ui';
    const drawn: any[] = [];
    for (const h of c.hazards ?? []) {
      const p = projectCV(c.cameras[f], c.K, h.position);
      if (!p || p[0] < 0 || p[1] < 0 || p[0] > c.width || p[1] > c.height) continue;
      const x = ox + p[0] * s, y = oy + p[1] * s;
      ctx.strokeStyle = ctx.fillStyle = h.type === 'floor_bump' ? '#ff8a1f' : '#ffe14d';
      ctx.beginPath(); ctx.arc(x, y, 14, 0, 7); ctx.stroke();
      ctx.fillText(`${h.label} (measured)`, x + 18, y + 4);
      drawn.push({ x: p[0], y: p[1], label: h.label });
    }
    (window as any).game && ((window as any).game.overlay = { frame: f, markers: drawn });
  };
  const tick = (_: number, m: { mediaTime: number }) => { draw(m.mediaTime); video.requestVideoFrameCallback(tick); };
  video.requestVideoFrameCallback(tick);
  video.onseeked = () => draw(video.currentTime);
  $('closeplayer').onclick = () => { video.pause(); $('player').hidden = true; };
  video.play().catch(() => {});
  return video;
}

// ---------- export ----------
const depthMat = new THREE.ShaderMaterial({   // view-space depth in mm, 24-bit in RGB (0 = no walker)
  vertexShader: 'varying float vz; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vz = -mv.z; gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'varying float vz; void main(){ float mm = floor(vz * 1000.0 + 0.5);' +
    ' gl_FragColor = vec4(floor(mm / 65536.0), mod(floor(mm / 256.0), 256.0), mod(mm, 256.0), 255.0) / 255.0; }',
});

export interface ExportOpts {
  /** one 93-frame chunk around the riskiest hazard on the route (~5 min of B200) instead of the whole route */
  hero?: boolean; condition?: string; scenario?: string; prompt?: string;
}

/** Where the hero chunk goes: the stretch of route centred on the hazard with the most contacts (else the tightest
 *  squeeze), one chunk long at walking pace, clamped to the route. */
export function heroWindow(cur: any, routeS: number[]): [number, number] {
  const Ls = routeS.at(-1)!, len = Math.min(Ls, ((CHUNK - 1) / FPS) * 0.45);
  const hz = [...cur.hazards].sort((a: any, b: any) => (b.per_month - a.per_month) || ((a.min_side_clearance_m ?? 1) - (b.min_side_clearance_m ?? 1)))[0];
  const mid = hz ? routeS[Math.floor((hz.a + hz.b) / 2)] ?? Ls / 2 : Ls / 2;
  const s0 = Math.max(0, Math.min(Ls - len, mid - len / 2));
  return [s0, s0 + len];
}

export async function exportForCosmos(ctx: any, opts: ExportOpts = {}) {
  const cur = ctx.current(), st = $('exportstatus');
  if (!cur || cur.error) { st.textContent = 'no route to export'; return; }
  const job = `${ctx.RUN}_${opts.hero ? 'hero_' : ''}${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
  const [s0, s1] = opts.hero ? heroWindow(cur, ctx.routeS()) : [0, ctx.routeS().at(-1)];
  const Ls = s1 - s0, n = opts.hero ? CHUNK : Math.max(1, Math.round(((Ls / 0.45) * FPS + 1) / CHUNK)) * CHUNK;   // pace snapped to whole chunks: unsnapped, 95 frames would pad into a 2nd chunk of standing still
  const cam = new THREE.PerspectiveCamera((2 * Math.atan(H / 2 / F) * 180) / Math.PI, W / H, 0.05, 60);
  const poses: any[] = [];
  let yaw = 0;
  for (let k = 0; k < n; k++) {
    const p = ctx.routePose(s0 + (Ls * k) / (n - 1), yaw, k ? 1 / FPS : Infinity);
    yaw = p.yaw;
    poses.push({ ...p, pitch: (-35 * Math.PI) / 180 });   // this frame is 44 deg tall (viewer: 70): below ~35 deg down the walker falls out of it
  }
  while (poses.length % CHUNK) poses.push(poses.at(-1));   // hold the last view to fill the final 93-frame chunk
  // walker-only depth, rendered along the same path; the splat itself is rendered by cosmos/render_controls.py
  const wscene = new THREE.Scene(), wclone = ctx.walkerGroup.clone(true);
  wclone.traverse((m: any) => { if (m.isMesh) m.material = depthMat; });
  wscene.add(wclone);
  const rt = new THREE.WebGLRenderTarget(W, H), buf = new Uint8Array(W * H * 4), r: THREE.WebGLRenderer = ctx.renderer;
  const cv = new OffscreenCanvas(W, H), c2 = cv.getContext('2d')!, img = c2.createImageData(W, H);
  let walkerPx = 0;
  const cameras: number[][][] = [], prevClear = r.getClearAlpha(), prevColor = r.getClearColor(new THREE.Color());
  r.setClearColor(0x000000, 1);
  for (let k = 0; k < poses.length; k++) {
    const p = poses[k];
    wclone.position.set(p.x, p.y, 0); wclone.rotation.z = p.yaw;
    ctx.placeCamera(cam, p);
    cameras.push(ctx.cameraToW2C(cam));
    r.setRenderTarget(rt); r.clear(); r.render(wscene, cam); r.readRenderTargetPixels(rt, 0, 0, W, H, buf); r.setRenderTarget(null);
    if (!k) for (let i = 0; i < buf.length; i += 4) walkerPx += +(buf[i] + buf[i + 1] + buf[i + 2] > 0) / (W * H);
    for (let y = 0; y < H; y++) img.data.set(buf.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);   // GL rows are bottom-up
    c2.putImageData(img, 0, 0);
    await post(job, `walker/${String(k).padStart(6, '0')}.png`, await cv.convertToBlob({ type: 'image/png' }));
    st.textContent = `walker depth ${k + 1}/${poses.length}`;
  }
  r.setClearColor(prevColor, prevClear);
  rt.dispose();
  const L = ctx.layout(), nl = ctx.objs.findIndex((o: any) => o.kind === 'nightlight');
  const spec = {
    job, scene: ctx.RUN, created: new Date().toISOString(), label: 'imagined, not measured',
    fps: FPS, width: W, height: H, K, chunk_frames: CHUNK, route_frames: n, cameras,
    chunks: Array.from({ length: poses.length / CHUNK }, (_, i) => [i * CHUNK, (i + 1) * CHUNK]),
    camera_convention: 'OpenCV world-to-camera in the floor frame (metres, z up)',
    objects: ctx.objs.map((o: any, k: number) => ({ name: o.name, kind: o.kind, x: L.poses[k].x, y: L.poses[k].y,
      yaw_deg: (L.poses[k].yaw * 180) / Math.PI, removed: !!L.poses[k].removed,
      moved: Math.hypot(L.poses[k].x - o.pivot[0], L.poses[k].y - o.pivot[1]) > 0.01 || Math.abs(L.poses[k].yaw) > 0.01 })),
    flattened: L.flattened, fixes_applied: ctx.applied(), night: ctx.night(),
    nightlight: nl >= 0 && !L.poses[nl].removed ? { x: L.poses[nl].x, y: L.poses[nl].y, r: ctx.objs[nl].light_radius_m } : null,
    prompt: opts.prompt ?? ($('prompt') as HTMLTextAreaElement).value,
    // pre-render bookkeeping: which layout / route / condition this clip is for (viewer matches clips by layout_key)
    layout_key: ctx.layoutKey(), route: ctx.routeName(), condition: opts.condition ?? (ctx.night() ? 'night' : 'day'),
    mode: opts.hero ? 'hero' : 'full', scenario: opts.scenario ?? null, route_s: [s0, s1],
    walker: { depth_frames: 'walker/%06d.png', encoding: 'depth mm = R*65536 + G*256 + B along the camera axis; 0 = no walker (mask)' },
    hazards: cur.hazards.map((h: any) => ({ type: h.type, position: [h.position[0], h.position[1], h.position[2] ?? 0],
      label: h.type === 'floor_bump' ? `${h.name} ${(h.height_m * 100).toFixed(1)} cm` : `${(h.min_side_clearance_m * 100).toFixed(0)} cm/side` })),
    per_month: cur.per_month,
  };
  await post(job, 'cosmos_job.json', new Blob([JSON.stringify(spec)]));
  st.textContent = `exported viewer/public/exports/${job}/ (${poses.length} frames, ${spec.chunks.length} chunks) → cosmos/submit_cosmos.sh ${job}`;
  (window as any).game.lastExport = { job, frames: poses.length, chunks: spec.chunks.length, walkerPx };
  return job;
}
const post = (job: string, file: string, body: Blob) =>
  fetch(`/api/export/${job}/${file}`, { method: 'POST', body }).then(r => { if (!r.ok) throw new Error(`export ${file}: ${r.status}`); });
