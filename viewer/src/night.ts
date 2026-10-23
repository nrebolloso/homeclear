// Night mode as a Spark world modifier on every splat: scale colour down, add a warm falloff around the nightlight.
// Visual only: the risk numbers use the simulation's dark multiplier, not these pixels.
import * as THREE from 'three';
import { dyno } from '@sparkjsdev/spark';

const { dynoBlock, Gsplat, splitGsplat, combineGsplat, dynoFloat, dynoVec3, dynoConst, mul, add, sub, mix, smoothstep, distance } = dyno;

export function nightShader() {
  const night = dynoFloat(0), lightOn = dynoFloat(0), radius = dynoFloat(1.5);
  const light = dynoVec3(new THREE.Vector3());
  const modifier = dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
    const { center, rgb } = splitGsplat(gsplat!).outputs;
    const near = sub(dynoConst('float', 1), smoothstep(dynoConst('float', 0), radius, distance(center, light)));
    const warm = mul(dynoConst('vec3', new THREE.Vector3(1.1, 0.75, 0.4)), mul(mul(lightOn, night), mul(near, near)));
    const gain = add(warm, mix(dynoConst('float', 1), dynoConst('float', 0.07), night));
    return { gsplat: combineGsplat({ gsplat: gsplat!, rgb: mul(rgb, gain) }) };
  });
  const set = (on: boolean, l: { x: number; y: number; r: number } | null) => {
    night.value = on ? 1 : 0;
    lightOn.value = l ? 1 : 0;
    if (l) { light.value.set(l.x, l.y, 0.15); radius.value = l.r; }
  };
  return { modifier, set };
}
