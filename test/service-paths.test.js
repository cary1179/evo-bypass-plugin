import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveServicePaths } from '../src/core/service-paths.js';

test('resolveServicePaths returns service and jobs paths under .bypass', () => {
  const root = '/tmp/evo-root';
  const paths = resolveServicePaths({ root });

  assert.equal(paths.root, root);
  assert.equal(paths.bypassDir, path.join(root, '.bypass'));
  assert.equal(paths.serviceDir, path.join(root, '.bypass', 'service'));
  assert.equal(paths.jobsDir, path.join(root, '.bypass', 'jobs'));
  assert.equal(paths.serviceUrlPath, path.join(root, '.bypass', 'service', 'service-url'));
  assert.equal(paths.servicePidPath, path.join(root, '.bypass', 'service', 'service.pid'));
  assert.equal(paths.serviceLogPath, path.join(root, '.bypass', 'service', 'service.log'));
});
