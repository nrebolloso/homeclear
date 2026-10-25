"""Walker over a loose rug, as cloth (MuJoCo flex), calibrated against the real walker/rug clips (data/recording_notes.csv).

The batch (batch_mujoco.py) models the mat as a rigid slab with a hinged corner, so it can only say "the whole mat slid";
the real takes show the rear glides folding or dragging the rug EDGE. Here the rug is a 2-D flex grid (it bends and
folds), the walker is batch_mujoco's walker (frictionless front wheels, rear glides), and two kinematic feet walk behind
it (stance pins the rug, swing lifts and lands). One trial pushes the walker straight onto or off the rug at a normal
speed; outcome per trial: folded (the edge ends lifted or doubled), dragged (rug moved >= 2 cm), clean.
SIMULATED: the rug's bending stiffness, mass and both frictions are sampled ranges, not measured.
  python physics/rug_calib.py grid      -> physics/rug_calib_grid.json  (P(outcome) per glide-rug x rug-floor friction cell)
  python physics/rug_calib.py check     -> physics/rug_calib.json       (fitted ranges vs the real rates, fixes, controls)
  python physics/rug_calib.py batch K N OUT   -> OUT/shard_K.json (cluster array task K: N paired draws per direction, BATCH_ARMS)
  python physics/rug_calib.py summarize OUT   -> physics/rug_batch.json (rates with 95% intervals over every shard)
"""
import json, math, os, re, sys
from multiprocessing import Pool
from pathlib import Path

import mujoco
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from batch_mujoco import GR, WR, walker_geoms

WK = json.load(open(HERE / 'batch_scene_kitchen4_lighter.json'))['walker']
RUG_L, RUG_W, DX = 0.9, 0.6, 0.04          # kitchen4 rug ~0.93 x 0.59 m; grid pitch
FOLD_Z, DRAG_M = 0.008, 0.02                # a vertex this high = edge lifted/doubled (flat rug ~0.002); rug moved this far
GLIDE_FLOOR_MU = 0.25                       # glide on hard floor (the walker range's middle); glide-rug is the fitted one


def glides(g, mu_gr, wheels_only):
    """Each rear glide as two spheres: one sees only the rug (glide-rug friction), one only the floor, since MuJoCo
    contact friction comes from one geom of the pair and the two frictions differ. wheels_only: glides frictionless."""
    out = []
    for line in g.split('\n'):
        if 'sphere' in line and f'size="{GR}"' in line:
            if wheels_only:
                out.append(re.sub(r'condim="3" friction="[^"]*"', 'condim="1"', line)); continue
            out.append(re.sub(r'friction="[^ ]*', f'friction="{max(mu_gr, 1e-3)}', line).replace('contype="2" conaffinity="45"', 'contype="128" conaffinity="8"'))
            out.append(re.sub(r'friction="[^ ]*', f'friction="{GLIDE_FLOOR_MU}', line).replace('contype="2" conaffinity="45"', 'contype="64" conaffinity="1"').replace('mass="0.1"', 'mass="0.001"'))
        else:
            out.append(line)
    return '\n'.join(out)


def model(p):
    nx, ny = round(RUG_L / DX) + 1, round(RUG_W / DX) + 1
    pins = ''
    if p.get('taped'):   # double-sided tape along the two edges the walker crosses: those vertex rows can't move
        ids = [j * ny + i for j in (0, nx - 1) for i in range(ny)]   # flexcomp grid order: x outer, y inner
        pins = f'<pin id="{" ".join(map(str, ids))}"/>'
    feet = ''.join(f'<body name="f{s}" mocap="true" pos="0 {0.1 * s} 0.5"><geom type="box" size="0.13 0.045 0.015" priority="3" '
                   f'friction="1 0.005 0.0001" contype="16" conaffinity="8"/></body>' for s in (1, -1))
    wv = dict(glide_friction=p['mu_gr'], frame_mass_kg=WK.get('frame_mass_kg', 3.4))
    return f'''<mujoco><option timestep="0.001"/><worldbody>
<geom type="plane" size="5 5 .1" friction="0.5 0.005 0.0001" contype="1" conaffinity="62"/>
<flexcomp name="rug" type="grid" count="{nx} {ny} 1" spacing="{DX} {DX} {DX}" pos="{RUG_L / 2} {p['dy'] + (3 if p.get('bare') else 0)} 0.002" radius="0.002" dim="2" mass="{p['mpa'] * RUG_L * RUG_W}">
 <contact condim="3" friction="{p['mu_rf']} 0.005 0.0001" priority="1" contype="8" conaffinity="19" selfcollide="none"/>
 <edge equality="false" damping="0.002"/>
 <elasticity young="{p['E']}" poisson="0.2" thickness="0.004" damping="0.0005" elastic2d="both"/>{pins}
</flexcomp>{feet}
<body name="walker" pos="0 0 0.001"><joint name="wx" type="slide" axis="1 0 0"/><joint name="wy" type="slide" axis="0 1 0"/><joint name="wz" type="slide" axis="0 0 1"/>
{glides(walker_geoms(WK, 0.0, wv), p['mu_gr'], p.get('wheels_only'))}</body></worldbody></mujoco>'''


