import { useDispatch, useSelector } from 'react-redux';

import { hasValidTenantSelection, hasValidTenantSession } from '@/src/services/tenantIdentity';
import type { AppDispatch, RootState } from '@/src/store/store';

export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();

/** Derived auth selectors. */
export const useAuth = () => useAppSelector((s) => s.auth);
export const useHasTenant = () => useAppSelector((s) => hasValidTenantSelection(s.auth));
export const useIsAuthenticated = () => useAppSelector((s) => hasValidTenantSession(s.auth));
export const usePermissions = () => useAppSelector((s) => s.auth.user?.permissions ?? {});
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
 * Use it wherever a screen keeps tenant-owned state outside RTK Query — selected
 * vehicle, map markers, filters, pagination, search text. Either put it in a `key`
 * so React remounts the subtree, or list it in a `useEffect` dependency array to
 * reset the state explicitly. Without it a screen that is already mounted would keep
 * rendering the previous tenant's selection after a switch.
 */
export const useTenantEpoch = () => useAppSelector((s) => s.tenant.epoch);

/**
 * Live switch status, for the switching overlay and to block duplicate taps.
 *
 * Each field is selected separately rather than returned as one object literal: a
 * fresh object every call would fail the default reference equality check and
 * re-render every consumer on every unrelated store update.
 */
export const useTenantSwitchState = () => {
  const status = useAppSelector((s) => s.tenant.status);
  const pendingTenantName = useAppSelector((s) => s.tenant.pendingTenantName);
  const error = useAppSelector((s) => s.tenant.error);
  return { status, pendingTenantName, error };
};
