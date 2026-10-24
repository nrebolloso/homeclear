"""Offline physics study (MuJoCo, CPU): thousands of simulated walker pushes over the mat, into its curled corner and
past the chairs, each with masses/frictions/flap stiffness sampled from physics_ranges.json. Output: probabilities that
the mat slides, the corner folds, a chair moves or tips, per approach speed and angle.

Every number this produces is SIMULATED: the geometry is from the splat (physics/batch_scene_<run>.json, written by
export_batch_scene.ts with the viewer's own code), the properties are sampled from assumed ranges, not measured.

  python physics/batch_mujoco.py run   --scene physics/batch_scene_kitchen4_lighter.json --trials 200 --seed 1 --out out/physics/shard_1.csv
  python physics/batch_mujoco.py summarize out/physics/shard_*.csv --out proof/physics/batch_results.json
  python physics/batch_mujoco.py selftest
"""
import argparse, csv, glob, json, math, os, sys, time
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WR, GR = 0.0635, 0.033          # wheel / glide radius, as objphys.ts
SPEEDS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]           # bin edges, m/s
ANGLES = [0, 15, 30, 45, 60, 75, 90]              # bin edges, degrees off head-on
FIELDS = ['scenario', 'target', 'speed_mps', 'angle_deg', 'offset_m', 'seed', 'mass_kg', 'floor_friction', 'flap_stiffness_nm_per_rad',
          'flap_damping', 'curl_lift_m', 'curl_size_m', 'curl_assumed', 'push_max_n', 'glide_friction', 'frame_mass_kg', 'hand_load_n',
          'contact', 'moved_m', 'tilt_deg', 'flap_max_rad', 'caught', 'moved', 'tipped', 'slid', 'folded', 'invalid']


def pick(r, u): return r[0] + (r[1] - r[0]) * u.random()


def rot(yaw, x, y): c, s = math.cos(yaw), math.sin(yaw); return c * x - s * y, s * x + c * y


def walker_geoms(wk, yaw, wv):
    """The walker of objphys.ts, turned to `yaw`, as MuJoCo geoms (body frame = the user's body centre on the floor)."""
    legs, hh, lr = wk['legs'], wk['handle_height_m'], wk['leg_radius_m']
    front = max(l[0] for l in legs)
    g = []
    # walker geoms win friction (priority 2): wheels are frictionless (condim 1), glides drag with glide_friction
    for lx, ly in legs:
        wheel = lx == front; r = WR if wheel else GR; x, y = rot(yaw, lx, ly)
        g.append(f'<geom type="sphere" size="{r}" pos="{x} {y} {r}" mass="0.1" priority="2" {"condim=\"1\"" if wheel else f"condim=\"3\" friction=\"{wv["glide_friction"]} 0.005 0.0001\""} contype="2" conaffinity="45"/>')
        z0 = 2 * r + 0.01
        g.append(f'<geom type="capsule" size="{lr}" fromto="{x} {y} {z0} {x} {y} {hh}" mass="{wv["frame_mass_kg"] / 8}" priority="2" friction="0.3" contype="2" conaffinity="45"/>')
    for side in (1, -1):
        f = [l for l in legs if l[0] == front and np.sign(l[1]) == side][0]; b = [l for l in legs if l[0] != front and np.sign(l[1]) == side][0]
        for z, m in ((hh, wv['frame_mass_kg'] / 4), (0.3, 0.01)):   # side rail at handle height, lower side brace
            (ax, ay), (bx, by) = rot(yaw, f[0], f[1]), rot(yaw, b[0], b[1])
            g.append(f'<geom type="capsule" size="{lr}" fromto="{ax} {ay} {z} {bx} {by} {z}" mass="{m}" priority="2" friction="0.3" contype="2" conaffinity="45"/>')
    hy = max(abs(l[1]) for l in legs)   # front cross brace (open at the back for the user)
    (ax, ay), (bx, by) = rot(yaw, front, hy), rot(yaw, front, -hy)
    g.append(f'<geom type="capsule" size="{lr}" fromto="{ax} {ay} 0.45 {bx} {by} 0.45" mass="0.01" priority="2" friction="0.3" contype="2" conaffinity="45"/>')
    return '\n'.join(g)


