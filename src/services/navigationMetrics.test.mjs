import assert from 'node:assert/strict';
import test from 'node:test';

const { formatRouteDistance, formatRouteDuration, formatRouteMetrics } =
  await import('./navigationMetrics.ts');

test('converts provider duration seconds to minutes and hours consistently', () => {
  assert.equal(formatRouteDuration(1), '1 min');
  assert.equal(formatRouteDuration(61), '2 min');
  assert.equal(formatRouteDuration(3_601), '1 h 1 min');
});

test('uses provider metres and seconds in the shared route label', () => {
  assert.equal(formatRouteDistance(12_960), '13 km');
  assert.equal(formatRouteMetrics(12_960, 661), '12 min\n13 km');
});
