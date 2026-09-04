import { useEffect, useState } from 'react';

/**
 * A clock that re-renders its component, for labels derived from "how long ago".
 *
 * <h3>Why a relative timestamp needs one</h3>
 * A label like "now" / "3m" / "2h" is a function of two things: the timestamp
 * and the current time. React only re-renders when the first one changes — so a
 * row whose data has stopped arriving keeps rendering the age it was first
 * given, forever.
 *
 * That is backwards from what an operator needs. A vehicle that is reporting
 * normally has its data replaced constantly, so its age stays accurate on its
 * own. A vehicle that has STOPPED reporting produces no new data at all, so its
 * age is exactly the one that freezes — and it freezes at whatever it last
 * showed, which is usually "now". Observed on the fleet list as a device that
 * had not sent a fix for seven minutes still reading "now", while the vehicle
 * detail screen — freshly mounted, so rendering for the first time — correctly
 * read "7m" from the very same timestamp.
 *
 * @param intervalMs how often to re-render. Match it to the label's resolution:
 *                   a minute-resolution age needs no more than ~30 s, and
 *                   ticking faster only spends battery to render the same text.
 * @returns the current epoch milliseconds, changing on every tick
 */
export function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const period = Math.max(1_000, intervalMs);
    const timer = setInterval(() => setNow(Date.now()), period);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