# contact bits (MuJoCo: two geoms touch if either one's conaffinity has the other's contype):
# 1 floor, 2 walker, 4 object columns, 8 mat, 16 object feet, 32 flap. Feet see floor + mat only; the flap floor + walker.
def chair_body(c, s):
    cols = c['columns']; vol = sum(h[0] * h[1] * h[2] for _, h in [(q['c'], q['h']) for q in cols]) or 1
    g = [f'<geom type="box" size="{q["h"][0]} {q["h"][1]} {q["h"][2]}" pos="{q["c"][0]} {q["c"][1]} {q["c"][2]}" mass="{s["mass_kg"] * q["h"][0] * q["h"][1] * q["h"][2] / vol}" '
         f'priority="1" friction="{s["floor_friction"]} 0.005 0.0001" contype="4" conaffinity="15"/>' for q in cols]
    fp = c['footprint']; cx, cy = np.mean([p[0] for p in fp]), np.mean([p[1] for p in fp])
    for x, y in fp:   # the corner feet of objphys.ts: stand-ins for legs the splat didn't see
        d = math.hypot(x - cx, y - cy) or 1; f = max(0, 1 - 0.04 / d)
        g.append(f'<geom type="box" size="0.02 0.02 0.005" pos="{cx + (x - cx) * f} {cy + (y - cy) * f} 0.005" mass="0.0001" priority="1" friction="{s["floor_friction"]} 0.005 0.0001" contype="16" conaffinity="9"/>')
    return '<body name="obj" pos="0 0 0"><freejoint/>' + '\n'.join(g) + '</body>'


def mat_body(m, s, curl):
    """Mat slab (pivot-local footprint), the curled corner cut off and hung on a spring hinge along the cut line."""
    poly = [tuple(p) for p in m['footprint']]; t = max(m['height_m'], 0.004)
    flap = ''; assets = []
    if curl:
        n = len(poly); C = poly[curl['corner']]; P = poly[(curl['corner'] - 1) % n]; N = poly[(curl['corner'] + 1) % n]
        along = lambda q: (C[0] + (q[0] - C[0]) / math.dist(q, C) * curl['size_m'], C[1] + (q[1] - C[1]) / math.dist(q, C) * curl['size_m'])
        A, B = along(P), along(N)
        poly = [q for i, p in enumerate(poly) for q in ((A, B) if i == curl['corner'] else (p,))]
        mid = ((A[0] + B[0]) / 2, (A[1] + B[1]) / 2); ol = math.dist(mid, C); out = ((C[0] - mid[0]) / ol, (C[1] - mid[1]) / ol)
        tri = [(q[0] - mid[0], q[1] - mid[1]) for q in (A, C, B)]
        assets.append('<mesh name="flap" vertex="' + ' '.join(f'{x} {y} {z}' for x, y in tri for z in (-t, 0)) + '"/>')
        area = abs(sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(poly, poly[1:] + poly[:1]))) / 2
        fm = max(0.005, s['mass_kg'] / area * curl['size_m'] ** 2 / 2)
        flap = (f'<body name="flap" pos="{mid[0]} {mid[1]} {t}"><joint name="hinge" type="hinge" axis="{out[1]} {-out[0]} 0" stiffness="{s["flap_stiffness_nm_per_rad"]}" '
                f'springref="{math.asin(min(1, curl["lift_m"] / ol))}" damping="{s["flap_damping"]}" range="-0.2 3.1"/>'
                f'<geom type="mesh" mesh="flap" mass="{fm}" priority="1" friction="1" contype="32" conaffinity="3"/></body>')
        rest = math.asin(min(1, curl['lift_m'] / ol))
    else: rest = 0
    assets.append('<mesh name="mat" vertex="' + ' '.join(f'{x} {y} {z}' for x, y in poly for z in (0, t)) + '"/>')
    body = (f'<body name="obj" pos="0 0 0"><freejoint/><geom type="mesh" mesh="mat" mass="{s["mass_kg"]}" priority="1" '
            f'friction="{s["floor_friction"]} 0.005 0.0001" contype="8" conaffinity="23"/>{flap}</body>')
    return body, '\n'.join(assets), rest


