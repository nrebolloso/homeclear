// How an addition looks. Proposed (a plan being previewed): a see-through teal "hologram" with a bright rim, a faint scan
// line, and a front that sweeps up the flight as the room morphs, so you can see the scan through it. Committed: solid,
// shaded teal (or baked into the scan as Gaussians, bake.ts). Scene materials only, so they show in the headset. Visual
// only: "designed, not built", nothing is measured from them.
import * as THREE from 'three';

export const DESIGNED = 0x2fd6c8;
export const DESIGNED_DARK = 0x0f4f4b;   // grips and seats: still teal, but the shape reads against the lighter frame

export interface Flight { origin: [number, number]; dir: [number, number]; run: number }
export type Hologram = THREE.ShaderMaterial & { uniforms: { uTime: { value: number }; uReveal: { value: number }; uAlpha: { value: number } } };

const VERT = /* glsl */`
varying vec3 vN; varying vec3 vP;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vP = wp.xyz; vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FRAG = /* glsl */`
uniform vec3 uColor; uniform float uTime, uReveal, uAlpha, uRun; uniform vec2 uOrigin, uDir;
varying vec3 vN; varying vec3 vP;
void main() {
  float s = dot(vP.xy - uOrigin, uDir);                              // how far up the flight this fragment is
  float front = mix(-0.4, uRun + 0.4, uReveal);
  float shown = uReveal >= 0.999 ? 1.0 : 1.0 - smoothstep(front - 0.02, front + 0.12, s);
  float glow = uReveal >= 0.999 ? 0.0 : exp(-abs(s - front) * 10.0);   // the sweeping front
  vec3 V = normalize(cameraPosition - vP);
  float rim = pow(1.0 - abs(dot(normalize(vN), V)), 2.0);
  float scan = 0.5 + 0.5 * sin(vP.z * 90.0 - uTime * 2.2);
  vec3 col = uColor * (0.62 + 0.75 * rim + 0.12 * scan) + glow * vec3(0.55, 0.95, 0.95);
  float a = (0.3 + 0.55 * rim + 0.05 * scan + 0.5 * glow) * shown * uAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, min(a, 1.0));
}`;

/** One hologram material for a flight (its sweep runs from the bottom step up the flight). */
export function hologram(flight: Flight, color = DESIGNED): Hologram {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uReveal: { value: 1 }, uAlpha: { value: 1 }, uRun: { value: flight.run },
      uOrigin: { value: new THREE.Vector2(...flight.origin) }, uDir: { value: new THREE.Vector2(...flight.dir) } },
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  }) as Hologram;
}

/** A committed, solid fixture: shaded (the room's env map lights it, ground.ts), not the flat unlit colour it used to be. */
export function solid(color = DESIGNED, rough = 0.5) {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: rough, transparent: true });
}

let glowTex: THREE.CanvasTexture | null = null;
/** A soft warm halo for a step light at night (additive, over the scan). */
export function glow(size = 0.5, color = 0xffe2a8) {
  if (!glowTex) {
    const n = 64, c = document.createElement('canvas'); c.width = c.height = n;
    const ctx = c.getContext('2d')!, g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    for (let k = 0; k <= 8; k++) g.addColorStop(k / 8, `rgba(255,255,255,${((1 - k / 8) ** 2.2).toFixed(3)})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, n, n);
    glowTex = new THREE.CanvasTexture(c);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false }));
  s.scale.set(size, size, 1);
  s.userData.glow = true;
  return s;
}

export const smooth01 = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
export const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
