import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBookmarks } from '../src/bookmarks.ts';
test('viewpoints reject corrupt storage and malformed transforms', () => {
  assert.deepEqual(parseBookmarks('broken'), []);
  assert.deepEqual(parseBookmarks('[{"id":"x","label":"X","position":[0],"quaternion":[0,0,0,1]}]'), []);
  assert.equal(parseBookmarks('[{"id":"x","label":"X","position":[0,1,2],"quaternion":[0,0,0,1]}]').length, 1);
});
