/**
 * Turning a redrawn route into the small piece of it that actually changed.
 *
 * A route that is being played back, or a live trail being extended, only ever
 * gains vertices at its head — and its head vertex is the interpolated position
 * of the vehicle, so it moves on every frame while everything behind it stays
 * exactly where it was. The producers of that geometry hand the map a fresh
 * array every frame regardless, because that is what a React value is.
 *
 * Sending that array to the map document as it stands means serialising every
 * vertex of a whole day's route, twenty-five times a second, and pushing the
 * result across the bridge. It saturates the bridge, starves the map's own
 * frame loop, and delivers the line in visible bursts rather than as growth.
 *
 * This is the thing that decides whether the redraw was growth. It compares the
 * shared prefix — numeric comparisons, no allocation — and returns only the
 * tail when it was. When it was anything else (a seek backwards, a new day, a
 * different number of runs) it returns null and the caller pushes the whole
 * route, so what is drawn is always exactly the geometry it was given.
 */

/** A vertex in the order the map document expects: [longitude, latitude]. */
export type RoutePoint = readonly [number, number];

/** One appended tail: the vertices of run `index`, starting at `from`. */
export type RouteExtension = {
  index: number;
  from: number;
  coords: [number, number][];
};

/**
 * The growth from `previous` to `next`, or null when this is not growth.
 *
 * An empty array means every run is unchanged and there is nothing to send.
 */
export function routeDelta(
  previous: readonly RoutePoint[][] | null | undefined,
  next: readonly RoutePoint[][]
): RouteExtension[] | null {
  if (!previous || previous.length !== next.length || next.length === 0) return null;

  const extensions: RouteExtension[] = [];
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index];
    const after = next[index];
    // Producers share the runs behind the head between frames, so this is the
    // common case and it settles a whole run without reading a coordinate.
    if (before === after) continue;

    // The head vertex is the interpolated marker position and is expected to
    // move; every vertex behind it must be untouched for this to be growth.
    const shared = before.length - 1;
    if (shared < 1 || after.length < shared) return null;
    for (let point = 0; point < shared; point += 1) {
      if (before[point][0] !== after[point][0] || before[point][1] !== after[point][1]) {
        return null;
      }
    }

    const head = after[shared];
    if (after.length === before.length && before[shared][0] === head[0] && before[shared][1] === head[1]) {
      // Identical run. A parked vehicle keeps every one of its runs in this
      // state, so saying nothing about them is the common case, not an edge one.
      continue;
    }

    const coords: [number, number][] = [];
    for (let point = shared; point < after.length; point += 1) {
      coords.push([after[point][0], after[point][1]]);
    }
    extensions.push({ index, from: shared, coords });
  }
  return extensions;
}

/**
 * Apply extensions to a route, exactly as the map document does.
 *
 * Exported so the rule the document follows can be tested against the rule that
 * produced the extensions, rather than each being trusted on its own.
 */
export function applyRouteExtensions(
  route: readonly RoutePoint[][],
  extensions: readonly RouteExtension[]
): RoutePoint[][] {
  const result = route.map((line) => line.slice());
  for (const extension of extensions) {
    const line = result[extension.index];
    if (!line) continue;
    line.length = extension.from;
    for (const coordinate of extension.coords) line.push(coordinate);
  }
  return result;
}
