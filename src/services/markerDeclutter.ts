/**
 * Screen-space declutter for fleet markers.
 *
 * Vehicles parked at the same yard (or simply close together at a low zoom)
 * project to nearly the same pixel, so the 3D models stack on top of each other
 * and none of them can be read or tapped.
 *
 * Three stages, all in pixels so any map engine can use this:
 *   1. group markers that collide,
 *   2. lay each group out — fan a small one around its centre, collapse a big
 *      one into a single cluster badge,
 *   3. relax every drawn body against every other one. Stage 2 only separates
 *      markers inside a group; without stage 3 two neighbouring fans (or a fan
 *      and a nearby lone vehicle) still land on top of each other.
 */

export type ScreenPoint = { x: number; y: number };

export type DeclutterInput<T> = {
  id: string;
  item: T;
  point: ScreenPoint;
  /** A group holding a pinned item is always fanned out, never collapsed. */
  pinned?: boolean;
};

export type DeclutterMember<T> = {
  id: string;
  item: T;
  /** Where the marker should be drawn (moved away when it collided). */
  point: ScreenPoint;
  /** The true projected position, for drawing a leader line back to it. */
  anchor: ScreenPoint;
  /** True when `point` was moved away from `anchor`. */
  displaced: boolean;
};

export type DeclutterGroup<T> = {
  key: string;
  /** Where a cluster badge should be drawn (only meaningful when clustered). */
  center: ScreenPoint;
  /** The true centroid the badge stands for. */
  anchor: ScreenPoint;
  /** Render a count badge instead of the members when true. */
  clustered: boolean;
  members: DeclutterMember<T>[];
};

export type DeclutterOptions = {
  /** Markers closer than this (px) are grouped together. */
  collideRadius?: number;
  /** Groups larger than this collapse into a cluster badge. */
  maxSpread?: number;
  /** Centre-to-centre distance (px) two markers must end up apart. */
  minSeparation?: number;
  /** Centre-to-centre distance (px) a cluster badge needs from anything else. */
  clusterSeparation?: number;
  /** How far (px) a marker may be pushed from its true position. */
  maxDisplacement?: number;
  /**
   * Group key each id had on the previous pass. Markers that were already
   * grouped together stay together up to `releaseRadius`, so a vehicle drifting
   * across the collision threshold does not flicker in and out of the fan.
   */
  previousGroups?: ReadonlyMap<string, string>;
  /** Wider radius (px) applied to pairs that were grouped last pass. */
  releaseRadius?: number;
};

// Vehicle models render ~43px long (56px when selected), so bodies need roughly
// 68px between centres before two arbitrarily rotated cars stop touching.
const DEFAULT_COLLIDE_RADIUS = 52;
const DEFAULT_MAX_SPREAD = 4;
const DEFAULT_MIN_SEPARATION = 68;
const DEFAULT_CLUSTER_SEPARATION = 78;
const DEFAULT_MAX_DISPLACEMENT = 110;
const DEFAULT_RELEASE_RADIUS = 72;
const RELAX_ITERATIONS = 40;
const RELAX_DAMPING = 0.6;

type Body = {
  /** Index into the flat member list, or -1 for a cluster badge. */
  memberIndex: number;
  groupIndex: number;
  radius: number;
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
};

export function declutterMarkers<T>(
  inputs: readonly DeclutterInput<T>[],
  options: DeclutterOptions = {}
): DeclutterGroup<T>[] {
  const collideRadius = options.collideRadius ?? DEFAULT_COLLIDE_RADIUS;
  const maxSpread = options.maxSpread ?? DEFAULT_MAX_SPREAD;
  const minSeparation = options.minSeparation ?? DEFAULT_MIN_SEPARATION;
  const clusterSeparation = options.clusterSeparation ?? DEFAULT_CLUSTER_SEPARATION;
  const maxDisplacement = options.maxDisplacement ?? DEFAULT_MAX_DISPLACEMENT;
  const releaseRadius = Math.max(collideRadius, options.releaseRadius ?? DEFAULT_RELEASE_RADIUS);

  const groups = layOutGroups(
    buildBuckets(inputs, collideRadius, releaseRadius, options.previousGroups),
    { maxSpread, minSeparation }
  );

  relax(groups, { clusterSeparation, maxDisplacement, minSeparation });

  return groups;
}

/** Stage 2: fan out small groups, collapse large ones. */
function layOutGroups<T>(
  buckets: DeclutterInput<T>[][],
  { maxSpread, minSeparation }: { maxSpread: number; minSeparation: number }
): DeclutterGroup<T>[] {
  return buckets.map((bucket) => {
    // Slots are handed out in id order so a vehicle keeps the same spoke while
    // the group membership is unchanged, instead of hopping around as it moves.
    const ordered = [...bucket].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const anchor = centroid(ordered.map((member) => member.point));
    const key = `group-${ordered[0].id}`;

    if (ordered.length === 1) {
      return { anchor, center: anchor, clustered: false, key, members: ordered.map(keepInPlace) };
    }

    if (ordered.length > maxSpread && !ordered.some((member) => member.pinned)) {
      return { anchor, center: anchor, clustered: true, key, members: ordered.map(keepInPlace) };
    }

    const radius = spreadRadius(ordered.length, minSeparation);
    return {
      anchor,
      center: anchor,
      clustered: false,
      key,
      members: ordered.map((member, index) => {
        const angle = -Math.PI / 2 + (index * 2 * Math.PI) / ordered.length;
        return {
          anchor: member.point,
          displaced: true,
          id: member.id,
          item: member.item,
          point: {
            x: anchor.x + radius * Math.cos(angle),
            y: anchor.y + radius * Math.sin(angle),
          },
        };
      }),
    };
  });
}