def trial(p, keep=None):
    """One pass. p: direction ('onto' | 'off'), mu_gr, mu_rf, E, mpa, v, push, load, stride, dy (rug offset sideways).
    keep: a list to append (M, D) state to as (t, qpos, mocap_pos) every 1/30 s, for rendering (tools/rug_video.py)."""
    M = mujoco.MjModel.from_xml_string(model(p)); D = mujoco.MjData(M)
    jid = lambda j: mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_JOINT, j)
    qa = [M.jnt_qposadr[jid(j)] for j in ('wx', 'wy', 'wz')]; da = [M.jnt_dofadr[jid(j)] for j in ('wx', 'wy', 'wz')]
    wb = mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_BODY, 'walker')
    glide_x, wheel_x = min(l[0] for l in WK['legs']), max(l[0] for l in WK['legs'])
    if p['direction'] == 'off':   # glides start just inside the near edge, end 30 cm past the far one
        sx, ex = 0.05 - (glide_x - GR), RUG_L + 0.30 - (glide_x - GR)
    else:                          # wheels start 10 cm short of the edge, glides end 35 cm on
        sx, ex = -0.10 - (wheel_x + WR), 0.35 - glide_x
    st, sw = p['stride'], 0.35     # step length, swing time
    feet = {1: [sx + st / 2, 0.0, None], -1: [sx, 0.0, None]}   # per foot: stance x, swing start x, swing start t

    def place(t, xw):
        for s, f in feet.items():
            if f[2] is None and xw - f[0] > st / 2 and feet[-s][2] is None: f[1], f[2] = f[0], t
            ph = None
            if f[2] is not None:
                ph = (t - f[2]) / sw
                if ph >= 1: f[0], f[2], ph = xw + st / 2, None, None
            x, z = (f[0], 0.0025) if ph is None else (f[1] + (xw + st / 2 - f[1]) * ph, 0.0025 + 0.04 * math.sin(math.pi * ph))
            D.mocap_pos[0 if s == 1 else 1] = [x, 0.1 * s, z + 0.015]

    D.qpos[qa[0]] = sx; D.qpos[qa[2]] = 0.006
    for _ in range(300):           # settle the rug and the walker in place
        D.qvel[da[0]] = D.qvel[da[1]] = 0; D.qpos[qa[0]] = sx; D.qpos[qa[1]] = 0
        place(0.0, sx); mujoco.mj_step(M, D)
    v0 = D.flexvert_xpos.copy(); dist = ex - sx; v = p['v']; peak = 0.0
    n = int((dist / v + 1.5) / M.opt.timestep)
    for i in range(n):
        t = i * M.opt.timestep; e = min(t * v, dist); tv = v if t * v < dist else 0.0
        if t > dist / v + 1.0: D.xfrc_applied[:] = 0          # let go and let the rug settle
        else:
            fx = 400 * (sx + e - D.qpos[qa[0]]) + 80 * (tv - D.qvel[da[0]]); fy = -400 * D.qpos[qa[1]] - 80 * D.qvel[da[1]]
            k = min(1.0, p['push'] / max(math.hypot(fx, fy), 1e-9))
            D.xfrc_applied[wb, :3] = [fx * k, fy * k, -p['load']]
        place(t, D.qpos[qa[0]]); mujoco.mj_step(M, D)
        if i % 33 == 0:
            peak = max(peak, float(D.flexvert_xpos[:, 2].max()))
            if keep is not None: keep.append((t, D.qpos.copy(), D.mocap_pos.copy()))
    P = D.flexvert_xpos; disp = np.hypot(*(P[:, :2] - v0[:, :2]).T)
    hi = P[:, 2] > FOLD_Z
    out = dict(drag_m=float(np.percentile(disp, 90)), fold_h_m=float(P[:, 2].max() + 0.002), n_lifted=int(hi.sum()),
               fold_x=float(P[hi, 0].mean()) if hi.any() else None, peak_h_m=peak + 0.002,
               reached=bool(abs(D.qpos[qa[0]] - ex) < 0.1))
    out['outcome'] = 'folded' if out['n_lifted'] >= 2 else 'dragged' if out['drag_m'] >= DRAG_M else 'clean'
    return out


