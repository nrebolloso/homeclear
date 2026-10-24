// "See it as they do": a post-process pass over the finished frame for common age-related vision loss.
// Visual only, like night mode: nothing here feeds a number. Off (normal) = the plain render path, no extra pass.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const PROFILES = {
  normal: 'Normal vision',
  cataract: 'Cataract (blur, glare, yellowing)',
  macular: 'Macular degeneration (central loss)',
  glaucoma: 'Glaucoma (tunnel vision)',
  low_contrast: 'Low contrast (dim, aging eyes)',
} as const;
export type Profile = keyof typeof PROFILES;
const MODE: Record<Profile, number> = { normal: 0, cataract: 1, macular: 2, glaucoma: 3, low_contrast: 4 };

const VisionShader = {
  uniforms: { tDiffuse: { value: null }, mode: { value: 0 }, res: { value: new THREE.Vector2(1, 1) }, strength: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform int mode; uniform vec2 res; uniform float strength; varying vec2 vUv;
    // 12-tap disc blur, radius in pixels
    vec3 blur(vec2 uv, float r) {
      vec2 d[12]; d[0]=vec2(-.326,-.406); d[1]=vec2(-.840,-.074); d[2]=vec2(-.696,.457); d[3]=vec2(-.203,.621);
      d[4]=vec2(.962,-.195); d[5]=vec2(.473,-.480); d[6]=vec2(.519,.767); d[7]=vec2(.185,-.893);
      d[8]=vec2(.507,.064); d[9]=vec2(.896,.412); d[10]=vec2(-.322,-.933); d[11]=vec2(-.792,-.598);
      vec3 c = texture2D(tDiffuse, uv).rgb;
      for (int i = 0; i < 12; i++) c += texture2D(tDiffuse, uv + d[i] * r / res).rgb;
      return c / 13.0;
    }
    float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec2 p = (vUv - 0.5) * vec2(res.x / res.y, 1.0);   // aspect-corrected, centre = 0
      float r = length(p);
      if (mode == 1) {            // cataract: clouded lens scatters light (blur + glare), yellows, flattens contrast
        vec3 b = blur(vUv, 7.0 * strength), wide = blur(vUv, 22.0 * strength);
        c = mix(b, vec3(lum(b)), 0.15);
        c += 0.55 * strength * max(wide - 0.55, 0.0);    // halos around lamps and the nightlight
        c = mix(vec3(0.45), c, 1.0 - 0.35 * strength);
        c *= vec3(1.0, 0.93, 0.72);
      } else if (mode == 2) {     // macular degeneration: a blurred, darkened patch where you look
        float m = 1.0 - smoothstep(0.08, 0.22, r);
        vec3 b = blur(vUv, 18.0 * strength);
        c = mix(c, mix(b, vec3(lum(b) * 0.35), 0.6), m * strength);
      } else if (mode == 3) {     // glaucoma: the edges fade first; you see down a tunnel
        float m = smoothstep(0.18, 0.55, r);
        c = mix(c, blur(vUv, 10.0) * 0.12, m * strength);
      } else if (mode == 4) {     // low contrast: everything flatter and dimmer
        c = mix(vec3(lum(c) * 0.6 + 0.12), c, 1.0 - 0.55 * strength) * (1.0 - 0.25 * strength);
      }
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export function createVision(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const pass = new ShaderPass(VisionShader);
  composer.addPass(pass);
  composer.addPass(new OutputPass());
  let profile: Profile = 'normal';
  const size = () => {
    const v = renderer.getDrawingBufferSize(new THREE.Vector2());
    pass.uniforms.res.value.set(v.x, v.y);
    composer.setSize(renderer.domElement.clientWidth, renderer.domElement.clientHeight);
  };
  size();
  return {
    get profile() { return profile; },
    set(p: Profile, strength = 1) { profile = p; pass.uniforms.mode.value = MODE[p]; pass.uniforms.strength.value = strength; },
    resize: size,
    /** Draw the frame: through the pass when a profile is on, else the plain render (identical to no vision module). */
    render() { if (profile === 'normal') renderer.render(scene, camera); else composer.render(); },
  };
}
