// The OT report: what the walker game shows, on paper. The game writes a snapshot (sessionStorage) and opens this page;
// print it to PDF from the browser. Measured numbers, imagined content and judgement calls are kept visibly apart.
import type { ReportPayload } from './share.ts';
import { difficulty } from './effort.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const f1 = (x: number) => (x < 0.05 && x > 0 ? x.toFixed(2) : x.toFixed(1));
const cm = (m: number) => `${(m * 100).toFixed(1)} cm`;
const vcls = (v: string) => (v === 'ok' ? 'ok' : v === 'fail' ? 'bad' : 'ot');

const scene = new URLSearchParams(location.search).get('scene') ?? '';
const raw = sessionStorage.getItem(`report:${scene}`);
if (raw) render(JSON.parse(raw) as ReportPayload);

function render(p: ReportPayload) {
  const c = p.current, d = c.per_month - p.baseline;
  const hz = c.hazards.map(h => `<tr><td>${esc(h.type === 'floor_bump' ? h.name : 'tight passage')}</td>
    <td>${h.type === 'floor_bump' ? `${cm(h.height_m!)} high${h.estimated ? ' <span class="ot">(estimated: classified, not measured)</span>' : ''}`
      : `${cm(h.min_side_clearance_m!)} each side of the walker`}</td>
    <td>${h.length_m.toFixed(2)} m</td><td>${h.type === 'floor_bump' ? f1(h.per_month) : '–'}</td>
    <td>${h.ot_check ? '<span class="ot">OT to verify</span>' : ''}</td></tr>`).join('');
  const checks = c.checks.map(k => `<tr><td class="${vcls(k.verdict)}">${esc(k.verdict)}</td><td>${esc(k.label)}</td><td class="dim">${esc(k.note)}</td></tr>`).join('');
  const routes = c.routes.map(r => `<tr><td>${esc(r.name)}${r.night ? ' (night)' : ''}</td><td>${r.trips_per_night}</td><td>${r.error ? '<span class="bad">no route</span>' : `${f1(r.per_month)} (${f1(r.lo)}–${f1(r.hi)})`}</td><td>${r.length_m.toFixed(1)} m</td></tr>`).join('');
  // the changes on screen (movecost.ts via the log): effort and helpers per row; totals: effort adds, helpers is the most
  // any one change needs, cost adds the priced rows and counts the rest (never guessed)
  const ch = p.changes ?? p.actions.map(a => ({ label: a.label, effort: 0, helpers: 1, cost_usd: a.cost_usd, product: a.product }));
  const money = (x?: number) => (x === undefined ? '<span class="ot">price needed</span>' : x ? `$${+x.toFixed(2)}` : 'free');
  const acts = ch.map((a, n) => `<tr><td>${n + 1}</td><td>${esc(a.label)}</td><td>${a.effort ? `${a.effort.toFixed(1)} · ${difficulty(a.effort)}` : ''}</td>`
    + `<td>${a.helpers}</td><td>${money(a.cost_usd)}</td><td class="dim">${esc(a.product ?? '')}</td></tr>`).join('');
  const unpriced = ch.filter(a => a.cost_usd === undefined).length, effTot = ch.reduce((t, a) => t + a.effort, 0);
  const total = ch.length ? `<tr><td></td><td><b>Total</b></td><td><b>${effTot ? `${effTot.toFixed(1)} · ${difficulty(effTot)}` : ''}</b></td>`
    + `<td><b>${Math.max(1, ...ch.map(a => a.helpers))}</b></td><td><b>$${+ch.reduce((t, a) => t + (a.cost_usd ?? 0), 0).toFixed(2)}</b>`
    + `${unpriced ? ` <span class="ot">+ ${unpriced} not priced yet</span>` : ''}</td><td></td></tr>` : '';
  // what each object weighs and how we know (effort.ts, from the measured box); what the suggestions never move
  const masses = (p.masses ?? []).map(m => `<tr><td>${esc(m.name.replace(/_/g, ' '))}</td><td>${m.mass_kg} kg</td><td>${esc(m.difficulty ?? '–')}</td><td>${m.people}</td>`
    + `<td class="${m.flagged ? 'ot' : 'dim'}">${esc(m.explain)}</td></tr>`).join('');
  const never = (p.not_suggested ?? []).map(n => `${esc(n.name.replace(/_/g, ' '))} (${esc(n.reason)})`).join(' · ');
  const prov = (p.provenance ?? []).map(k => `${esc(k.provenance)} ${k.n}`).join(' · ');
  const reason = p.reason.filter((r: any) => r.verdict !== 'dismissed').map((r: any) => `<li><span class="imag">${esc(r.note)}</span> · proposed by Cosmos Reason` +
    (r.verdict === 'confirmed' ? ` · geometry agrees: ${esc(r.measured)}` : ' · not measurable from the scan · <span class="ot">OT to verify</span>') + '</li>').join('');
  const sugg = p.suggestions.map(o => `<tr><td><b>${esc(o.name)}</b></td><td>${f1(o.per_month)} (${f1(o.per_month_lo)}–${f1(o.per_month_hi)})</td><td>${o.checks_failed}</td><td>$${o.cost_usd} · ${difficulty(o.effort)} effort</td><td>${o.actions.map((a: { label: string }) => esc(a.label)).join('; ')}</td></tr>`).join('');
  const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`, EV: Record<string, string> = { slid: 'slides ≥ 2 cm', folded: 'corner folds over', moved: 'moves ≥ 2 cm', tipped: 'tips > 30°' };
  const objs = (c.objects ?? []).map(e => `<tr><td>${esc(e.object.replace(/_/g, ' '))}</td><td>${EV[e.event] ?? esc(e.event)}</td><td>${esc(e.route)}</td><td>${e.angle_deg.toFixed(0)}° · ${e.speed_mps.toFixed(2)} m/s</td>`
    + `<td>${e.p_contact < 1 ? `${pct(e.p_contact)} of trips touch it` : 'every trip crosses it'}</td><td>${pct(e.p)} (${pct(e.ci95[0] ?? 0)}–${pct(e.ci95[1] ?? 0)}, n=${e.n})</td><td>${f1(e.per_month)}</td></tr>`).join('');
  const ranked = (p.ranked_fixes ?? []).map((f, n) => `<tr><td>${n + 1}</td><td><b>${esc(f.label)}</b>${f.product ? `<div class="dim">${esc(f.product)}</div>` : ''}</td>
    <td>${f.error ? `<span class="bad">${p.ranked_by ? esc(f.error) : 'blocks the route'}</span>` : `<span class="${f.reduction > 0 ? 'ok' : 'dim'}">−${f.reduction.toFixed(2)}</span> (${(f.share * 100).toFixed(0)}%)`}</td>
    <td>${f.clearance_gain_m > 0.005 ? `<span class="ok">+${(f.clearance_gain_m * 100).toFixed(0)} cm</span>` : '–'}</td>
    <td>${f.cost_usd !== undefined ? (f.cost_usd ? `$${f.cost_usd}` : 'free') : ''}</td><td>${f.effort ? `${f.effort.toFixed(1)} · ${difficulty(f.effort)}` : ''}</td><td>${f.helpers ?? ''}</td></tr>`).join('');
  const popts = (p.planner_options ?? []).map(o => `<tr><td><b>${esc(o.name)}</b></td><td>${o.per_month.toFixed(2)}</td><td>${o.cost_usd ? `$${o.cost_usd}` : 'free'}</td>
    <td>${o.effort.toFixed(1)} · ${difficulty(o.effort)}</td><td>${o.helpers}</td><td>${o.changes.map(esc).join('; ')}</td></tr>`).join('');
  const bp = p.budget, bud = (bp?.items ?? []).filter(i => i.checked || i.suggested).map(i => `<tr><td>${i.checked ? '✓' : '<span class="ot">declined</span>'}</td>`
    + `<td>${esc(i.label)}${i.suggested ? ' <span class="dim">(suggested)</span>' : ''}</td><td>${money(i.cost_usd)}</td><td>${i.effort.toFixed(1)} · ${difficulty(i.effort)}</td>`
    + `<td>${i.benefit !== undefined ? `−${f1(i.benefit)}` : '<span class="ot">OT to verify</span>'}</td><td class="dim">${esc(i.product ?? '')}</td></tr>`).join('');
  const clips = p.clips.map(k => `<li><span class="imag">${esc(k)}</span></li>`).join('');
  document.getElementById('root')!.innerHTML = `
  <button onclick="print()">Print / save as PDF</button>
  <h1>Home walkthrough: ${esc(p.scene)}</h1>
  <div class="dim">${esc(new Date(p.created).toLocaleString())} · ${esc(p.persona.label)} · knees ${cm(p.persona.knee_height_m)}, seated reach ${cm(p.persona.reach_m)}${p.persona.hip_precautions ? ', hip precautions' : ''}</div>
  <div class="banner"><b>For the occupational therapist to review: a flag list, not a diagnosis.</b> Measurements come from a 3D
  reconstruction of the home (Gaussian splat) scaled to metres; anything marked
  <span class="imag">imagined</span> is generated and never used for a number; <span class="ot">OT to verify</span> marks what the scan can't settle.
  ${p.synthetic ? '<br><b class="bad">SYNTHETIC test scene, not a real home.</b>' : ''}</div>

  <h2>Expected toe catches per month</h2>
  <div class="row"><div><div class="big">${f1(c.per_month)}</div><div class="dim">likely ${f1(c.per_month_lo)}–${f1(c.per_month_hi)} · original layout ${f1(p.baseline)}
    (<span class="${d <= 0 ? 'ok' : 'bad'}">${d <= 0 ? '' : '+'}${f1(d)}</span>)</div>
    <p class="dim">${p.rollouts} simulated trips per route, gait "${esc(p.gait)}". Toe-contact rate calibrated to published data
    (${esc(p.calibration)}); darkness multiplier ${p.dark_multiplier} (assumption). Range = measured height error + simulation noise.</p></div>
    <div><table><tr><th>Route</th><th>Trips/night</th><th>Contacts/month</th><th>Length</th></tr>${routes}</table></div></div>

  <h2>Layout and route</h2>
  <div class="row"><img alt="top-down map of the layout with the route" src="${p.topdown}"><img alt="walker's view" src="${p.view}"></div>
  <p class="dim">Map: grey = walls/furniture, orange = floor bumps (rugs, thresholds, cables), blue line = route, rings = hazards,
  blue furniture = moved, dashed = where it stood, light grey floor = scanned too thinly to trust (not walked).</p>

  <h2>Measured hazards on the route (${esc(p.route)})</h2>
  <table><tr><th>What</th><th>Measurement</th><th>Along route</th><th>Contacts/month</th><th></th></tr>${hz || '<tr><td colspan="5">none</td></tr>'}</table>

  <h2>Transfers, reach and emergencies</h2>
  <table><tr><th>Verdict</th><th>Check</th><th>Basis</th></tr>${checks || '<tr><td colspan="3">no fixtures marked</td></tr>'}</table>

  <h2>Changes in this layout</h2>
  <table><tr><th>#</th><th>Change</th><th>Effort</th><th>Helpers</th><th>Cost</th><th>Product</th></tr>${acts || '<tr><td colspan="6">none: the home as filmed</td></tr>'}${total}</table>
  <p class="dim">Effort: moving an object grows with its mass (from the scan's measured size), distance carried and turn; Easy &lt; 2, Moderate 2–3.5, Hard &gt; 3.5.
  Helpers: two above 25 kg. Prices come from the product catalog; an unlisted item says "price needed" and is not added in.</p>
  ${never ? `<p><b>Not suggested to move:</b> ${never}</p>` : ''}
  ${masses ? `<h2>Furniture weights (for move effort)</h2><table><tr><th>Object</th><th>Mass</th><th>1 m carry</th><th>Helpers</th><th>How we know</th></tr>${masses}</table>` : ''}
  ${p.ranked_fixes ? `<h2>Recommended fixes, ranked</h2><table><tr><th>#</th><th>Fix</th><th>Toe catches/month saved</th><th>Passage gained</th><th>Cost</th><th>Effort</th><th>Helpers</th></tr>${ranked || '<tr><td colspan="7">every listed fix is already in this layout</td></tr>'}</table>
  <p class="dim">Each fix is simulated on its own from the layout above (${p.rollouts} trips per route); savings are not additive. ${p.ranked_by ? `Ranked by ${esc(p.ranked_by)}.` : 'Ranked by toe catches saved, then passage width, then cost.'}</p>` : ''}
  ${popts ? `<h2>Planner options</h2><table><tr><th>Option</th><th>Toe catches/month</th><th>Cost</th><th>Effort</th><th>Helpers</th><th>Changes from the scanned room</th></tr>${popts}</table>
  <p class="dim">Each option re-run on fresh simulated trips (${p.rollouts} per route), not the search's own draws.</p>` : ''}
  ${sugg ? `<h2>Suggested layouts (optimizer)</h2><table><tr><th>Option</th><th>Contacts/month</th><th>Failed checks</th><th>Cost · effort</th><th>Changes</th></tr>${sugg}</table>` : ''}
  ${objs ? `<h2>Furniture the walker could push (<span class="imag">simulated</span>)</h2><table><tr><th>Object</th><th>Event</th><th>Route</th><th>Approach</th><th>Contact</th><th>P per touch/crossing (95% CI)</th><th>Per month</th></tr>${objs}</table>
  <p class="dim">SIMULATED (MuJoCo batch, physics/batch_mujoco.py): shapes from the scan; masses, frictions and corner stiffness sampled from assumed ranges, not measured; not yet checked against the real walker. Approach angle 0° = straight at the edge.</p>` : ''}
  ${reason ? `<h2>Not measurable from the scan (proposed by a model)</h2><ul>${reason}</ul>` : ''}
  ${clips ? `<h2>Generated visualisations of this layout</h2><ul>${clips}</ul><p class="dim">Cosmos Transfer videos: imagined, for the family; hazard markers on them are the measured ones.</p>` : ''}

  ${bp ? `<h2>Budget: $${bp.usd}</h2><table><tr><th></th><th>Fix</th><th>Cost</th><th>Effort</th><th>Toe contacts/month saved</th><th>Product</th></tr>${bud || '<tr><td colspan="6">nothing selected</td></tr>'}</table>
  <p class="dim">Selected in the budget window: $${+bp.spent.toFixed(2)} of $${bp.usd}, effort cost ${bp.effort_score}/100. Savings are each fix on its own, not additive.</p>` : ''}

  <h2>Methods and limits</h2>
  <ul class="dim">
    <li>Measurements close to a limit are marked "borderline, OT to verify".</li>
    <li>Thin floor items (cables) are classified, not measured: their height is a typical value.</li>
    <li>Floor and walls under or behind furniture that was moved were never filmed; they are shown imagined (tinted) and not measured.</li>
    <li>Toe contacts are not falls; the numbers compare layouts for this person and route, they are not a fall probability.</li>
    <li>Furniture weights are estimated from the scanned size and a typical density per kind, not weighed; out-of-range values are marked for the OT.</li>
  </ul>
  ${prov ? `<p class="dim">Built from the run's log: ${p.log_entries} entries (${prov}).</p>` : ''}`;
}