def edge_frame(poly, i):
    """Edge i of a CCW-or-CW polygon: midpoint, unit along, unit inward normal, length."""
    a, b = poly[i], poly[(i + 1) % len(poly)]; L = math.dist(a, b); ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    cx, cy = np.mean([p[0] for p in poly]), np.mean([p[1] for p in poly]); mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    nx, ny = -uy, ux
    if nx * (cx - mx) + ny * (cy - my) < 0: nx, ny = -nx, -ny
    return (mx, my), (ux, uy), (nx, ny), L


def trial(scene, ranges, scenario, u, seed):
    import mujoco
    wk = scene['walker']; W = ranges['walker']
    wv = {k: pick(W[k], u) for k in ('push_max_n', 'glide_friction', 'frame_mass_kg', 'hand_load_n')}
    v = u.uniform(SPEEDS[0], SPEEDS[-1]); ang = math.radians(u.uniform(ANGLES[0], ANGLES[-1])) * (1 if u.random() < 0.5 else -1)
    front = max(l[0] for l in wk['legs']) + WR; half_w = wk['width_m'] / 2
    row = dict(scenario=scenario, speed_mps=v, angle_deg=abs(math.degrees(ang)), seed=seed, curl_assumed='', **wv)
    if scenario == 'chair':
        c = scene['chairs'][u.integers(len(scene['chairs']))]; R = ranges['objects']['chair']
        s = {'mass_kg': pick(R['mass_kg'], u), 'floor_friction': pick(R['floor_friction'], u)}
        body, assets, rest = chair_body(c, s), '', 0
        (mx, my), (ux, uy), (nx, ny), L = edge_frame(c['footprint'], u.integers(len(c['footprint'])))
        off = u.uniform(-(L / 2 + half_w + 0.15), L / 2 + half_w + 0.15)   # wide enough that some approaches pass the chair untouched
        row.update(target=c['name'], **s)
    else:
        m = scene['mat']; R = ranges['mat']; fp = m['footprint']
        wid = math.dist(fp[0], fp[1]); dep = math.dist(fp[1], fp[2])
        s = {'mass_kg': pick(R['mass_per_m2_kg'], u) * wid * dep, 'floor_friction': pick(R['floor_friction'], u),
             'flap_stiffness_nm_per_rad': pick(R['flap_stiffness_nm_per_rad'], u), 'flap_damping': pick(R['flap_damping'], u)}
        curl = m.get('curl')
        if not curl:   # the splat shows no curl: an assumed one (physics_ranges.json batch_curl_*), labelled as such
            curl = {'corner': int(u.integers(len(fp))), 'lift_m': pick(R['batch_curl_lift_m'], u), 'size_m': pick(R['batch_curl_size_m'], u)}; row['curl_assumed'] = 1
        else: row['curl_assumed'] = 0
        body, assets, rest = mat_body(m, s, curl)
        row.update(target=m['name'], curl_lift_m=curl['lift_m'], curl_size_m=curl['size_m'], **s)
        if scenario == 'mat_corner':   # aim at the curled corner along its inward diagonal, +- angle, offset across the walker
            C = fp[curl['corner']]; cx, cy = np.mean([p[0] for p in fp]), np.mean([p[1] for p in fp]); d = math.dist(C, (cx, cy))
            (mx, my), (nx, ny) = C, ((cx - C[0]) / d, (cy - C[1]) / d); ux, uy = -ny, nx; off = u.uniform(-half_w - 0.1, half_w + 0.1)
        else:          # mat_edge: cross an edge somewhere in its middle 80%
            (mx, my), (ux, uy), (nx, ny), L = edge_frame(fp, u.integers(len(fp))); off = u.uniform(-0.4, 0.4) * L
    row['offset_m'] = off
    dx, dy = rot(ang, nx, ny); yaw = math.atan2(dy, dx)
    ax, ay = mx + ux * off, my + uy * off                       # where the walker's front centre crosses the edge
    pre, post = 0.25, (0.5 if scenario == 'chair' else 0.9)
    sx, sy = ax - dx * (pre + front), ay - dy * (pre + front)   # walker origin (user's body centre) at the start
    xml = f'''<mujoco><compiler angle="radian"/><option timestep="0.002" gravity="0 0 -9.81"/><asset>{assets}</asset><worldbody>
<geom name="floor" type="plane" size="20 20 0.1" friction="0.5 0.005 0.0001" contype="1" conaffinity="62"/>{body}
<body name="walker" pos="0 0 0.001"><joint name="wx" type="slide" axis="1 0 0"/><joint name="wy" type="slide" axis="0 1 0"/><joint name="wz" type="slide" axis="0 0 1"/>
{walker_geoms(wk, yaw, wv)}</body></worldbody></mujoco>'''
    M = mujoco.MjModel.from_xml_string(xml); D = mujoco.MjData(M)
    hinge = mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_JOINT, 'hinge')
    if hinge >= 0: D.qpos[M.jnt_qposadr[hinge]] = rest
    ob, wb = mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_BODY, 'obj'), mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_BODY, 'walker')
    wq = [M.jnt_qposadr[mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_JOINT, j)] for j in ('wx', 'wy')]
    wd = [M.jnt_dofadr[mujoco.mj_name2id(M, mujoco.mjtObj.mjOBJ_JOINT, j)] for j in ('wx', 'wy')]
    walker_geoms_ids = set(np.nonzero(M.geom_bodyid == wb)[0]); obj_bodies = {ob} | ({M.jnt_bodyid[hinge]} if hinge >= 0 else set())
    touches = lambda c: (c.geom1 in walker_geoms_ids and M.geom_bodyid[c.geom2] in obj_bodies) or (c.geom2 in walker_geoms_ids and M.geom_bodyid[c.geom1] in obj_bodies)
    # a glancing approach can start with the walker's side already in the object: back the start off along the path until clear
    while True:
        D.qpos[wq[0]], D.qpos[wq[1]] = sx, sy; mujoco.mj_forward(M, D)
        if pre > 2 or not any(touches(c) for c in D.contact[:D.ncon]): break
        pre += 0.05; sx, sy = ax - dx * (pre + front), ay - dy * (pre + front)
    # slide joints are offsets from the body's pos (0, 0): qpos is the walker's world x, y
    # settle with the walker held still: an object that drifts untouched makes the trial invalid (counted, not used)
    mujoco.mj_forward(M, D); p_pre = D.xpos[ob].copy()
    for _ in range(int(0.5 / M.opt.timestep)):
        D.qvel[wd[0]] = D.qvel[wd[1]] = 0; D.qpos[wq[0]], D.qpos[wq[1]] = sx, sy; mujoco.mj_step(M, D)
    p0 = D.xpos[ob].copy(); q0 = D.xquat[ob].copy()
    tilt = lambda q: math.degrees(math.acos(min(1, abs(1 - 2 * (q[1] ** 2 + q[2] ** 2)))) ) if q is not None else 0
    tilt0 = tilt(q0)
    invalid = tilt0 > 10 or np.hypot(*(p0[:2] - p_pre[:2])) > 0.01
    dist = pre + front + post; T = dist / v + 1.0
    contact = caught = False; flap0 = flap_max = D.qpos[M.jnt_qposadr[hinge]] if hinge >= 0 else 0; max_tilt = 0   # flap0: the curl after it settled
    # the person: a P-D follower of a point walking at v, force capped at push_max_n; their hand load presses down
    for i in range(int(T / M.opt.timestep)):
        t = i * M.opt.timestep; e = min(t * v, dist)
        tx, ty = sx + dx * e, sy + dy * e; tv = v if t * v < dist else 0
        fx = 400 * (tx - D.qpos[wq[0]]) + 80 * (tv * dx - D.qvel[wd[0]]); fy = 400 * (ty - D.qpos[wq[1]]) + 80 * (tv * dy - D.qvel[wd[1]])
        fn = math.hypot(fx, fy); k = min(1, wv['push_max_n'] / fn) if fn > 0 else 1
        D.xfrc_applied[wb, :3] = [fx * k, fy * k, -wv['hand_load_n']]
        mujoco.mj_step(M, D)
        for c in D.contact[:D.ncon]:
            if touches(c):
                contact = True
                if hinge >= 0 and (M.geom_bodyid[c.geom1] == M.jnt_bodyid[hinge] or M.geom_bodyid[c.geom2] == M.jnt_bodyid[hinge]): caught = True
        if hinge >= 0: flap_max = max(flap_max, D.qpos[M.jnt_qposadr[hinge]])
        if i % 25 == 0: max_tilt = max(max_tilt, tilt(D.xquat[ob]) - tilt0)
    moved = float(np.hypot(*(D.xpos[ob][:2] - p0[:2])))
    row.update(contact=int(contact), moved_m=moved, tilt_deg=max_tilt, flap_max_rad=flap_max, caught=int(caught and flap_max > flap0 + 0.05),
               moved=int(scenario == 'chair' and moved > 0.02), tipped=int(scenario == 'chair' and max_tilt > 30),
               slid=int(scenario != 'chair' and moved > 0.02), folded=int(flap_max > math.pi / 2), invalid=int(invalid))
    return row


