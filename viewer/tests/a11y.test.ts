// Display preferences are pure and the theme colors live in frontend.css, so both are checked here without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_PREFS, parsePrefs, reducedMotion, resolveTheme, TEXT_SCALE } from '../src/a11y.ts';

test('parsePrefs falls back to defaults for missing, broken or unknown values', () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs('{not json'), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs('[1,2]'), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs('{"text":"huge","theme":"neon","reduceMotion":"yes"}'), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs('{"text":"larger","theme":"light","reduceMotion":true}'), { text: 'larger', theme: 'light', reduceMotion: true });
});

test('theme: a choice wins, otherwise the device contrast setting, otherwise dark', () => {
  assert.equal(resolveTheme({ ...DEFAULT_PREFS }, false), 'dark');
  assert.equal(resolveTheme({ ...DEFAULT_PREFS }, true), 'contrast');
  assert.equal(resolveTheme({ ...DEFAULT_PREFS, theme: 'light' }, true), 'light');
});

test('reduced motion is on when either the person or the device asks', () => {
  assert.equal(reducedMotion(DEFAULT_PREFS, false), false);
  assert.equal(reducedMotion(DEFAULT_PREFS, true), true);
  assert.equal(reducedMotion({ ...DEFAULT_PREFS, reduceMotion: true }, false), true);
});

test('text sizes grow and the default is exactly 1', () => {
  assert.equal(TEXT_SCALE.default, 1);
  assert.ok(TEXT_SCALE.large > 1 && TEXT_SCALE.larger > TEXT_SCALE.large);
});

// --- WCAG contrast of the text/background pairs the CSS tokens define, per theme ---
const css = readFileSync(new URL('../src/frontend.css', import.meta.url), 'utf8');
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector + ' {'); assert.ok(start >= 0, `missing ${selector}`);
  const body = css.slice(start + selector.length + 2, css.indexOf('\n}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
}
function rgb(c: string): [number, number, number] {
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) { const h = hex[1].length === 3 ? [...hex[1]].map(x => x + x).join('') : hex[1]; return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]; }
  const f = c.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/); assert.ok(f, `cannot read color ${c}`); return [+f[1], +f[2], +f[3]];
}
const luminance = (c: string) => { const [r, g, b] = rgb(c).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + .05) / (lo + .05); };

const dark = tokens('.frontend');
const themes: Record<string, Record<string, string>> = {
  dark,
  light: { ...dark, ...tokens('.frontend[data-theme="light"] #frontend') },
  contrast: { ...dark, ...tokens('.frontend[data-theme="contrast"] #frontend') },
};
const PAIRS: [string, string][] = [
  ['text', 'floating'], ['text-2', 'floating'], ['muted', 'floating'], ['soft', 'floating'], ['accent', 'floating'], ['badge-fg', 'floating'], ['imag-text', 'floating'],
  ['muted', 'card'], ['text-2', 'card'], ['muted', 'cell'], ['soft', 'cell'], ['text', 'btn'], ['text', 'btn-hover'], ['text', 'field'], ['soft', 'well'],
  ['on-accent', 'accent'], ['on-accent', 'accent-hover'], ['pressed-fg', 'pressed-bg'], ['amber-fg', 'amber-bg'], ['text', 'banner-bg'], ['muted', 'rec-a'], ['text-2', 'rec-b'],
];
for (const [name, t] of Object.entries(themes)) {
  test(`${name} theme: text pairs reach 4.5:1`, () => {
    for (const [fg, bg] of PAIRS) assert.ok(contrast(t[fg], t[bg]) >= 4.5, `${name}: ${fg} ${t[fg]} on ${bg} ${t[bg]} = ${contrast(t[fg], t[bg]).toFixed(2)}`);
  });
}
test('high contrast reaches 7:1 for body text and the focus ring is visible against the surface', () => {
  const t = themes.contrast;
  for (const [fg, bg] of [['text', 'floating'], ['muted', 'floating'], ['soft', 'cell'], ['pressed-fg', 'pressed-bg']]) assert.ok(contrast(t[fg], t[bg]) >= 7, `${fg} on ${bg}`);
  assert.ok(contrast(t.accent, t.floating) >= 3);
});
test('no frontend rule sets a font size below 12px', () => {
  for (const m of css.matchAll(/font-size:\s*calc\(([\d.]+)rem/g)) assert.ok(+m[1] * 16 >= 12, `font-size ${m[1]}rem`);
  assert.ok(!/font-size:\s*\d+px/.test(css), 'font sizes should be rem so they follow the browser setting');
});
