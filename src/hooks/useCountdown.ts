import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A one-second countdown that survives re-renders.
 *
 * The deadline is held in a ref and remaining time is derived from the wall
 * clock rather than decremented, so a render caused by typing (which happens on
 * every keystroke of an OTP field) cannot restart or skew it, and time that
 * passed while the app was backgrounded is accounted for on the next tick.
 */
export function useCountdown() {
  const deadlineRef = useRef<number | null>(null);
  const [remaining, setRemaining] = useState(0);

  const start = useCallback((seconds: number) => {
    if (seconds <= 0) {
      deadlineRef.current = null;
      setRemaining(0);
      return;
    }
    deadlineRef.current = Date.now() + seconds * 1000;
    setRemaining(seconds);
  }, []);

  const stop = useCallback(() => {
    deadlineRef.current = null;
    setRemaining(0);
  }, []);

  useEffect(() => {
    if (remaining <= 0) return undefined;
    const timer = setInterval(() => {
      const deadline = deadlineRef.current;
      if (deadline == null) {
        setRemaining(0);
        return;
      }
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) {
        deadlineRef.current = null;
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [remaining]);

  return { remaining, start, stop };
}

/** Formats seconds as mm:ss, the shape the expiry line on the OTP screen uses. */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
