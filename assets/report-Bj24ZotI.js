import"./modulepreload-polyfill-P2Xu9kJm.js";import{t as e}from"./effort-DgPWHTxD.js";var t=e=>String(e??``).replace(/[&<>"]/g,e=>({"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`})[e]),n=e=>e<.05&&e>0?e.toFixed(2):e.toFixed(1),r=e=>`${(e*100).toFixed(1)} cm`,i=e=>e===`ok`?`ok`:e===`fail`?`bad`:`ot`,a=new URLSearchParams(location.search).get(`scene`)??``,o=sessionStorage.getItem(`report:${a}`);o&&s(JSON.parse(o));function s(a){let o=a.current,s=o.per_month-a.baseline,c=o.hazards.map(e=>`<tr><td>${t(e.type===`floor_bump`?e.name:`tight passage`)}</td>
    <td>${e.type===`floor_bump`?`${r(e.height_m)} high${e.estimated?` <span class="ot">(estimated: classified, not measured)</span>`:``}`:`${r(e.min_side_clearance_m)} each side of the walker`}</td>
    <td>${e.length_m.toFixed(2)} m</td><td>${e.type===`floor_bump`?n(e.per_month):`–`}</td>
    <td>${e.ot_check?`<span class="ot">OT to verify</span>`:``}</td></tr>`).join(``),l=o.checks.map(e=>`<tr><td class="${i(e.verdict)}">${t(e.verdict)}</td><td>${t(e.label)}</td><td class="dim">${t(e.note)}</td></tr>`).join(``),u=o.routes.map(e=>`<tr><td>${t(e.name)}${e.night?` (night)`:``}</td><td>${e.trips_per_night}</td><td>${e.error?`<span class="bad">no route</span>`:`${n(e.per_month)} (${n(e.lo)}–${n(e.hi)})`}</td><td>${e.length_m.toFixed(1)} m</td></tr>`).join(``),d=a.changes??a.actions.map(e=>({label:e.label,effort:0,helpers:1,cost_usd:e.cost_usd,product:e.product})),f=e=>e===void 0?`<span class="ot">price needed</span>`:e?`$${+e.toFixed(2)}`:`free`,p=d.map((n,r)=>`<tr><td>${r+1}</td><td>${t(n.label)}</td><td>${n.effort?`${n.effort.toFixed(1)} · ${e(n.effort)}`:``}</td><td>${n.helpers}</td><td>${f(n.cost_usd)}</td><td class="dim">${t(n.product??``)}</td></tr>`).join(``),m=d.filter(e=>e.cost_usd===void 0).length,h=d.reduce((e,t)=>e+t.effort,0),g=d.length?`<tr><td></td><td><b>Total</b></td><td><b>${h?`${h.toFixed(1)} · ${e(h)}`:``}</b></td><td><b>${Math.max(1,...d.map(e=>e.helpers))}</b></td><td><b>$${+d.reduce((e,t)=>e+(t.cost_usd??0),0).toFixed(2)}</b>${m?` <span class="ot">+ ${m} not priced yet</span>`:``}</td><td></td></tr>`:``,_=(a.masses??[]).map(e=>`<tr><td>${t(e.name.replace(/_/g,` `))}</td><td>${e.mass_kg} kg</td><td>${t(e.difficulty??`–`)}</td><td>${e.people}</td><td class="${e.flagged?`ot`:`dim`}">${t(e.explain)}</td></tr>`).join(``),v=(a.not_suggested??[]).map(e=>`${t(e.name.replace(/_/g,` `))} (${t(e.reason)})`).join(` · `),y=(a.provenance??[]).map(e=>`${t(e.provenance)} ${e.n}`).join(` · `),b=a.reason.filter(e=>e.verdict!==`dismissed`).map(e=>`<li><span class="imag">${t(e.note)}</span> · proposed by Cosmos Reason`+(e.verdict===`confirmed`?` · geometry agrees: ${t(e.measured)}`:` · not measurable from the scan · <span class="ot">OT to verify</span>`)+`</li>`).join(``),x=a.suggestions.map(r=>`<tr><td><b>${t(r.name)}</b></td><td>${n(r.per_month)} (${n(r.per_month_lo)}–${n(r.per_month_hi)})</td><td>${r.checks_failed}</td><td>$${r.cost_usd} · ${e(r.effort)} effort</td><td>${r.actions.map(e=>t(e.label)).join(`; `)}</td></tr>`).join(``),S=e=>`${(e*100).toFixed(+(e<.1))}%`,C={slid:`slides ≥ 2 cm`,folded:`corner folds over`,moved:`moves ≥ 2 cm`,tipped:`tips > 30°`},w=(o.objects??[]).map(e=>`<tr><td>${t(e.object.replace(/_/g,` `))}</td><td>${C[e.event]??t(e.event)}</td><td>${t(e.route)}</td><td>${e.angle_deg.toFixed(0)}° · ${e.speed_mps.toFixed(2)} m/s</td><td>${e.p_contact<1?`${S(e.p_contact)} of trips touch it`:`every trip crosses it`}</td><td>${S(e.p)} (${S(e.ci95[0]??0)}–${S(e.ci95[1]??0)}, n=${e.n})</td><td>${n(e.per_month)}</td></tr>`).join(``),T=(a.ranked_fixes??[]).map((n,r)=>`<tr><td>${r+1}</td><td><b>${t(n.label)}</b>${n.product?`<div class="dim">${t(n.product)}</div>`:``}</td>
    <td>${n.error?`<span class="bad">${a.ranked_by?t(n.error):`blocks the route`}</span>`:`<span class="${n.reduction>0?`ok`:`dim`}">−${n.reduction.toFixed(2)}</span> (${(n.share*100).toFixed(0)}%)`}</td>
    <td>${n.clearance_gain_m>.005?`<span class="ok">+${(n.clearance_gain_m*100).toFixed(0)} cm</span>`:`–`}</td>
    <td>${n.cost_usd===void 0?``:n.cost_usd?`$${n.cost_usd}`:`free`}</td><td>${n.effort?`${n.effort.toFixed(1)} · ${e(n.effort)}`:``}</td><td>${n.helpers??``}</td></tr>`).join(``),E=(a.planner_options??[]).map(n=>`<tr><td><b>${t(n.name)}</b></td><td>${n.per_month.toFixed(2)}</td><td>${n.cost_usd?`$${n.cost_usd}`:`free`}</td>
    <td>${n.effort.toFixed(1)} · ${e(n.effort)}</td><td>${n.helpers}</td><td>${n.changes.map(t).join(`; `)}</td></tr>`).join(``),D=a.budget,O=(D?.items??[]).filter(e=>e.checked||e.suggested).map(r=>`<tr><td>${r.checked?`✓`:`<span class="ot">declined</span>`}</td><td>${t(r.label)}${r.suggested?` <span class="dim">(suggested)</span>`:``}</td><td>${f(r.cost_usd)}</td><td>${r.effort.toFixed(1)} · ${e(r.effort)}</td><td>${r.benefit===void 0?`<span class="ot">OT to verify</span>`:`−${n(r.benefit)}`}</td><td class="dim">${t(r.product??``)}</td></tr>`).join(``),k=a.clips.map(e=>`<li><span class="imag">${t(e)}</span></li>`).join(``);document.getElementById(`root`).innerHTML=`
  <button onclick="print()">Print / save as PDF</button>
  <h1>Home walkthrough: ${t(a.scene)}</h1>
  <div class="dim">${t(new Date(a.created).toLocaleString())} · ${t(a.persona.label)} · knees ${r(a.persona.knee_height_m)}, seated reach ${r(a.persona.reach_m)}${a.persona.hip_precautions?`, hip precautions`:``}</div>
  <div class="banner"><b>For the occupational therapist to review: a flag list, not a diagnosis.</b> Measurements come from a 3D
  reconstruction of the home (Gaussian splat) scaled to metres; anything marked
  <span class="imag">imagined</span> is generated and never used for a number; <span class="ot">OT to verify</span> marks what the scan can't settle.
  ${a.synthetic?`<br><b class="bad">SYNTHETIC test scene, not a real home.</b>`:``}</div>

  <h2>Expected toe catches per month</h2>
  <div class="row"><div><div class="big">${n(o.per_month)}</div><div class="dim">likely ${n(o.per_month_lo)}–${n(o.per_month_hi)} · original layout ${n(a.baseline)}
    (<span class="${s<=0?`ok`:`bad`}">${s<=0?``:`+`}${n(s)}</span>)</div>
    <p class="dim">${a.rollouts} simulated trips per route, gait "${t(a.gait)}". Toe-contact rate calibrated to published data
    (${t(a.calibration)}); darkness multiplier ${a.dark_multiplier} (assumption). Range = measured height error + simulation noise.</p></div>
    <div><table><tr><th>Route</th><th>Trips/night</th><th>Contacts/month</th><th>Length</th></tr>${u}</table></div></div>

  <h2>Layout and route</h2>
  <div class="row"><img alt="top-down map of the layout with the route" src="${a.topdown}"><img alt="walker's view" src="${a.view}"></div>
  <p class="dim">Map: grey = walls/furniture, orange = floor bumps (rugs, thresholds, cables), blue line = route, rings = hazards,
  blue furniture = moved, dashed = where it stood, light grey floor = scanned too thinly to trust (not walked).</p>

  <h2>Measured hazards on the route (${t(a.route)})</h2>
  <table><tr><th>What</th><th>Measurement</th><th>Along route</th><th>Contacts/month</th><th></th></tr>${c||`<tr><td colspan="5">none</td></tr>`}</table>

  <h2>Transfers, reach and emergencies</h2>
  <table><tr><th>Verdict</th><th>Check</th><th>Basis</th></tr>${l||`<tr><td colspan="3">no fixtures marked</td></tr>`}</table>

  <h2>Changes in this layout</h2>
  <table><tr><th>#</th><th>Change</th><th>Effort</th><th>Helpers</th><th>Cost</th><th>Product</th></tr>${p||`<tr><td colspan="6">none: the home as filmed</td></tr>`}${g}</table>
  <p class="dim">Effort: moving an object grows with its mass (from the scan's measured size), distance carried and turn; Easy &lt; 2, Moderate 2–3.5, Hard &gt; 3.5.
  Helpers: two above 25 kg. Prices come from the product catalog; an unlisted item says "price needed" and is not added in.</p>
  ${v?`<p><b>Not suggested to move:</b> ${v}</p>`:``}
  ${_?`<h2>Furniture weights (for move effort)</h2><table><tr><th>Object</th><th>Mass</th><th>1 m carry</th><th>Helpers</th><th>How we know</th></tr>${_}</table>`:``}
  ${a.ranked_fixes?`<h2>Recommended fixes, ranked</h2><table><tr><th>#</th><th>Fix</th><th>Toe catches/month saved</th><th>Passage gained</th><th>Cost</th><th>Effort</th><th>Helpers</th></tr>${T||`<tr><td colspan="7">every listed fix is already in this layout</td></tr>`}</table>
  <p class="dim">Each fix is simulated on its own from the layout above (${a.rollouts} trips per route); savings are not additive. ${a.ranked_by?`Ranked by ${t(a.ranked_by)}.`:`Ranked by toe catches saved, then passage width, then cost.`}</p>`:``}
  ${E?`<h2>Planner options</h2><table><tr><th>Option</th><th>Toe catches/month</th><th>Cost</th><th>Effort</th><th>Helpers</th><th>Changes from the scanned room</th></tr>${E}</table>
  <p class="dim">Each option re-run on fresh simulated trips (${a.rollouts} per route), not the search's own draws.</p>`:``}
  ${x?`<h2>Suggested layouts (optimizer)</h2><table><tr><th>Option</th><th>Contacts/month</th><th>Failed checks</th><th>Cost · effort</th><th>Changes</th></tr>${x}</table>`:``}
  ${w?`<h2>Furniture the walker could push (<span class="imag">simulated</span>)</h2><table><tr><th>Object</th><th>Event</th><th>Route</th><th>Approach</th><th>Contact</th><th>P per touch/crossing (95% CI)</th><th>Per month</th></tr>${w}</table>
  <p class="dim">SIMULATED (MuJoCo batch, physics/batch_mujoco.py): shapes from the scan; masses, frictions and corner stiffness sampled from assumed ranges, not measured; not yet checked against the real walker. Approach angle 0° = straight at the edge.</p>`:``}
  ${b?`<h2>Not measurable from the scan (proposed by a model)</h2><ul>${b}</ul>`:``}
  ${k?`<h2>Generated visualisations of this layout</h2><ul>${k}</ul><p class="dim">Cosmos Transfer videos: imagined, for the family; hazard markers on them are the measured ones.</p>`:``}

  ${D?`<h2>Budget: $${D.usd}</h2><table><tr><th></th><th>Fix</th><th>Cost</th><th>Effort</th><th>Toe contacts/month saved</th><th>Product</th></tr>${O||`<tr><td colspan="6">nothing selected</td></tr>`}</table>
  <p class="dim">Selected in the budget window: $${+D.spent.toFixed(2)} of $${D.usd}, effort cost ${D.effort_score}/100. Savings are each fix on its own, not additive.</p>`:``}

  <h2>Methods and limits</h2>
  <ul class="dim">
    <li>Measurements close to a limit are marked "borderline, OT to verify".</li>
    <li>Thin floor items (cables) are classified, not measured: their height is a typical value.</li>
    <li>Floor and walls under or behind furniture that was moved were never filmed; they are shown imagined (tinted) and not measured.</li>
    <li>Toe contacts are not falls; the numbers compare layouts for this person and route, they are not a fall probability.</li>
    <li>Furniture weights are estimated from the scanned size and a typical density per kind, not weighed; out-of-range values are marked for the OT.</li>
  </ul>
  ${y?`<p class="dim">Built from the run's log: ${a.log_entries} entries (${y}).</p>`:``}`}