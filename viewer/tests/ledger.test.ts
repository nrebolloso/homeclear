// The log: append-only, retrieval filters, a re-run supersedes, broken lines never break loading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logEvent, parseLog, retrieve, toJSONL, type Entry } from '../src/ledger.ts';

test('latest keeps the newest entry per kind and key; plain retrieve keeps them all', () => {
  const log: Entry[] = [];
  logEvent(log, 'viewer', 'mass', { mass_kg: 20 }, 'guess', 'chair');
  logEvent(log, 'viewer', 'mass', { mass_kg: 31 }, 'computed', 'table');
  logEvent(log, 'viewer', 'mass', { mass_kg: 7 }, 'computed', 'chair');
  logEvent(log, 'stage12', 'export', { objects: 3 }, 'measured');
  assert.equal(retrieve(log, { kind: 'mass' }).length, 3);
  const last = retrieve(log, { kind: 'mass', latest: true });
  assert.equal(last.length, 2);
  assert.equal(last.find(e => e.key === 'chair')!.values.mass_kg, 7);
  assert.deepEqual(retrieve(log, { source: 'stage12' }).map(e => e.kind), ['export']);
});

test('JSON lines round-trip; blank and half-written lines are skipped', () => {
  const log: Entry[] = [];
  logEvent(log, 'viewer', 'option', { name: 'Quick' }, 'simulated');
  const text = toJSONL(log) + '\n{"t":"x","sour';
  assert.deepEqual(parseLog(text), log);
  assert.equal(toJSONL([]), '');
});
