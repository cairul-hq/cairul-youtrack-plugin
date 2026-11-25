import assert from 'node:assert/strict';
import { test } from 'node:test';
import createPlugin from '../index.mjs';

test('the plugin registers executable checks', async () => {
  const plugin = await createPlugin({"baseUrl": "https://example.youtrack.cloud"});
  const kinds = Object.entries(plugin.checkKinds);
  assert.ok(kinds.length > 0);
  for (const [name, check] of kinds) {
    assert.match(name, /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/);
    assert.equal(typeof check.validate, 'function', name);
    assert.equal(typeof check.run, 'function', name);
  }
});
