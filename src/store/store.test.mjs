import assert from 'node:assert/strict';
import test from 'node:test';

import authReducer, {
  clearSession,
  clearTenant,
  hydrate,
  setActiveTenantSession,
  setCredentials,
  setTenant,
} from './authState.ts';
import liveVehiclesReducer, {
  livePositionReceived,
  liveVehiclesCleared,
  liveVehiclesSeeded,
} from './liveVehiclesState.ts';
import notificationsReducer, { markNotificationsRead } from './notificationsState.ts';
import tenantReducer, {
  adoptSessionTenant,
  clearActiveTenant,
  switchCompleted,
  switchFailed,
  switchStarted,
  switchSucceeded,
} from './tenantState.ts';
import { store } from './store.ts';

const INIT = { type: '@@init' };

function user(overrides = {}) {
  return {
    id: 7,
    tenantId: 42,
    tenantCode: 'ACME01',
    tenantName: 'Acme Fleet',
    companyName: 'Acme Ltd',
    username: 'driver@acme.test',
    name: 'Driver',
    role: 'COMPANY_USER',
    permissions: { manage_devices: true },
    ...overrides,
  };
}

function tenantConfig(companyCode = 'ACME01') {
  return {
    companyCode,
    name: 'Acme Fleet',
    appName: 'Glivt',
    primaryColor: '#0F172A',
    secondaryColor: '#1E293B',
    enabledModules: ['LIVE_TRACKING'],
    paymentEnabled: false,
    maxHistoryDays: 90,
    status: 'ACTIVE',
  };
}

function tenantSummary(overrides = {}) {
  return {
    id: 99,
    tenantId: 'BETA01',
    name: 'Beta Logistics',
    companyName: 'Beta Ltd',
    status: 'ACTIVE',
    current: false,
    canDelete: false,
    ...overrides,
  };
}

