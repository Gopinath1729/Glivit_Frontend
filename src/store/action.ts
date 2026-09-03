/**
 * The shape every state update travels in.
 *
 * <p>Reducers receive every action, not only their own — that is what lets one
 * reducer react to another's event, such as tenant-owned state clearing itself
 * the instant a tenant switch is recorded. Each reducer narrows the action to
 * the set it handles with its own type guard, so the payload stays fully typed
 * inside the reducer while the store can still hand it to all of them.
 */
export type AnyAction = { type: string; payload?: unknown };
