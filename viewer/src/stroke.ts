// A stroke comparison persona: one side weak (hemiparesis), assumed numbers for comparison only, labelled as such.
// What changes: the stronger hand is the other side (rails, grab bars, getting out of bed go there), shorter and less
// regular steps with a dragging foot (lower toe clearance on the weak side shows up as a wider clearance spread), and
// the view missing on the weak side (vision.ts). The patient's own walker; their body facts otherwise.
export function strokePersona(patient: { walker: any; gait: any }, weak: 'left' | 'right' = 'left') {
  const strong = weak === 'left' ? 'right' : 'left';
  return { label: `Stroke, ${weak} side weak (assumed: short dragging steps, ${weak} view missing)`, walker: patient.walker,
    gait: { ...patient.gait, strong_side: strong, stride_m: 0.28, stride_cv: 0.18, toe_clearance_cv: 0.4 },
    plan: { turn_weight_m: 0.4 }, vision: weak === 'left' ? 'hemianopia_left' : 'normal' };
}