def wilson(k, n, z=1.96):
    if n == 0: return [None, None]
    p = k / n; d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0, c - h), 4), round(min(1, c + h), 4)]


def summarize(rows):
    OUT = {'chair': ['moved', 'tipped'], 'mat_edge': ['slid', 'folded'], 'mat_corner': ['slid', 'caught', 'folded']}
    res = {'label': 'SIMULATED (MuJoCo): geometry from the splat, masses/frictions/flap stiffness sampled from assumed ranges '
                     '(physics_ranges.json), NOT measured. The real-walker check (BLOCKERS.md) has not been done.',
           'bins': 'chair bins count only trials where the walker touched the chair (P given contact); mat bins count every crossing', 'speed_bins_mps': SPEEDS, 'angle_bins_deg': ANGLES, 'angle': 'degrees between the walker heading and head-on (0 = straight at the edge/face, 90 = grazing)',
           'scenarios': {}}
    for sc, outs in OUT.items():
        R = [r for r in rows if r['scenario'] == sc and not int(r['invalid'])]
        if not R: continue
        inv = sum(1 for r in rows if r['scenario'] == sc and int(r['invalid']))
        e = {'trials': len(R), 'invalid_untouched_drift': inv, 'curl_assumed': sc != 'chair' and any(r['curl_assumed'] in ('1', 1) for r in R),
             'overall': {}, 'given_contact': {}, 'bins': []}
        C = [r for r in R if int(r['contact'])]
        e['p_contact'] = round(len(C) / len(R), 4)
        for o in outs:
            k = sum(int(r[o]) for r in R); e['overall'][o] = {'p': round(k / len(R), 4), 'ci95': wilson(k, len(R))}
            k = sum(int(r[o]) for r in C); e['given_contact'][o] = {'p': round(k / len(C), 4) if C else None, 'ci95': wilson(k, len(C))}
        for i in range(len(SPEEDS) - 1):
            for j in range(len(ANGLES) - 1):
                B = [r for r in (C if sc == 'chair' else R) if SPEEDS[i] <= float(r['speed_mps']) < SPEEDS[i + 1] + (i == len(SPEEDS) - 2) * 1e-9 and ANGLES[j] <= float(r['angle_deg']) <= ANGLES[j + 1] - (j < len(ANGLES) - 2) * 1e-9]
                b = {'speed_mps': [SPEEDS[i], SPEEDS[i + 1]], 'angle_deg': [ANGLES[j], ANGLES[j + 1]], 'n': len(B)}
                for o in outs:
                    k = sum(int(r[o]) for r in B); b[o] = round(k / len(B), 4) if B else None; b[o + '_ci95'] = wilson(k, len(B))
                e['bins'].append(b)
        res['scenarios'][sc] = e
    return res


