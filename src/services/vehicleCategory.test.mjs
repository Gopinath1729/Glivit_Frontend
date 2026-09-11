import assert from 'node:assert/strict';
import test from 'node:test';

import { vehicleBodyType } from './vehicleCategory.ts';

test('keeps the three supported body types', () => {
  assert.equal(vehicleBodyType('CAR'), 'CAR');
  assert.equal(vehicleBodyType('bike'), 'BIKE');
  assert.equal(vehicleBodyType('TRUCK'), 'TRUCK');
});

test('maps legacy categories onto a supported 3D body', () => {
  assert.equal(vehicleBodyType('scooter'), 'BIKE');
  assert.equal(vehicleBodyType('bus'), 'TRUCK');
  assert.equal(vehicleBodyType('trailer'), 'TRUCK');
  assert.equal(vehicleBodyType('van'), 'CAR');
  assert.equal(vehicleBodyType(undefined), 'CAR');
});