R0 = json.load(open(HERE.parent / 'physics_ranges.json'))
NUISANCE = dict(E=[3e4, 1e6], mpa=R0['mat']['mass_per_m2_kg'], v=[0.25, 0.45], push=R0['walker']['push_max_n'],
                load=R0['walker']['hand_load_n'], stride=[0.30, 0.45], dy=[-0.08, 0.08])


def sample(rng, **fixed):
    p = {k: (math.exp(rng.uniform(*map(math.log, r))) if k == 'E' else rng.uniform(*r)) for k, r in NUISANCE.items()}
    for k, r in fixed.items(): p[k] = rng.uniform(*r) if isinstance(r, (list, tuple)) else r
    return p


def _run(p): return p, trial(p)


def rates(rs):
    n = len(rs); c = lambda o: sum(r['outcome'] == o for r in rs)
    f, d = c('folded'), c('dragged')
    return dict(n=n, folded=f / n, dragged=d / n, disturbed=(f + d) / n, reached=sum(r['reached'] for r in rs) / n,
                fold_h_m=[float(np.percentile(h, q)) for q in (10, 50, 90)] if (h := [r['fold_h_m'] for r in rs if r['outcome'] == 'folded']) else None)


def pool_map(ps):
    with Pool(len(os.sched_getaffinity(0))) as pool: return pool.map(_run, ps)   # the CPUs this job was given, not the node's


def grid(per=6, seed=0):
    rng = np.random.default_rng(seed); cells = []
    for mu_gr in (0.1, 0.2, 0.35, 0.5, 0.7, 0.9):
        for mu_rf in (0.1, 0.2, 0.3, 0.45, 0.6):
            for d in ('off', 'onto'):
                cells += [sample(rng, direction=d, mu_gr=mu_gr, mu_rf=mu_rf) for _ in range(per)]
    res = pool_map(cells); out = []
    key = lambda p: (p['mu_gr'], p['mu_rf'], p['direction'])
    for k in sorted({key(p) for p, _ in res}):
        out.append(dict(mu_gr=k[0], mu_rf=k[1], direction=k[2], **rates([r for p, r in res if key(p) == k])))
    json.dump(dict(label='SIMULATED cloth rug (rug_calib.py grid): P(outcome) per friction cell, other parameters sampled', cells=out),
              open(HERE / 'rug_calib_grid.json', 'w'), indent=1)
    for c in out: print({k: (round(v, 2) if isinstance(v, float) else v) for k, v in c.items()})


# fitted to the OFF-the-rug takes (7 real, all folded or dragged): the grid cells where P(disturbed | off) >= 0.8
# (rug_calib_grid.json). Onto (1 real take) is the held-out check, not fitted to.
FIT = dict(mu_gr=R0['walker']['glide_rug_friction'], mu_rf=R0['rug_loose']['floor_friction'])   # the fit (grid mode), kept in physics_ranges.json
BEFORE = dict(mu_gr=R0['walker']['glide_friction'], mu_rf=R0['mat']['floor_friction'])   # the ranges before this fit
CAPS_MU = [0.10, 0.20]   # ASSUMED glide cap / tennis ball on rug pile (PTFE-like on fabric); not measured, see BLOCKERS.md
REAL = dict(off=dict(n=7, folded=6, dragged=1), onto=dict(n=1, folded=0, dragged=1))   # data/recording_notes.csv, flat rug


def write(real, arms, trials):
    """rug_calib.json: the rates the viewer reads (rugcascade.ts) and the fold height of every folded sim pass, any arm
    (the fitted arm drags rather than folds, so it has too few folds of its own)."""
    h = [t['fold_h_m'] for t in trials if t['outcome'] == 'folded']
    json.dump(dict(label='SIMULATED cloth rug (rug_calib.py check), paired arms; real = data/recording_notes.csv flat-rug passes; trials in rug_calib_trials.json',
                   fit=FIT, before=BEFORE, glide_caps_mu_assumed=CAPS_MU, glide_floor_mu=GLIDE_FLOOR_MU, real=real, arms=arms,
                   fold_h_m=dict(n=len(h), p10=float(np.percentile(h, 10)), p50=float(np.median(h)), p90=float(np.percentile(h, 90)))),
              open(HERE / 'rug_calib.json', 'w'), indent=1)


