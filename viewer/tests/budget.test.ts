import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPlan, planOf, type BudgetItem } from '../src/budget.ts';

const it = (id: string, usd: number | undefined, benefit: number, suggested = false): BudgetItem => ({ id, label: id, usd, effort: 1, suggested, benefit });
const items = [it('sug', 300, 0, true), it('cheap', 20, 1), it('dear', 400, 3), it('unpriced', undefined, 9), it('useless', 5, 0)];
test('suggested fixes stay checked even over budget', () => assert.deepEqual(pickPlan(items, 0), ['sug']));
test('extras fill by savings per dollar while they fit; unpriced and useless never auto-checked', () => {
  assert.deepEqual(pickPlan(items, 400), ['sug', 'cheap']);
  assert.deepEqual(pickPlan(items, 800), ['sug', 'cheap', 'dear']);
});
test('the plan for the report totals what is checked', () => {
  const p = planOf(items, ['sug', 'cheap'], 500);
  assert.equal(p.spent, 320); assert.equal(p.items.filter(i => i.checked).length, 2); assert.ok(p.effort_score > 0);
});
