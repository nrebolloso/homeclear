// Night mode as a Spark world modifier on every splat: scale colour down, add a warm falloff around the nightlight, and
// around each extra light (motion step lights on the stairs: the scan itself lights up, no glow geometry). Visual only:
// the risk numbers use the simulation's dark multiplier, not these pixels. Changing lights needs splat.updateVersion().
import * as THREE from 'three';
import { dyno } from '@sparkjsdev/spark';

const { dynoBlock, Gsplat, splitGsplat, combineGsplat, dynoFloat, dynoVec3, dynoConst, mul, add, sub, mix, smoothstep, distance } = dyno;
export const MAX_EXTRA_LIGHTS = 8;
export interface PointLight { x: number; y: number; z: number; r: number }

export function nightShader() {
  const night = dynoFloat(0), lightOn = dynoFloat(0), radius = dynoFloat(1.5);
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
    return { gsplat: combineGsplat({ gsplat: gsplat!, rgb: mul(rgb, gain) }) };
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
  return { modifier, set };
}
