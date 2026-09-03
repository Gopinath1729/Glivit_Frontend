import type { AnyAction } from '@/src/store/action';
import authReducer, { type AuthAction, type AuthState } from '@/src/store/authState';
import liveVehiclesReducer, {
  type LiveVehiclesAction,
  type LiveVehiclesState,
} from '@/src/store/liveVehiclesState';
import notificationsReducer, {
  type NotificationsAction,
  type NotificationsState,
} from '@/src/store/notificationsState';
import tenantReducer, { type TenantAction, type TenantState } from '@/src/store/tenantState';

/**
 * The application store.
 *
 * <p>A single immutable state tree, updated only by dispatching an action, read
 * through {@link useAppSelector}. It is deliberately small and dependency-free:
 * the app needs shared session and tenant state that survives navigation, and
 * nothing more.
 *
 * <h3>Why every reducer sees every action</h3>
 * Reducers are composed, not isolated. `tenant/switchSucceeded` is dispatched
 * once and handled by three of them — which is what guarantees that the moment
 * a switch is recorded, the notification read-markers and the live vehicle map
 * belonging to the previous tenant are already gone. There is no ordering to
 * get wrong and no screen effect that can be forgotten.
 *
 * <h3>Identity is the change signal</h3>
 * A reducer that has nothing to do returns the state object it was given. When
 * every reducer does that, the tree is unchanged and no subscriber is notified,
 * so an action that changes nothing costs nothing. Conversely, any reducer that
 * does change something must return a new object: subscribers compare by
 * reference, and mutating in place would leave the screen showing stale data.
 */
export type RootState = {
  auth: AuthState;
  tenant: TenantState;
  notifications: NotificationsState;
  liveVehicles: LiveVehiclesState;
};

/** Every action the app can dispatch. */
export type AppAction = AuthAction | TenantAction | NotificationsAction | LiveVehiclesAction;

/** Dispatched once at start-up so each reducer can publish its initial state. */
const INIT: AnyAction = { type: '@@init' };

function rootReducer(state: RootState | undefined, action: AnyAction): RootState {
  const auth = authReducer(state?.auth, action);
  const tenant = tenantReducer(state?.tenant, action);
  const notifications = notificationsReducer(state?.notifications, action);
  const liveVehicles = liveVehiclesReducer(state?.liveVehicles, action);

  if (
    state &&
    auth === state.auth &&
    tenant === state.tenant &&
    notifications === state.notifications &&
    liveVehicles === state.liveVehicles
  ) {
    return state;
  }
  return { auth, tenant, notifications, liveVehicles };
}

let state: RootState = rootReducer(undefined, INIT);
const listeners = new Set<() => void>();

function getState(): RootState {
  return state;
}

function dispatch<Action extends AppAction>(action: Action): Action {
  const next = rootReducer(state, action);
  if (next !== state) {
    state = next;
    // Copied before iterating: a listener is free to unsubscribe — React does
    // exactly that when a notified component unmounts — and mutating the set
    // mid-iteration would skip whoever follows it.
    for (const listener of Array.from(listeners)) listener();
  }
  return action;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const store = { getState, dispatch, subscribe };

export type AppDispatch = typeof dispatch;