/** A signed-in state, built the way the app builds it. */
function signedIn() {
  let state = authReducer(undefined, INIT);
  state = authReducer(state, setTenant({ companyCode: 'ACME01', tenantConfig: tenantConfig() }));
  return authReducer(
    state,
    setCredentials({
      accessToken: 'access-1',
      companyCode: 'ACME01',
      refreshToken: 'refresh-1',
      user: user(),
    })
  );
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

test('an action a reducer does not handle leaves the state object untouched', () => {
  const state = signedIn();
  assert.equal(authReducer(state, { type: 'liveVehicles/liveVehiclesCleared' }), state);
  assert.equal(tenantReducer(tenantReducer(undefined, INIT), { type: 'auth/clearSession' }) !== null, true);
});

test('a state change always produces a new object, never a mutated one', () => {
  const before = signedIn();
  const snapshot = JSON.parse(JSON.stringify(before));
  const after = authReducer(before, clearSession());
  assert.notEqual(after, before);
  assert.deepEqual(JSON.parse(JSON.stringify(before)), snapshot);
});

test('hydrate normalizes the persisted company codes', () => {
  const state = authReducer(
    undefined,
    hydrate({ companyCode: '  acme01 ', homeCompanyCode: ' acme01' })
  );
  assert.equal(state.companyCode, 'ACME01');
  assert.equal(state.homeCompanyCode, 'ACME01');
  assert.equal(state.bootstrapped, true);
});

test('hydrate discards a restored session whose company code does not match its token', () => {
  const state = authReducer(
    undefined,
    hydrate({
      companyCode: 'ACME01',
      // Signed in against a different tenant than the one selected.
      sessionCompanyCode: 'BETA01',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      user: user(),
    })
  );
  assert.equal(state.accessToken, null);
  assert.equal(state.refreshToken, null);
  assert.equal(state.user, null);
  assert.equal(state.sessionCompanyCode, null);
  // The tenant selection itself survives, so the app lands on Login, not on
  // the company-code screen.
  assert.equal(state.companyCode, 'ACME01');
});

test('hydrate keeps a session that hangs together', () => {
  const state = authReducer(
    undefined,
    hydrate({
      companyCode: 'ACME01',
      sessionCompanyCode: 'ACME01',
      tenantConfig: tenantConfig(),
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      user: user(),
    })
  );
  assert.equal(state.accessToken, 'access-1');
  assert.equal(state.user.tenantId, 42);
});

test('setCredentials rejects a user with no usable tenant id', () => {
  const state = authReducer(
    signedIn(),
    setCredentials({
      accessToken: 'access-2',
      companyCode: 'ACME01',
      refreshToken: 'refresh-2',
      user: user({ tenantId: 0 }),
    })
  );
  assert.equal(state.accessToken, null);
  assert.equal(state.user, null);
});

test('a token refresh does not re-home a user who is viewing another tenant', () => {
  let state = signedIn();
  state = authReducer(
    state,
    setActiveTenantSession({
      accessToken: 'access-beta',
      refreshToken: 'refresh-beta',
      tenantConfig: tenantConfig('BETA01'),
      user: user({ tenantId: 99, tenantCode: 'BETA01' }),
    })
  );
  assert.equal(state.companyCode, 'BETA01');
  assert.equal(state.homeCompanyCode, 'ACME01');

  // A refresh arrives for the switched-into session.
  state = authReducer(
    state,
    setCredentials({
      accessToken: 'access-beta-2',
      companyCode: 'BETA01',
      refreshToken: 'refresh-beta-2',
      user: user({ tenantId: 99, tenantCode: 'BETA01' }),
    })
  );
  assert.equal(state.accessToken, 'access-beta-2');
  assert.equal(state.homeCompanyCode, 'ACME01', 'home tenant must survive a refresh');
});

test('signing out returns to the home tenant, not the one last viewed', () => {
  let state = signedIn();
  state = authReducer(
    state,
    setActiveTenantSession({
      accessToken: 'access-beta',
      refreshToken: 'refresh-beta',
      tenantConfig: tenantConfig('BETA01'),
      user: user({ tenantId: 99 }),
    })
  );
  state = authReducer(state, clearSession());
  assert.equal(state.companyCode, 'ACME01');
  assert.equal(state.tenantConfig.companyCode, 'ACME01');
  assert.equal(state.accessToken, null);
});

test('clearing an already-cleared session changes nothing', () => {
  const once = authReducer(signedIn(), clearSession());
  assert.equal(authReducer(once, clearSession()), once);
});

test('setTenant ignores a blank company code', () => {
  const before = authReducer(undefined, INIT);
  assert.equal(authReducer(before, setTenant({ companyCode: '   ', tenantConfig: tenantConfig() })), before);
});

test('clearTenant forgets both the active and the home tenant', () => {
  const state = authReducer(signedIn(), clearTenant());
  assert.equal(state.companyCode, null);
  assert.equal(state.tenantConfig, null);
  assert.equal(state.homeCompanyCode, null);
  assert.equal(state.homeTenantConfig, null);
});

// ---------------------------------------------------------------------------
// tenant
// ---------------------------------------------------------------------------

test('a completed switch advances the epoch and keeps the overlay up', () => {
  let state = tenantReducer(undefined, adoptSessionTenant(user()));
  assert.equal(state.epoch, 0);
  assert.equal(state.activeTenantId, 42);

  state = tenantReducer(state, switchStarted({ tenantId: 99, tenantName: 'Beta Logistics' }));
  assert.equal(state.status, 'switching');
  assert.equal(state.pendingTenantName, 'Beta Logistics');

  state = tenantReducer(
    state,
    switchSucceeded({ user: user({ tenantId: 99 }), tenant: tenantSummary() })
  );
  assert.equal(state.epoch, 1);
  assert.equal(state.activeTenantId, 99);
  assert.equal(state.activeTenantCode, 'BETA01');
  assert.equal(state.status, 'switching', 'the overlay must stay up until the switch completes');

  state = tenantReducer(state, switchCompleted());
  assert.equal(state.status, 'idle');
  assert.equal(state.pendingTenantId, null);
});

test('a failed switch records the error without advancing the epoch', () => {
  let state = tenantReducer(undefined, adoptSessionTenant(user()));
  state = tenantReducer(state, switchStarted({ tenantId: 99, tenantName: 'Beta Logistics' }));
  state = tenantReducer(state, switchFailed({ user: user(), message: 'Not authorised' }));

  assert.equal(state.epoch, 0, 'a failed switch must not remount the navigator');
  assert.equal(state.status, 'error');
  assert.equal(state.error, 'Not authorised');
  assert.equal(state.activeTenantId, 42, 'the previous tenant is still the active one');
});

test('adopting a session without a user clears the active tenant identity', () => {
  let state = tenantReducer(undefined, adoptSessionTenant(user()));
  state = tenantReducer(state, adoptSessionTenant(null));
  assert.equal(state.activeTenantId, null);
  assert.equal(state.activeTenantCode, null);
});

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

test('read markers are discarded when the tenant changes', () => {
  let state = notificationsReducer(undefined, markNotificationsRead(['event:1', 'maint:2']));
  assert.deepEqual(Object.keys(state.readKeys).sort(), ['event:1', 'maint:2']);

  state = notificationsReducer(
    state,
    switchSucceeded({ user: user({ tenantId: 99 }), tenant: tenantSummary() })
  );
  assert.deepEqual(state.readKeys, {});
});

test('read markers are discarded on sign-out and on a failed switch', () => {
  const marked = notificationsReducer(undefined, markNotificationsRead(['event:1']));
  assert.deepEqual(notificationsReducer(marked, clearActiveTenant()).readKeys, {});
  assert.deepEqual(
    notificationsReducer(marked, switchFailed({ user: null, message: 'nope' })).readKeys,
    {}
  );
});

test('marking an already-read notification does not churn subscribers', () => {
  const marked = notificationsReducer(undefined, markNotificationsRead(['event:1']));
  assert.equal(notificationsReducer(marked, markNotificationsRead(['event:1'])), marked);
});

// ---------------------------------------------------------------------------
// live vehicles
// ---------------------------------------------------------------------------

const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function packet(overrides = {}) {
  return {
    deviceId: 1,
    vehicleId: 5,
    positionUpdate: true,
    latitude: 12.9716,
    longitude: 77.5946,
    matchedLatitude: null,
    matchedLongitude: null,
    matchConfidence: null,
    roadBearing: null,
    speedKmh: 40,
    tripDistanceKm: 3,
    course: 90,
    accuracyMeters: 8,
    ignition: true,
    gpsValid: true,
    state: 'RUNNING',
    connectionState: 'ONLINE',
    address: 'MG Road',
    lastGpsTime: iso(-1000),
    deviceTime: iso(-1000),
    serverTime: iso(-500),
    lastServerReceivedTime: iso(-500),
    ...overrides,
  };
}

test('a first packet creates the vehicle at its reported position', () => {
  const state = liveVehiclesReducer(undefined, livePositionReceived(packet()));
  const vehicle = state.byDeviceId[1];
  assert.equal(vehicle.latitude, 12.9716);
  assert.equal(vehicle.address, 'MG Road');
  assert.equal(state.version, 1);
});

test('an out-of-order packet updates the connection clock but never the position', () => {
  let state = liveVehiclesReducer(undefined, livePositionReceived(packet()));
  const first = state.byDeviceId[1];

  state = liveVehiclesReducer(
    state,
    livePositionReceived(
      packet({
        latitude: 13.5,
        longitude: 78.5,
        // Older than the stored fix.
        lastGpsTime: iso(-60_000),
        deviceTime: iso(-60_000),
        state: 'STOPPED',
      })
    )
  );

  const after = state.byDeviceId[1];
  assert.equal(after.latitude, first.latitude, 'a late packet must not move the marker');
  assert.equal(after.longitude, first.longitude);
  assert.equal(after.state, 'STOPPED', 'but it is still evidence the device is reachable');
});

test('a packet without a position update never re-stamps freshness of the fix', () => {
  let state = liveVehiclesReducer(undefined, livePositionReceived(packet()));
  const before = state.byDeviceId[1];

  state = liveVehiclesReducer(
    state,
    livePositionReceived(packet({ positionUpdate: false, state: 'IDLE', address: null }))
  );

  const after = state.byDeviceId[1];
  assert.equal(after.lastGpsAt, before.lastGpsAt);
  assert.equal(after.state, 'IDLE');
  assert.equal(after.address, 'MG Road', 'an update without an address must not blank it');
});

test('an implausible jump is rejected as a position', () => {
  let state = liveVehiclesReducer(undefined, livePositionReceived(packet()));
  state = liveVehiclesReducer(
    state,
    // ~600 km away, one second later.
    livePositionReceived(packet({ latitude: 18.5, longitude: 73.8, lastGpsTime: iso(0), deviceTime: iso(0) }))
  );
  assert.equal(state.byDeviceId[1].latitude, 12.9716);
});

test('a stationary vehicle is pinned rather than jittered', () => {
  let state = liveVehiclesReducer(undefined, livePositionReceived(packet({ speedKmh: 0 })));
  const before = state.byDeviceId[1];

  state = liveVehiclesReducer(
    state,
    livePositionReceived(
      packet({
        speedKmh: 1,
        // ~5 m of drift.
        latitude: 12.9716 + 0.00005,
        lastGpsTime: iso(5_000),
        deviceTime: iso(5_000),
      })
    )
  );

  const after = state.byDeviceId[1];
  assert.equal(after.latitude, before.latitude);
  assert.equal(after.speedKmh, 0);
});

test('a low-confidence road match is not drawn', () => {
  const state = liveVehiclesReducer(
    undefined,
    livePositionReceived(
      packet({ matchedLatitude: 12.9717, matchedLongitude: 77.5947, matchConfidence: 0.1 })
    )
  );
  assert.equal(state.byDeviceId[1].latitude, 12.9716);
  assert.equal(state.byDeviceId[1].matchedLatitude, null);
});

test('a confident, nearby road match is what gets drawn', () => {
  const state = liveVehiclesReducer(
    undefined,
    livePositionReceived(
      packet({ matchedLatitude: 12.97165, matchedLongitude: 77.59465, matchConfidence: 0.9 })
    )
  );
  assert.equal(state.byDeviceId[1].latitude, 12.97165);
  assert.equal(state.byDeviceId[1].rawLatitude, 12.9716, 'the raw fix is still recorded');
});

test('an unmatched update holds the previous matched road coordinate', () => {
  let state = liveVehiclesReducer(
    undefined,
    livePositionReceived(
      packet({
        matchedLatitude: 12.97165,
        matchedLongitude: 77.59465,
        matchConfidence: 0.9,
        matchedSource: 'SOLVED',
      })
    )
  );
  state = liveVehiclesReducer(
    state,
    livePositionReceived(
      packet({
        latitude: 12.9718,
        longitude: 77.5948,
        lastGpsTime: iso(2_000),
        deviceTime: iso(2_000),
        matchedLatitude: 12.97165,
        matchedLongitude: 77.59465,
        matchConfidence: 0.9,
        matchedSource: 'HELD',
      })
    )
  );

  assert.equal(state.byDeviceId[1].latitude, 12.97165);
  assert.equal(state.byDeviceId[1].longitude, 77.59465);
});

test('the polled roster seeds unknown vehicles but never moves a live one', () => {
  let state = liveVehiclesReducer(undefined, livePositionReceived(packet()));
  state = liveVehiclesReducer(
    state,
    liveVehiclesSeeded([
      // Already live: a stale polled position must not win.
      { deviceId: 1, latitude: 1, longitude: 1, state: 'STOPPED' },
      { deviceId: 2, latitude: 12.5, longitude: 77.5, state: 'RUNNING' },
      // No usable coordinate: nothing to place on the map.
      { deviceId: 3, latitude: null, longitude: null },
    ])
  );

  assert.equal(state.byDeviceId[1].latitude, 12.9716);
  assert.equal(state.byDeviceId[1].state, 'STOPPED', 'metadata may still refresh');
  assert.equal(state.byDeviceId[2].latitude, 12.5);
  assert.equal(state.byDeviceId[3], undefined);
});

test('seeding nothing new leaves the state object untouched', () => {
  const state = liveVehiclesReducer(undefined, livePositionReceived(packet()));
  assert.equal(liveVehiclesReducer(state, liveVehiclesSeeded([{ deviceId: 3 }])), state);
});

test('a tenant switch empties the live map before any screen can re-render', () => {
  const state = liveVehiclesReducer(undefined, livePositionReceived(packet()));
  const switched = liveVehiclesReducer(
    state,
    switchSucceeded({ user: user({ tenantId: 99 }), tenant: tenantSummary() })
  );
  assert.deepEqual(switched.byDeviceId, {});
  assert.deepEqual(
    liveVehiclesReducer(state, clearActiveTenant()).byDeviceId,
    {}
  );
  assert.deepEqual(liveVehiclesReducer(state, liveVehiclesCleared()).byDeviceId, {});
});

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

test('one action reaches every reducer, so tenant-owned state clears together', () => {
  store.dispatch(setTenant({ companyCode: 'ACME01', tenantConfig: tenantConfig() }));
  store.dispatch(
    setCredentials({
      accessToken: 'access-1',
      companyCode: 'ACME01',
      refreshToken: 'refresh-1',
      user: user(),
    })
  );
  store.dispatch(adoptSessionTenant(user()));
  store.dispatch(markNotificationsRead(['event:1']));
  store.dispatch(livePositionReceived(packet()));

  assert.equal(store.getState().tenant.activeTenantId, 42);
  assert.equal(Object.keys(store.getState().notifications.readKeys).length, 1);
  assert.equal(Object.keys(store.getState().liveVehicles.byDeviceId).length, 1);

  store.dispatch(switchSucceeded({ user: user({ tenantId: 99 }), tenant: tenantSummary() }));

  const after = store.getState();
  assert.equal(after.tenant.activeTenantId, 99);
  assert.equal(after.tenant.epoch, 1);
  assert.deepEqual(after.notifications.readKeys, {});
  assert.deepEqual(after.liveVehicles.byDeviceId, {});
});

test('subscribers are notified for a real change and left alone for a no-op', () => {
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  store.dispatch(markNotificationsRead(['event:99']));
  assert.equal(notifications, 1);

  // Already read: nothing changes, so nothing is notified.
  store.dispatch(markNotificationsRead(['event:99']));
  assert.equal(notifications, 1);

  unsubscribe();
  store.dispatch(markNotificationsRead(['event:100']));
  assert.equal(notifications, 1, 'an unsubscribed listener must not be called');
});

test('a listener that unsubscribes during notification does not skip the next one', () => {
  const called = [];
  const offA = store.subscribe(() => {
    called.push('a');
    offA();
  });
  const offB = store.subscribe(() => called.push('b'));

  store.dispatch(markNotificationsRead(['event:200']));
  assert.deepEqual(called, ['a', 'b']);
  offB();
});
