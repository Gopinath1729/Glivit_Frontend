import { useCallback, useRef, useSyncExternalStore } from 'react';

import { hasValidTenantSelection, hasValidTenantSession } from '@/src/services/tenantIdentity';
import { store, type RootState } from '@/src/store/store';

/** Dispatching never changes, so it is safe in any dependency array. */
export const useAppDispatch = () => store.dispatch;

/**
 * Subscribes a component to one derived value from the store.
 *
 * <p>The component re-renders only when the selected value changes by
 * reference, not on every dispatch — so a stream of live position packets does
 * not re-render a screen that only reads the signed-in user.
 *
 * <h3>Return something stable</h3>
 * A selector that builds a new object or array on every call (`{...s.auth}`,
 * `list.filter(...)`) is never reference-equal to its previous result, so its
 * component re-renders on every state change anywhere in the tree. Select the
 * stored value itself, or a primitive derived from it, and let the component
 * do any shaping in a `useMemo`.
 */
export function useAppSelector<Selected>(selector: (state: RootState) => Selected): Selected {
  // The selection is memoised against both the state it was computed from and
  // the selector that computed it. Re-running only when one of those actually
  // changes is what keeps the snapshot stable between React's render and its
  // post-commit consistency check, and a selector that closes over a prop
  // (a permission key, an id) still re-runs the moment that prop changes.
  const cache = useRef<{
    state: RootState;
    selector: (state: RootState) => Selected;
    selected: Selected;
  } | null>(null);

  const getSelection = useCallback(() => {
    const current = store.getState();
    const cached = cache.current;
    if (cached && cached.state === current && cached.selector === selector) {
      return cached.selected;
    }
    const selected = selector(current);
    cache.current = { state: current, selector, selected };
    return selected;
  }, [selector]);

  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}

/** Derived auth selectors. */
export const useAuth = () => useAppSelector((s) => s.auth);
export const useHasTenant = () => useAppSelector((s) => hasValidTenantSelection(s.auth));
export const useIsAuthenticated = () => useAppSelector((s) => hasValidTenantSession(s.auth));

/**
 * A shared empty map, so a user with no permissions selects the same reference
 * every time rather than a fresh object that re-renders every consumer.
 */
const NO_PERMISSIONS: Record<string, boolean> = {};
export const usePermissions = () =>
  useAppSelector((s) => s.auth.user?.permissions ?? NO_PERMISSIONS);

export const useHasPermission = (key: string) =>
  useAppSelector((s) => {
    const user = s.auth.user;
    if (!user) return false;
    if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') return true;
    return Boolean(user.permissions?.[key]);
  });

/** Tenant CRUD is a platform operation, not a per-tenant permission. */
export const useCanManageTenants = () => useAppSelector((s) => s.auth.user?.role === 'SUPER_ADMIN');

/** The active tenant id. Null until a session exists. */
export const useActiveTenantId = () => useAppSelector((s) => s.tenant.activeTenantId);

/**
 * Monotonic counter that changes on every tenant switch.
 *
 * Use it wherever a screen keeps tenant-owned state outside the shared cache —
 * selected vehicle, map markers, filters, pagination, search text. Either put it
 * in a `key` so React remounts the subtree, or list it in a `useEffect`
 * dependency array to reset the state explicitly. Without it a screen that is
 * already mounted would keep rendering the previous tenant's selection after a
 * switch.
 */
export const useTenantEpoch = () => useAppSelector((s) => s.tenant.epoch);

/**
 * Live switch status, for the switching overlay and to block duplicate taps.
 *
 * Each field is selected separately rather than returned as one object literal: a
 * fresh object every call would fail the reference equality check and re-render
 * every consumer on every unrelated store update.
 */
export const useTenantSwitchState = () => {
  const status = useAppSelector((s) => s.tenant.status);
  const pendingTenantName = useAppSelector((s) => s.tenant.pendingTenantName);
  const error = useAppSelector((s) => s.tenant.error);
  return { status, pendingTenantName, error };
};