/**
 * Stage 3: push every drawn body off every other one, then pull it back within
 * `maxDisplacement` of where the vehicle actually is. Bodies are few (one per
 * visible vehicle, one per cluster) so the O(n^2) sweep is cheap.
 */
function relax<T>(
  groups: DeclutterGroup<T>[],
  {
    clusterSeparation,
    maxDisplacement,
    minSeparation,
  }: { clusterSeparation: number; maxDisplacement: number; minSeparation: number }
): void {
  const bodies: Body[] = [];
  groups.forEach((group, groupIndex) => {
    if (group.clustered) {
      bodies.push({
        anchorX: group.anchor.x,
        anchorY: group.anchor.y,
        groupIndex,
        memberIndex: -1,
        radius: clusterSeparation / 2,
        x: group.center.x,
        y: group.center.y,
      });
      return;
    }
    group.members.forEach((member, memberIndex) => {
      bodies.push({
        anchorX: member.anchor.x,
        anchorY: member.anchor.y,
        groupIndex,
        memberIndex,
        radius: minSeparation / 2,
        x: member.point.x,
        y: member.point.y,
      });
    });
  });

  if (bodies.length > 1) {
    for (let iteration = 0; iteration < RELAX_ITERATIONS; iteration += 1) {
      let moved = false;
      for (let i = 0; i < bodies.length; i += 1) {
        for (let j = i + 1; j < bodies.length; j += 1) {
          const a = bodies[i];
          const b = bodies[j];
          const wanted = a.radius + b.radius;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distance = Math.hypot(dx, dy);
          if (distance >= wanted) continue;
          if (distance < 1e-3) {
            // Exactly coincident: pick a deterministic direction so the layout
            // is identical between renders instead of jittering.
            const angle = (i * 2.399963) % (Math.PI * 2);
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            distance = 1;
          }
          const push = ((wanted - distance) / 2) * RELAX_DAMPING;
          const ux = (dx / distance) * push;
          const uy = (dy / distance) * push;
          a.x -= ux;
          a.y -= uy;
          b.x += ux;
          b.y += uy;
          moved = true;
        }
      }
      for (const body of bodies) {
        const dx = body.x - body.anchorX;
        const dy = body.y - body.anchorY;
        const distance = Math.hypot(dx, dy);
        if (distance <= maxDisplacement) continue;
        const scale = maxDisplacement / distance;
        body.x = body.anchorX + dx * scale;
        body.y = body.anchorY + dy * scale;
      }
      if (!moved) break;
    }
  }

  for (const body of bodies) {
    const point = { x: body.x, y: body.y };
    const group = groups[body.groupIndex];
    if (body.memberIndex < 0) {
      group.center = point;
      continue;
    }
    const member = group.members[body.memberIndex];
    member.point = point;
    member.displaced = Math.hypot(point.x - member.anchor.x, point.y - member.anchor.y) > 0.75;
  }
}

/** Stage 1: single-link grouping — anything within radius of a member joins it. */
function buildBuckets<T>(
  inputs: readonly DeclutterInput<T>[],
  collideRadius: number,
  releaseRadius: number,
  previousGroups?: ReadonlyMap<string, string>
): DeclutterInput<T>[][] {
  const ordered = [...inputs].sort(
    (a, b) => a.point.y - b.point.y || a.point.x - b.point.x || (a.id < b.id ? -1 : 1)
  );
  const taken = new Array<boolean>(ordered.length).fill(false);
  const collideSquared = collideRadius * collideRadius;
  const releaseSquared = releaseRadius * releaseRadius;
  const buckets: DeclutterInput<T>[][] = [];

  const wereGrouped = (a: DeclutterInput<T>, b: DeclutterInput<T>) => {
    if (!previousGroups) return false;
    const key = previousGroups.get(a.id);
    return key != null && key === previousGroups.get(b.id);
  };

  for (let i = 0; i < ordered.length; i += 1) {
    if (taken[i]) continue;
    taken[i] = true;
    const bucket = [ordered[i]];
    for (let cursor = 0; cursor < bucket.length; cursor += 1) {
      for (let j = 0; j < ordered.length; j += 1) {
        if (taken[j]) continue;
        const limit = wereGrouped(bucket[cursor], ordered[j]) ? releaseSquared : collideSquared;
        if (distanceSquared(bucket[cursor].point, ordered[j].point) > limit) continue;
        taken[j] = true;
        bucket.push(ordered[j]);
      }
    }
    buckets.push(bucket);
  }

  return buckets;
}

/** Circle radius that leaves `separation` px between neighbouring spokes. */
function spreadRadius(count: number, separation: number): number {
  if (count <= 1) return 0;
  if (count === 2) return separation / 2;
  return Math.max(separation / 2, separation / 2 / Math.sin(Math.PI / count));
}

function keepInPlace<T>(member: DeclutterInput<T>): DeclutterMember<T> {
  return {
    anchor: member.point,
    displaced: false,
    id: member.id,
    item: member.item,
    point: member.point,
  };
}

function centroid(points: readonly ScreenPoint[]): ScreenPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function distanceSquared(a: ScreenPoint, b: ScreenPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