def markdown(res):
    """The summary as Markdown tables: P(event) per speed (rows) x approach angle (columns), n per cell."""
    pc = lambda v: '-' if v is None else f'{100 * v:.1f}%'
    out = [f'_{res["label"]}_', '', res['bins'] + '; angle = ' + res['angle'] + '.', '']
    for sc, e in res['scenarios'].items():
        out += [f'## {sc}', '', f'{e["trials"]} valid trials ({e["invalid_untouched_drift"]} dropped: object drifted before the walker touched it); '
                f'walker touched the object in {pc(e["p_contact"])}' + ('; **curled corner geometry ASSUMED** (the splat shows none)' if e['curl_assumed'] else '') + '.', '',
                '| event | P (all trials) | P given contact |', '|---|---|---|']
        out += [f'| {o} | {pc(e["overall"][o]["p"])} ({pc(e["overall"][o]["ci95"][0])}-{pc(e["overall"][o]["ci95"][1])}) | {pc(e["given_contact"][o]["p"])} ({pc(e["given_contact"][o]["ci95"][0])}-{pc(e["given_contact"][o]["ci95"][1])}) |' for o in e['overall']]
        A = res['angle_bins_deg']
        for o in e['overall']:
            out += ['', f'**P({o})** by speed and angle (n per cell in brackets)', '', '| speed m/s | ' + ' | '.join(f'{A[j]}-{A[j + 1]}°' for j in range(len(A) - 1)) + ' |', '|---' * len(A) + '|']
            S = res['speed_bins_mps']
            for i in range(len(S) - 1):
                cells = [b for b in e['bins'] if b['speed_mps'] == [S[i], S[i + 1]]]
                out.append(f'| {S[i]}-{S[i + 1]} | ' + ' | '.join(f'{pc(b[o])} ({b["n"]})' for b in cells) + ' |')
        out.append('')
    return '\n'.join(out)


