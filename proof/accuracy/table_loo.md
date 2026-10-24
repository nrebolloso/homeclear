# Table leave-one-out (SPEC 4.3)

Scale set from two of the table's three tape dimensions (62 x 41 x 28 in), the third predicted from the splat; all three pairings.
`tools/table_loo.py --kitchens` writes this file. The splat dimensions are recovered from the width and height checks noted
next to each config's `scale.manual_factor` (0.1 % rounding), not re-measured. **REAL captures, tape rounded to the inch.**

| capture | held out | scale from | predicted (cm) | tape (cm) | error (cm) | error (%) |
|---|---|---|---|---|---|---|
| kitchen1 | length | width + height | 167.0 | 157.5 | +9.5 | +6.0 |
| kitchen1 | width | length + height | 88.3 | 104.1 | -15.9 | -15.2 |
| kitchen1 | height | length + width | 77.5 | 71.1 | +6.4 | +9.0 |
| kitchen2_nofar | length | width + height | 161.4 | 157.5 | +4.0 | +2.5 |
| kitchen2_nofar | width | length + height | 102.6 | 104.1 | -1.5 | -1.5 |
| kitchen2_nofar | height | length + width | 70.4 | 71.1 | -0.7 | -1.0 |
| kitchen3 | length | width + height | 172.7 | 157.5 | +15.2 | +9.6 |
| kitchen3 | width | length + height | 86.6 | 104.1 | -17.6 | -16.9 |
| kitchen3 | height | length + width | 76.1 | 71.1 | +5.0 | +7.0 |
| kitchen4 | length | width + height | 174.6 | 157.5 | +17.1 | +10.9 |
| kitchen4 | width | length + height | 86.1 | 104.1 | -18.1 | -17.3 |
| kitchen4 | height | length + width | 75.5 | 71.1 | +4.4 | +6.2 |

| capture | mean abs error (cm) | max abs error (cm) | final scale fit error: length / width / height (%) |
|---|---|---|---|
| kitchen1 | 10.6 | 15.9 | +3.9 / -11.2 / +5.6 |
| kitchen2_nofar | 2.1 | 4.0 | +1.6 / -1.0 / -0.7 |
| kitchen3 | 12.6 | 17.6 | +6.0 / -12.5 / +4.4 |
| kitchen4 | 13.2 | 18.1 | +6.7 / -12.9 / +3.9 |

**Reading it.** The height agrees with the length to about 3 % in every capture, so the scale and the floor plane hold.
The width is 15-18 % short in three of the four: that is the same table measured the same way, so either the 41 in tape reading
is wrong or the tabletop patch loses its edges in the splat (kitchen3's note: patch cut off on one side). Until the table is
re-measured (BLOCKERS #1) the width fold is the large one and a scale from `length + height` is the one to trust; the
final scale fits all three, so a bad width pulls it. kitchen2_nofar, whose orbit saw the table from all sides, agrees within 3 %.
