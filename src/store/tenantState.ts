import type { AnyAction } from '@/src/store/action';
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

/**
 * Action types other reducers react to.
 *
 * Tenant-owned state elsewhere in the app resets itself on these rather than
 * waiting for a screen effect, so the state is already empty by the time
 * anything re-renders and no component can show the previous tenant's data.
 */
export const SWITCH_SUCCEEDED = 'tenant/switchSucceeded';
export const SWITCH_FAILED = 'tenant/switchFailed';
export const CLEAR_ACTIVE_TENANT = 'tenant/clearActiveTenant';

export type TenantAction =
  | { type: 'tenant/adoptSessionTenant'; payload: AuthUser | null }
  | { type: 'tenant/switchStarted'; payload: { tenantId: number; tenantName: string } }
  | { type: typeof SWITCH_SUCCEEDED; payload: { user: AuthUser; tenant: TenantSummary } }
  | { type: 'tenant/switchCompleted'; payload?: undefined }
  | { type: typeof SWITCH_FAILED; payload: { user: AuthUser | null; message: string } }
  | { type: 'tenant/switchErrorCleared'; payload?: undefined }
  | { type: typeof CLEAR_ACTIVE_TENANT; payload?: undefined };

/**
 * Adopts the tenant carried by an authenticated session. Used at login, after a
 * token refresh and on app start, so the active tenant always comes from a
 * server-signed session rather than from anything the client remembered.
 */
export const adoptSessionTenant = (payload: AuthUser | null): TenantAction => ({
  type: 'tenant/adoptSessionTenant',
  payload,
});

export const switchStarted = (payload: {
  tenantId: number;
  tenantName: string;
}): TenantAction => ({ type: 'tenant/switchStarted', payload });

export const switchSucceeded = (payload: {
  user: AuthUser;
  tenant: TenantSummary;
}): TenantAction => ({ type: SWITCH_SUCCEEDED, payload });

/** The new tenant is initialised and navigated to; the overlay can come down. */
export const switchCompleted = (): TenantAction => ({ type: 'tenant/switchCompleted' });

export const switchFailed = (payload: {
  user: AuthUser | null;
  message: string;
}): TenantAction => ({ type: SWITCH_FAILED, payload });

export const switchErrorCleared = (): TenantAction => ({ type: 'tenant/switchErrorCleared' });

export const clearActiveTenant = (): TenantAction => ({ type: CLEAR_ACTIVE_TENANT });

function isTenantAction(action: AnyAction): action is TenantAction {
  return action.type.startsWith('tenant/');
}

function applyUser(state: TenantState, user: AuthUser | null): TenantState {
  if (!user || !Number.isSafeInteger(user.tenantId) || user.tenantId <= 0) {
    return {
      ...state,
      activeTenantId: null,
      activeTenantCode: null,
      activeTenantName: null,
      activeCompanyName: null,
    };
  }
  return {
    ...state,
    activeTenantId: user.tenantId,
    activeTenantCode: user.tenantCode ?? state.activeTenantCode,
    activeTenantName: user.tenantName ?? state.activeTenantName,
    activeCompanyName: user.companyName ?? state.activeCompanyName,
  };
}

export default function tenantReducer(
  state: TenantState = initialState,
  action: AnyAction
): TenantState {
  if (!isTenantAction(action)) return state;

  switch (action.type) {
    case 'tenant/adoptSessionTenant':
      return {
        ...applyUser(state, action.payload),
        status: 'idle',
        pendingTenantId: null,
        pendingTenantName: null,
        error: null,
      };

    case 'tenant/switchStarted':
      return {
        ...state,
        status: 'switching',
        pendingTenantId: action.payload.tenantId,
        pendingTenantName: action.payload.tenantName,
        error: null,
      };

    /**
     * Commits a switch and invalidates everything keyed by the old epoch.
     *
     * `status` deliberately stays `switching`: the epoch bump remounts the
     * navigator and clears every cache, and the switching overlay must keep
     * covering the screen through that until `switchCompleted` lands. Dropping
     * to `idle` here would flash a half-initialised app between the commit and
     * the navigation.
     */
    case SWITCH_SUCCEEDED: {
      const withUser = applyUser(state, action.payload.user);
      return {
        ...withUser,
        activeTenantCode: action.payload.tenant.tenantId,
        activeTenantName: action.payload.tenant.name,
        activeCompanyName: action.payload.tenant.companyName,
        epoch: state.epoch + 1,
        status: 'switching',
        error: null,
      };
    }

    case 'tenant/switchCompleted':
      return {
        ...state,
        status: 'idle',
        pendingTenantId: null,
        pendingTenantName: null,
        error: null,
      };

    /**
     * Restores the previous tenant after a failed switch.
     *
     * The epoch deliberately does NOT advance. A failed switch changes nothing
     * about which tenant is active — the server-side switch is transactional and
     * the client commits nothing until it succeeds — so remounting the navigator
     * would throw the user off the screen they are retrying from for no reason.
     * Only the error is recorded; the previous tenant identity is re-asserted
     * from the live session.
     */
    case SWITCH_FAILED:
      return {
        ...applyUser(state, action.payload.user),
        status: 'error',
        pendingTenantId: null,
        pendingTenantName: null,
        error: action.payload.message,
      };

    case 'tenant/switchErrorCleared':
      return { ...state, status: 'idle', error: null };

    case CLEAR_ACTIVE_TENANT:
      // A new epoch is not needed: the session is gone, so nothing can read on.
      return { ...initialState };

    default:
      return state;
  }
}
