import type { AnyAction } from '@/src/store/action';
import {
  CLEAR_ACTIVE_TENANT,
  SWITCH_FAILED,
  SWITCH_SUCCEEDED,
} from '@/src/store/tenantState';

/**
 * Local read-state for the in-app notification panel.
 *
 * Vehicle events already carry an authoritative server `acknowledged` flag (and
 * are marked read through the existing acknowledge API). Maintenance predictions
 * have no such flag, so their read/unread status is tracked here by a stable
 * notification key (e.g. `maint:<id>` or `event:<id>`). Keeping this separate
 * from server state means no backend contract changes.
 */
export type NotificationsState = {
  readKeys: Record<string, true>;
};

const initialState: NotificationsState = {
  readKeys: {},
};

export type NotificationsAction =
  | { type: 'notifications/markNotificationRead'; payload: string }
  | { type: 'notifications/markNotificationsRead'; payload: string[] };

export const markNotificationRead = (payload: string): NotificationsAction => ({
  type: 'notifications/markNotificationRead',
  payload,
});

export const markNotificationsRead = (payload: string[]): NotificationsAction => ({
  type: 'notifications/markNotificationsRead',
  payload,
});

function isNotificationsAction(action: AnyAction): action is NotificationsAction {
  return action.type.startsWith('notifications/');
}

export default function notificationsReducer(
  state: NotificationsState = initialState,
  action: AnyAction
): NotificationsState {
  // Read-markers are keys built from tenant-owned record ids (event:<id>,
  // maint:<id>), so they are meaningless — and actively misleading — in another
  // tenant. Changing tenant discards them all.
  if (
    action.type === SWITCH_SUCCEEDED ||
    action.type === SWITCH_FAILED ||
    action.type === CLEAR_ACTIVE_TENANT
  ) {
    return Object.keys(state.readKeys).length === 0 ? state : initialState;
  }

  if (!isNotificationsAction(action)) return state;

  switch (action.type) {
    case 'notifications/markNotificationRead': {
      if (state.readKeys[action.payload]) return state;
      return { readKeys: { ...state.readKeys, [action.payload]: true } };
    }

    case 'notifications/markNotificationsRead': {
      const unread = action.payload.filter((key) => !state.readKeys[key]);
      if (unread.length === 0) return state;
      const readKeys = { ...state.readKeys };
      for (const key of unread) readKeys[key] = true;
      return { readKeys };
    }

    default:
      return state;
  }
}
