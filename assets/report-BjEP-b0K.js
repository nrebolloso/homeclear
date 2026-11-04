import"./modulepreload-polyfill-P2Xu9kJm.js";var e=e=>String(e??``).replace(/[&<>"]/g,e=>({"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`})[e]),t=e=>e<.05&&e>0?e.toFixed(2):e.toFixed(1),n=e=>`${(e*100).toFixed(1)} cm`,r=e=>e===`ok`?`ok`:e===`fail`?`bad`:`ot`,i=new URLSearchParams(location.search).get(`scene`)??``,a=sessionStorage.getItem(`report:${i}`);a&&o(JSON.parse(a));function o(i){let a=i.current,o=a.per_month-i.baseline,s=a.hazards.map(r=>`<tr><td>${e(r.type===`floor_bump`?r.name:`tight passage`)}</td>
    <td>${r.type===`floor_bump`?`${n(r.height_m)} high${r.estimated?` <span class="ot">(estimated: classified, not measured)</span>`:``}`:`${n(r.min_side_clearance_m)} each side of the walker`}</td>
    <td>${r.length_m.toFixed(2)} m</td><td>${r.type===`floor_bump`?t(r.per_month):`–`}</td>
    <td>${r.ot_check?`<span class="ot">OT to verify</span>`:``}</td></tr>`).join(``),c=a.checks.map(t=>`<tr><td class="${r(t.verdict)}">${e(t.verdict)}</td><td>${e(t.label)}</td><td class="dim">${e(t.note)}</td></tr>`).join(``),l=a.routes.map(n=>`<tr><td>${e(n.name)}${n.night?` (night)`:``}</td><td>${n.trips_per_night}</td><td>${n.error?`<span class="bad">no route</span>`:`${t(n.per_month)} (${t(n.lo)}–${t(n.hi)})`}</td><td>${n.length_m.toFixed(1)} m</td></tr>`).join(``),u=i.actions.map((t,n)=>`<tr><td>${n+1}</td><td>${e(t.label)}</td><td>${t.cost_usd===void 0?``:`$${t.cost_usd}`}</td><td>${t.minutes??``}${t.minutes?` min`:``}</td><td class="dim">${e(t.product??``)}</td></tr>`).join(``),d=i.reason.filter(e=>e.verdict!==`dismissed`).map(t=>`<li><span class="imag">${e(t.note)}</span> · proposed by Cosmos Reason`+(t.verdict===`confirmed`?` · geometry agrees: ${e(t.measured)}`:` · not measurable from the scan · <span class="ot">OT to verify</span>`)+`</li>`).join(``),f=i.suggestions.map(n=>`<tr><td><b>${e(n.name)}</b></td><td>${t(n.per_month)} (${t(n.per_month_lo)}–${t(n.per_month_hi)})</td><td>${n.checks_failed}</td><td>$${n.cost_usd} · ${n.minutes} min</td><td>${n.actions.map(t=>e(t.label)).join(`; `)}</td></tr>`).join(``),p=e=>`${(e*100).toFixed(+(e<.1))}%`,m={slid:`slides ≥ 2 cm`,folded:`corner folds over`,moved:`moves ≥ 2 cm`,tipped:`tips > 30°`},h=(a.objects??[]).map(n=>`<tr><td>${e(n.object.replace(/_/g,` `))}</td><td>${m[n.event]??e(n.event)}</td><td>${e(n.route)}</td><td>${n.angle_deg.toFixed(0)}° · ${n.speed_mps.toFixed(2)} m/s</td><td>${n.p_contact<1?`${p(n.p_contact)} of trips touch it`:`every trip crosses it`}</td><td>${p(n.p)} (${p(n.ci95[0]??0)}–${p(n.ci95[1]??0)}, n=${n.n})</td><td>${t(n.per_month)}</td></tr>`).join(``),g=[``,`easy`,`moderate`,`some effort`,`heavy`,`needs help`],_=(i.ranked_fixes??[]).map((t,n)=>`<tr><td>${n+1}</td><td><b>${e(t.label)}</b>${t.product?`<div class="dim">${e(t.product)}</div>`:``}</td>
    <td>${t.error?`<span class="bad">${i.ranked_by?e(t.error):`blocks the route`}</span>`:`<span class="${t.reduction>0?`ok`:`dim`}">−${t.reduction.toFixed(2)}</span> (${(t.share*100).toFixed(0)}%)`}</td>
    <td>${t.clearance_gain_m>.005?`<span class="ok">+${(t.clearance_gain_m*100).toFixed(0)} cm</span>`:`–`}</td>
    <td>${t.cost_usd===void 0?``:t.cost_usd?`$${t.cost_usd}`:`free`}</td><td>${t.minutes?`${t.minutes} min`:``}</td><td>${e(g[t.effort??0]??(t.effort??0).toFixed(1))}</td></tr>`).join(``),v=i.clips.map(t=>`<li><span class="imag">${e(t)}</span></li>`).join(``);document.getElementById(`root`).innerHTML=`
  <button onclick="print()">Print / save as PDF</button>
  <h1>Home walkthrough: ${e(i.scene)}</h1>
  <div class="dim">${e(new Date(i.created).toLocaleString())} · ${e(i.persona.label)} · knees ${n(i.persona.knee_height_m)}, seated reach ${n(i.persona.reach_m)}${i.persona.hip_precautions?`, hip precautions`:``}</div>
  <div class="banner"><b>For the occupational therapist to review: a flag list, not a diagnosis.</b> Measurements come from a 3D
  reconstruction of the home (Gaussian splat) scaled to metres; anything marked
  <span class="imag">imagined</span> is generated and never used for a number; <span class="ot">OT to verify</span> marks what the scan can't settle.
  ${i.synthetic?`<br><b class="bad">SYNTHETIC test scene, not a real home.</b>`:``}</div>

  <h2>Expected toe catches per month</h2>
  <div class="row"><div><div class="big">${t(a.per_month)}</div><div class="dim">likely ${t(a.per_month_lo)}–${t(a.per_month_hi)} · original layout ${t(i.baseline)}
    (<span class="${o<=0?`ok`:`bad`}">${o<=0?``:`+`}${t(o)}</span>)</div>
    <p class="dim">${i.rollouts} simulated trips per route, gait "${e(i.gait)}". Toe-contact rate calibrated to published data
    (${e(i.calibration)}); darkness multiplier ${i.dark_multiplier} (assumption). Range = measured height error + simulation noise.</p></div>
    <div><table><tr><th>Route</th><th>Trips/night</th><th>Contacts/month</th><th>Length</th></tr>${l}</table></div></div>

  <h2>Layout and route</h2>
  <div class="row"><img alt="top-down map of the layout with the route" src="${i.topdown}"><img alt="walker's view" src="${i.view}"></div>
  <p class="dim">Map: grey = walls/furniture, orange = floor bumps (rugs, thresholds, cables), blue line = route, rings = hazards,
  blue furniture = moved, dashed = where it stood, light grey floor = scanned too thinly to trust (not walked).</p>

  <h2>Measured hazards on the route (${e(i.route)})</h2>
  <table><tr><th>What</th><th>Measurement</th><th>Along route</th><th>Contacts/month</th><th></th></tr>${s||`<tr><td colspan="5">none</td></tr>`}</table>

  <h2>Transfers, reach and emergencies</h2>
  <table><tr><th>Verdict</th><th>Check</th><th>Basis</th></tr>${c||`<tr><td colspan="3">no fixtures marked</td></tr>`}</table>

  <h2>Changes in this layout</h2>
  <table><tr><th>#</th><th>Change</th><th>Cost</th><th>Time</th><th>Product</th></tr>${u||`<tr><td colspan="5">none: the home as filmed</td></tr>`}</table>
  ${i.ranked_fixes?`<h2>Recommended fixes, ranked</h2><table><tr><th>#</th><th>Fix</th><th>Toe catches/month saved</th><th>Passage gained</th><th>Cost</th><th>Time</th><th>Effort</th></tr>${_||`<tr><td colspan="7">every listed fix is already in this layout</td></tr>`}</table>
  <p class="dim">Each fix is simulated on its own from the layout above (${i.rollouts} trips per route); savings are not additive. ${i.ranked_by?`Ranked by ${e(i.ranked_by)}.`:`Ranked by toe catches saved, then passage width, then cost.`}</p>`:``}
  ${f?`<h2>Suggested layouts (optimizer)</h2><table><tr><th>Option</th><th>Contacts/month</th><th>Failed checks</th><th>Cost · time</th><th>Changes</th></tr>${f}</table>`:``}
  ${h?`<h2>Furniture the walker could push (<span class="imag">simulated</span>)</h2><table><tr><th>Object</th><th>Event</th><th>Route</th><th>Approach</th><th>Contact</th><th>P per touch/crossing (95% CI)</th><th>Per month</th></tr>${h}</table>
  <p class="dim">SIMULATED (MuJoCo batch, physics/batch_mujoco.py): shapes from the scan; masses, frictions and corner stiffness sampled from assumed ranges, not measured; not yet checked against the real walker. Approach angle 0° = straight at the edge.</p>`:``}
  ${d?`<h2>Not measurable from the scan (proposed by a model)</h2><ul>${d}</ul>`:``}
  ${v?`<h2>Generated visualisations of this layout</h2><ul>${v}</ul><p class="dim">Cosmos Transfer videos: imagined, for the family; hazard markers on them are the measured ones.</p>`:``}

  <h2>Methods and limits</h2>
  <ul class="dim">
    <li>Measurements close to a limit are marked "borderline, OT to verify".</li>
    <li>Thin floor items (cables) are classified, not measured: their height is a typical value.</li>
    <li>Floor and walls under or behind furniture that was moved were never filmed; they are shown imagined (tinted) and not measured.</li>
    <li>Toe contacts are not falls; the numbers compare layouts for this person and route, they are not a fall probability.</li>
  </ul>`}