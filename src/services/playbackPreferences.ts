import { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * How playback treats the time a vehicle spent standing still.
 *
 * `skip` is the default because it is what almost every viewing is for: an
 * operator opening yesterday wants to see where the vehicle went, and a parked
 * car carries no information per second. `full` plays the recording exactly as
 * it happened, which is what an investigation needs — so it stays one tap away
 * rather than being decided for the user.
 */
export type PlaybackStopsMode = 'skip' | 'full';

const STORAGE_KEY = 'glivt.playbackStops';

export const DEFAULT_PLAYBACK_STOPS_MODE: PlaybackStopsMode = 'skip';

function parse(raw: string | null): PlaybackStopsMode {
  return raw === 'full' ? 'full' : DEFAULT_PLAYBACK_STOPS_MODE;
}

export async function loadPlaybackStopsMode(): Promise<PlaybackStopsMode> {
  try {
    if (Platform.OS === 'web') {
      return parse(typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null);
    }
    return parse(await SecureStore.getItemAsync(STORAGE_KEY));
  } catch {
    return DEFAULT_PLAYBACK_STOPS_MODE;
  }
}

export async function savePlaybackStopsMode(mode: PlaybackStopsMode): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, mode);
      return;
    }
    await SecureStore.setItemAsync(STORAGE_KEY, mode);
  } catch {
    // A preference that could not be stored is not worth failing a screen over.
  }
}

/**
 * The setting, applied immediately and written back in the background.
 *
 * The stored value is read once on mount; until it arrives the default applies,
 * so the screen never waits on storage before it can play anything.
 */
export function usePlaybackStopsMode(): [PlaybackStopsMode, (mode: PlaybackStopsMode) => void] {
  const [mode, setMode] = useState<PlaybackStopsMode>(DEFAULT_PLAYBACK_STOPS_MODE);

  useEffect(() => {
    let cancelled = false;
    void loadPlaybackStopsMode().then((stored) => {
      if (!cancelled) setMode(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((next: PlaybackStopsMode) => {
    setMode(next);
    void savePlaybackStopsMode(next);
  }, []);

  return [mode, update];
}
