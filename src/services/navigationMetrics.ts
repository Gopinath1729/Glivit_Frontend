/** Display a routing-provider distance without deriving it from endpoint geometry. */
export function formatRouteDistance(metres: number): string {
  if (!Number.isFinite(metres)) return '—';
  if (metres < 1000) return `${Math.max(0, Math.round(metres))} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}

/** Geoapify route time is seconds. Round upward so the displayed ETA is never understated. */
export function formatRouteDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

export function formatRouteMetrics(distanceMeters: number, durationSeconds: number): string {
  return `${formatRouteDuration(durationSeconds)}\n${formatRouteDistance(distanceMeters)}`;
}
