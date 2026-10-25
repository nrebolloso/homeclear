// Night mode as a Spark world modifier on every splat: scale colour down, add a warm falloff around the nightlight, and
// around each extra light (motion step lights on the stairs: the scan itself lights up, no glow geometry). Visual only:
// the risk numbers use the simulation's dark multiplier, not these pixels. Changing lights needs splat.updateVersion().
import * as THREE from 'three';
import { dyno } from '@sparkjsdev/spark';

const { dynoBlock, Gsplat, splitGsplat, combineGsplat, dynoFloat, dynoVec3, dynoConst, mul, add, sub, mix, smoothstep, distance, split } = dyno;
export const MAX_EXTRA_LIGHTS = 16;   // step lights (one per tread) and path lights (lights.ts) share these
export interface PointLight { x: number; y: number; z: number; r: number }

export function nightShader() {
  const night = dynoFloat(0), lightOn = dynoFloat(0), radius = dynoFloat(1.5), reach = dynoFloat(0);
  const light = dynoVec3(new THREE.Vector3());
  const extra = Array.from({ length: MAX_EXTRA_LIGHTS }, () => ({ on: dynoFloat(0), r: dynoFloat(0.6), at: dynoVec3(new THREE.Vector3()) }));
  const modifier = dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
    const { center, rgb } = splitGsplat(gsplat!).outputs;
    const one = dynoConst('float', 1), zero = dynoConst('float', 0), color = dynoConst('vec3', new THREE.Vector3(1.1, 0.75, 0.4));
    const falloff = (at: typeof light, r: typeof radius) => { const near = sub(one, smoothstep(zero, r, distance(center, at))); return mul(near, near); };
    let glow = mul(lightOn, falloff(light, radius));
    for (const L of extra) glow = add(glow, mul(L.on, falloff(L.at, L.r)));
    const warm = mul(color, mul(glow, night));
    const gain = add(warm, mix(one, dynoConst('float', 0.07), night));
    const lit = mul(rgb, gain);
    // reach lens (wheelchair): 38-122 cm up, what a seated person reaches (ADA 308), green; above or below it, red; the
    // floor itself untinted. Visual only, like the night: the reach checks use the fixtures' measured heights.
    const z = split(center).outputs.z, f = (v: number) => dynoConst('float', v);
    const band = mul(smoothstep(f(0.33), f(0.43), z), sub(one, smoothstep(f(1.17), f(1.27), z)));
    const tint = add(mul(dynoConst('vec3', new THREE.Vector3(1.35, 0.55, 0.5)), sub(one, band)), mul(dynoConst('vec3', new THREE.Vector3(0.6, 1.3, 0.65)), band));
    const k = mul(mul(reach, smoothstep(f(0.02), f(0.08), z)), f(0.45));   // strong enough to read, light enough to still see the scan
    return { gsplat: combineGsplat({ gsplat: gsplat!, rgb: add(mul(lit, sub(one, k)), mul(mul(lit, tint), k)) }) };
  });
  const set = (on: boolean, l: { x: number; y: number; r: number } | null, lights: PointLight[] = []) => {
    night.value = on ? 1 : 0;
    lightOn.value = l ? 1 : 0;
    if (l) { light.value.set(l.x, l.y, 0.15); radius.value = l.r; }
    extra.forEach((L, k) => {
      const p = lights[k];
      L.on.value = p ? 1 : 0;
      if (p) { L.at.value.set(p.x, p.y, p.z); L.r.value = p.r; }
    });
  };
  /** the reach lens on or off (main.ts: with the wheelchair persona); needs splat.updateVersion() like the lights */
  const setReach = (on: boolean) => { reach.value = on ? 1 : 0; };
  return { modifier, set, setReach };
}
