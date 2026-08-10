import { Platform } from 'react-native';

import { apiErrorMessage } from '@/src/services/apiError';
import { authStorage } from '@/src/services/authStorage';
import { abortInFlightRequests, baseApi } from '@/src/services/baseApi';
import { tenantStorage } from '@/src/services/tenantStorage';
import { setActiveTenantSession } from '@/src/store/authSlice';
import {
  switchCompleted,
  switchFailed,
  switchStarted,
  switchSucceeded,
} from '@/src/store/tenantSlice';
import type { AppDispatch, RootState } from '@/src/store/store';
import type { TenantSummary, TenantSwitchResponse } from '@/src/types/api';

export type SwitchTenantOutcome = { ok: true } | { ok: false; message: string };

/**
 * Module-level re-entry guard.
 *
 * The confirmation dialog's Yes button is also disabled while a switch runs, but a
 * guard here covers every entry point: a double tap, a queued gesture and a stray
 * deep link all collapse into one switch instead of two overlapping ones, which
 * would leave the session bound to whichever request happened to finish last.
 */
let switchInProgress = false;

type SwitchTrigger = (args: { id: number; deviceInfo?: string }) => {
  unwrap: () => Promise<TenantSwitchResponse>;
};

/**
 * Switches the active tenant, end to end.
 *
 * Ordering is the whole design here, so it is worth stating plainly:
 *
 *  1. Ask the server FIRST, while the current session is still fully intact. The
 *     server authorises the tenant, revokes the old session and mints one bound to
 *     the new tenant, all in one transaction. Nothing local is torn down yet, so a
 *     rejection (unauthorised, disabled, offline) leaves the app exactly as it was.
 *  2. Cancel every request already on the wire, so no previous-tenant response can
 *     land in the cache the new tenant is about to render from.
 *  3. Persist the new session before touching Redux. Secure storage is the commit
 *     point: if the write fails, the switch is abandoned rather than leaving a live
 *     session that a restart would not remember.
 *  4. Commit the new tenant to Redux (auth + tenant slices in the same tick) and
 *     bump the tenant epoch. From this instant every request carries the new tenant,
 *     every screen keyed on the epoch resets, and every in-flight response from the
 *     old tenant is discarded by the base query.
 *  5. Reset RTK Query completely. Not invalidation — a full reset, so no cached
 *     vehicles, geofences, reports, notifications or dashboard counts from the old
 *     tenant can be shown for even one frame while the new data loads. Screens fall
 *     back to their loading placeholders.
 *  6. Purge the previous tenant's namespaced local storage.
 *  7. Navigate to the new tenant's Live Map, only now that initialisation succeeded.
 *
 * Live GPS / SSE subscriptions need no explicit teardown call: they are keyed on the
 * access token and the tenant epoch, so step 4 closes the old stream and opens a new
 * one under the new tenant context.
 */
export async function switchActiveTenant(params: {
  dispatch: AppDispatch;
  getState: () => RootState;
  target: TenantSummary;
  trigger: SwitchTrigger;
  onNavigate: () => void;
}): Promise<SwitchTenantOutcome> {
  const { dispatch, getState, target, trigger, onNavigate } = params;

  if (switchInProgress) {
    return { ok: false, message: 'A tenant switch is already in progress.' };
  }

  const before = getState();
  const previousTenantId = before.tenant.activeTenantId;
  const previousUser = before.auth.user;

  if (previousTenantId === target.id) {
    return { ok: false, message: `You are already working in ${target.name}.` };
  }

  switchInProgress = true;
  dispatch(switchStarted({ tenantId: target.id, tenantName: target.name }));

  try {
    // 1. Server-side authorisation + new session. Local state untouched so far.
    const response = await trigger({
      id: target.id,
      deviceInfo: `${Platform.OS} app`,
    }).unwrap();

    const { session, tenant, activeTenant } = response;
    if (
      !session?.accessToken ||
      !session.refreshToken ||
      !session.user ||
      session.user.tenantId !== target.id ||
      !tenant?.companyCode
    ) {
      throw new Error('The server returned an incomplete tenant switch response.');
    }

    // 2. Nothing from the previous tenant may still be in flight.
    abortInFlightRequests();

    // 3. Commit point: persist before any in-memory state changes.
    await authStorage.saveSession({
      accessToken: session.accessToken,
      companyCode: tenant.companyCode,
      refreshToken: session.refreshToken,
      user: session.user,
    });
    // Active tenant only: the home tenant that owns this login is unchanged.
    await authStorage.saveActiveTenant(tenant.companyCode, tenant);

    // 4. Commit the new tenant. Both slices in one tick: no render can observe the
    //    new token alongside the old tenant identity, or vice versa.
    dispatch(
      setActiveTenantSession({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        tenantConfig: tenant,
        user: session.user,
      })
    );
    dispatch(switchSucceeded({ user: session.user, tenant: activeTenant }));

    // 5. Drop every cached response. Screens show loading/empty states until the new
    //    tenant's data arrives, rather than the previous tenant's data.
    dispatch(baseApi.util.resetApiState());

    // 6. The previous tenant's cached local values must not be inherited.
    await tenantStorage.clearTenantScope(previousTenantId);

    // 7. Only now is it safe to land on the new tenant's home screen. The overlay is
    //    still up, so nothing half-initialised is ever visible; it comes down once
    //    navigation has been issued.
    onNavigate();
    dispatch(switchCompleted());

    return { ok: true };
  } catch (error) {
    // Restore. The server-side switch is transactional and nothing local is committed
    // until it succeeds, so the previous tenant is still the valid one: re-assert it
    // rather than leaving the app half-switched. The cache is still reset because a
    // failure after step 2 leaves requests that were aborted mid-switch showing as
    // errors; a reset refetches them against the restored tenant.
    const message = errorMessage(error);
    dispatch(switchFailed({ user: previousUser, message }));
    dispatch(baseApi.util.resetApiState());
    return { ok: false, message };
  } finally {
    switchInProgress = false;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return apiErrorMessage(error, 'Could not switch tenant. Please try again.');
}
