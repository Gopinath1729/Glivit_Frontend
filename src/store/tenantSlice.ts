import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { AuthUser, TenantSummary } from '@/src/types/api';

/**
 * Centralised active-tenant state.
 *
 * This is the single place any screen asks "which tenant am I looking at?". Nothing
 * else in the app derives tenancy on its own, which is what stops a screen from
 * rendering one tenant's data while the rest of the app has moved to another.
 *
 * `epoch` is the mechanism behind that guarantee. It increases on every completed
 * switch, and it is used three ways:
 *   - screens key their local state off it, so component state resets automatically
 *     when the tenant changes (see `useTenantEpoch`);
 *   - the shared base query records the epoch a request was issued under and
 *     discards any response that arrives after a switch;
 *   - persistent-storage keys are namespaced by tenant, so cached values from a
 *     previous tenant can never be read back.
 */
export type TenantSwitchStatus = 'idle' | 'switching' | 'error';

export type TenantState = {
  activeTenantId: number | null;
  activeTenantCode: string | null;
  activeTenantName: string | null;
  activeCompanyName: string | null;
  /** Increments on every successful switch; never decreases within a session. */
  epoch: number;
  status: TenantSwitchStatus;
  /** Tenant being switched into, so the loader can name it. */
  pendingTenantId: number | null;
  pendingTenantName: string | null;
  error: string | null;
};

const initialState: TenantState = {
  activeTenantId: null,
  activeTenantCode: null,
  activeTenantName: null,
  activeCompanyName: null,
  epoch: 0,
  status: 'idle',
  pendingTenantId: null,
  pendingTenantName: null,
  error: null,
};

function applyUser(state: TenantState, user: AuthUser | null) {
  if (!user || !Number.isSafeInteger(user.tenantId) || user.tenantId <= 0) {
    state.activeTenantId = null;
    state.activeTenantCode = null;
    state.activeTenantName = null;
    state.activeCompanyName = null;
    return;
  }
  state.activeTenantId = user.tenantId;
  state.activeTenantCode = user.tenantCode ?? state.activeTenantCode;
  state.activeTenantName = user.tenantName ?? state.activeTenantName;
  state.activeCompanyName = user.companyName ?? state.activeCompanyName;
}

const tenantSlice = createSlice({
  name: 'tenant',
  initialState,
  reducers: {
    /**
     * Adopts the tenant carried by an authenticated session. Used at login, after a
     * token refresh and on app start, so the active tenant always comes from a
     * server-signed session rather than from anything the client remembered.
     */
    adoptSessionTenant(state, action: PayloadAction<AuthUser | null>) {
      applyUser(state, action.payload);
      state.status = 'idle';
      state.pendingTenantId = null;
      state.pendingTenantName = null;
      state.error = null;
    },
    switchStarted(state, action: PayloadAction<{ tenantId: number; tenantName: string }>) {
      state.status = 'switching';
      state.pendingTenantId = action.payload.tenantId;
      state.pendingTenantName = action.payload.tenantName;
      state.error = null;
    },
    /**
     * Commits a switch and invalidates everything keyed by the old epoch.
     *
     * `status` deliberately stays `switching`: the epoch bump remounts the navigator
     * and clears every cache, and the switching overlay must keep covering the screen
     * through that until `switchCompleted` lands. Dropping to `idle` here would flash
     * a half-initialised app between the commit and the navigation.
     */
    switchSucceeded(
      state,
      action: PayloadAction<{ user: AuthUser; tenant: TenantSummary }>
    ) {
      applyUser(state, action.payload.user);
      state.activeTenantCode = action.payload.tenant.tenantId;
      state.activeTenantName = action.payload.tenant.name;
      state.activeCompanyName = action.payload.tenant.companyName;
      state.epoch += 1;
      state.status = 'switching';
      state.error = null;
    },
    /** The new tenant is initialised and navigated to; the overlay can come down. */
    switchCompleted(state) {
      state.status = 'idle';
      state.pendingTenantId = null;
      state.pendingTenantName = null;
      state.error = null;
    },
    /**
     * Restores the previous tenant after a failed switch.
     *
     * The epoch deliberately does NOT advance. A failed switch changes nothing about
     * which tenant is active — the server-side switch is transactional and the client
     * commits nothing until it succeeds — so remounting the navigator would throw the
     * user off the screen they are retrying from for no reason. Only the error is
     * recorded; the previous tenant identity is re-asserted from the live session.
     */
    switchFailed(state, action: PayloadAction<{ user: AuthUser | null; message: string }>) {
      applyUser(state, action.payload.user);
      state.status = 'error';
      state.pendingTenantId = null;
      state.pendingTenantName = null;
      state.error = action.payload.message;
    },
    switchErrorCleared(state) {
      state.status = 'idle';
      state.error = null;
    },
    clearActiveTenant() {
      // A new epoch is not needed: the session is gone, so nothing can read on.
      return { ...initialState };
    },
  },
});

export const {
  adoptSessionTenant,
  switchStarted,
  switchSucceeded,
  switchCompleted,
  switchFailed,
  switchErrorCleared,
  clearActiveTenant,
} = tenantSlice.actions;
export default tenantSlice.reducer;