def paired(arms, ids, seed=1):
    """Every arm on the same draws of everything else, per draw id and direction."""
    ps = []
    for d in ('off', 'onto'):
        for i in ids:
            base = sample(np.random.default_rng([seed, i, d == 'off']), direction=d, **FIT)
            for a, kw in arms.items():
                p = dict(base, arm=a, **{k: v for k, v in kw.items() if not isinstance(v, list)})
                for k, v in kw.items():
                    if isinstance(v, list): p[k] = float(np.random.default_rng([seed, i, len(k)]).uniform(*v))
                ps.append(p)
    return ps


def check(n=30, seed=1):
    arms = dict(before=BEFORE, fitted=FIT, glide_caps=dict(FIT, mu_gr=CAPS_MU), taped=dict(FIT, taped=True), wheels_only=dict(FIT, wheels_only=True))
    ps = paired(arms, range(n), seed)
    res = pool_map(ps)
    out = {a: {d: rates([r for p, r in res if p['arm'] == a and p['direction'] == d]) for d in ('off', 'onto')} for a in arms}
    real = {d: dict(n=v['n'], folded=v['folded'] / v['n'], dragged=v['dragged'] / v['n'], disturbed=(v['folded'] + v['dragged']) / v['n']) for d, v in REAL.items()}
    trials = [dict(p, **r) for p, r in res]
    json.dump(trials, open(HERE / 'rug_calib_trials.json', 'w'))
    write(real, out, trials)
    print(f"{'':12s} {'off: fold drag disturbed':>28s}   {'onto: fold drag disturbed':>28s}")
    for a, v in [('REAL', real)] + list(out.items()):
        print(f"{a:12s} " + '   '.join(f"{v[d]['folded']:8.2f} {v[d]['dragged']:5.2f} {v[d]['disturbed']:9.2f} (n={v[d]['n']})" for d in ('off', 'onto')))


# the calibrated ranges, the glide-caps fix (CAPS_MU, ASSUMED) and the controls: tape, front wheels only, bare floor (the rug 3 m off the route)
BATCH_ARMS = dict(fitted=FIT, glide_caps=dict(FIT, mu_gr=CAPS_MU), taped=dict(FIT, taped=True), wheels_only=dict(FIT, wheels_only=True),
                  bare=dict(FIT, bare=True))


def batch(k, n, out):
    k, n = int(k), int(n); Path(out).mkdir(parents=True, exist_ok=True)
    res = pool_map(paired(BATCH_ARMS, range(k * n, (k + 1) * n), seed=2))   # seed 2: draws apart from check's
    json.dump([dict(p, **r) for p, r in res], open(Path(out) / f'shard_{k}.json', 'w'))


def wilson(x, n, z=1.96):
    c, h = (x + z * z / 2) / (n + z * z), z * math.sqrt(x * (n - x) / n + z * z / 4) / (n + z * z)
    return [round(c - h, 3), round(c + h, 3)]


def summarize(out):
    trials = [t for f in sorted(Path(out).glob('shard_*.json')) for t in json.load(open(f))]
    arms = {a: {d: dict(rates(rs := [t for t in trials if t['arm'] == a and t['direction'] == d]),
                        disturbed_ci95=wilson(sum(t['outcome'] != 'clean' for t in rs), len(rs)),
                        folded_ci95=wilson(sum(t['outcome'] == 'folded' for t in rs), len(rs))) for d in ('off', 'onto')} for a in BATCH_ARMS}
    json.dump(dict(label='SIMULATED cloth rug (rug_calib.py batch, cluster), paired arms; glide_caps friction ASSUMED',
                   fit=FIT, glide_caps_mu_assumed=CAPS_MU, real=REAL, arms=arms), open(HERE / 'rug_batch.json', 'w'), indent=1)
    for a, v in arms.items():
        print(f"{a:12s} " + '   '.join(f"{d}: fold {v[d]['folded']:.2f} disturbed {v[d]['disturbed']:.2f} {v[d]['disturbed_ci95']} (n={v[d]['n']})" for d in ('off', 'onto')))


if __name__ == '__main__':
    if sys.argv[1] in ('batch', 'summarize'): sys.exit({'batch': batch, 'summarize': summarize}[sys.argv[1]](*sys.argv[2:]))
    {'grid': grid, 'check': check,   # rewrite: rug_calib.json from rug_calib_trials.json without re-running
     'rewrite': lambda: write(*(lambda j, t: (j['real'], j['arms'], t))(json.load(open(HERE / 'rug_calib.json')), json.load(open(HERE / 'rug_calib_trials.json'))))}[sys.argv[1]]()
