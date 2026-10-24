import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { forward, sampleXY, toWorldModel, fitSteps, obsNll, type Persona } from '../src/gaitfit.ts';

const at = (f: string) => new URL(`../public/gait/${f}`, import.meta.url);
const ok = existsSync(at('persona.json'));
const M: Persona = ok ? JSON.parse(readFileSync(at('persona.json'), 'utf8')) : null!;
const near = (a: number[], b: number[], tol: number, msg: string) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < tol, `${msg}[${i}] ${v} vs ${b[i]}`));

test('gaitfit: forward matches persona.py Net (mixture means, walker and head heads)', { skip: !ok }, () => {
  const rows = JSON.parse(readFileSync(at('persona_check.json'), 'utf8'));
  for (const r of rows) r.x.forEach((x: number[], n: number) => {
    const o = forward(M, x, r.e), b = 5 * M.K;
    near([...Array(M.K)].flatMap((_, k) => [o[5 * k + 1], o[5 * k + 2]]), r.out[1][n].flat(), 1e-3, 'mu');
    near(o.slice(b, b + 3), r.out[3][n], 1e-3, 'walker');
    near(o.slice(b + 6, b + 9), r.out[5][n], 1e-3, 'head');
  });
});

test('gaitfit: the stream samples rebuild persona.py x / y, and the folded WorldModel equals the embedding net', { skip: !ok }, () => {
  const S = JSON.parse(readFileSync(at('persona_stream.json'), 'utf8')).people, p = S[Object.keys(S)[0]];
  for (const i of [0, 7, 40]) {
    const s = { heels: p.heels[i], sides: p.sides[i], action: p.action[i], walker1: p.walker1[i], head1: p.head1[i], dt: p.dt[i], heel1: p.heel1[i] };
    const { x, y } = sampleXY(s);
    near(x, p.x[i], 1e-4, 'x'); near(y, p.y[i], 1e-4, 'y');
    const e = M.people[1].e, wm = toWorldModel(M, e, 0);
    let h = x.map((v, j) => (v - wm.x_mean[j]) / wm.x_std[j]);
    wm.layers.forEach((l, li) => { h = l.W.map((row, o) => row.reduce((a, w, j) => a + w * h[j], l.b[o])); if (li < wm.layers.length - 1) h = h.map(v => v / (1 + Math.exp(-v))); });
    near(h, forward(M, x, e), 1e-6, 'folded');
  }
});

test('gaitfit: fitting the embedding on observed walker + head lowers their likelihood loss', { skip: !ok }, () => {
  const S = JSON.parse(readFileSync(at('persona_stream.json'), 'utf8')).people, p = S[Object.keys(S)[0]];
  const obs = p.x.slice(0, 20).map((x: number[], i: number) => ({ x, y: p.y[i] }));
  const J = (e: number[]) => obs.reduce((a: number, s: any) => a + obsNll(M, forward(M, s.x, e), s.y), 0);
  const e = fitSteps(M, obs, [...M.e_pop], { mo: M.e_pop.map(() => 0), v: M.e_pop.map(() => 0), t: 0 }, 30);
  assert.ok(J(e) < J(M.e_pop), `${J(e)} !< ${J(M.e_pop)}`);
});