def selftest():
    assert wilson(0, 0) == [None, None] and wilson(5, 10)[0] < 0.5 < wilson(5, 10)[1]
    assert edge_frame([(0, 0), (1, 0), (1, 1), (0, 1)], 0)[2] == (0.0, 1.0)   # inward normal of the bottom edge points up
    rows = [dict(scenario='chair', invalid=0, contact=1, curl_assumed='', speed_mps=0.3, angle_deg=10, moved=1, tipped=0)] * 3
    s = summarize(rows)['scenarios']['chair']
    assert s['overall']['moved']['p'] == 1 and s['overall']['tipped']['p'] == 0 and sum(b['n'] for b in s['bins']) == 3
    assert '| moved | 100.0%' in markdown(summarize(rows))
    print('selftest ok')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest='cmd', required=True)
    r = sp.add_parser('run'); r.add_argument('--scene', required=True); r.add_argument('--ranges', default=os.path.join(ROOT, 'physics_ranges.json'))
    r.add_argument('--trials', type=int, default=100); r.add_argument('--seed', type=int, default=0); r.add_argument('--out', required=True)
    r.add_argument('--scenarios', default='chair,mat_edge,mat_corner')
    s = sp.add_parser('summarize'); s.add_argument('csv', nargs='+'); s.add_argument('--out', required=True); s.add_argument('--md', help='also write the tables as Markdown here')
    sp.add_parser('selftest')
    a = ap.parse_args()
    if a.cmd == 'selftest': selftest(); sys.exit()
    if a.cmd == 'summarize':
        rows = [r for f in a.csv for p in glob.glob(f) for r in csv.DictReader(open(p))]
        res = summarize(rows); os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True); json.dump(res, open(a.out, 'w'), indent=1)
        if a.md: open(a.md, 'w').write(markdown(res))
        for sc, e in res['scenarios'].items(): print(sc, e['trials'], 'trials, p_contact', e['p_contact'], {k: v['p'] for k, v in e['overall'].items()})
        sys.exit()
    scene, ranges = json.load(open(a.scene)), json.load(open(a.ranges))
    scen = a.scenarios.split(','); scen = [x for x in scen if x == 'chair' or scene.get('mat')]
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    t0 = time.time()
    with open(a.out, 'w', newline='') as f:
        w = csv.DictWriter(f, FIELDS); w.writeheader()
        for i in range(a.trials):
            sd = a.seed * 1_000_000 + i; u = np.random.default_rng(sd)
            w.writerow(trial(scene, ranges, scen[i % len(scen)], u, sd)); f.flush()
    print(f'{a.trials} trials in {time.time() - t0:.0f} s -> {a.out}')
