/**
 * Heading helpers for map markers.
 *
 * This module used to hold a table of per-category, per-state PNG sprites too.
 * Markers are vector now (see VehicleMarker), so a marker takes its colour from
 * the live status instead of needing an image for every combination.
 */
export function normalizeHeading(heading?: number | null): number {
  return Number.isFinite(heading) ? ((heading! % 360) + 360) % 360 : 0;
}
