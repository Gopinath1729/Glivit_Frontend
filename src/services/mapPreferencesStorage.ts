import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export type MapTypeOption = 'standard' | 'satellite' | 'terrain';

export type MapDetailOptions = {
  traffic: boolean;
};

export type MapPreferences = {
  mapType: MapTypeOption;
  details: MapDetailOptions;
};

const STORAGE_KEY = 'glivt.mapPreferences';

export const DEFAULT_MAP_PREFERENCES: MapPreferences = {
  mapType: 'standard',
  details: {
    traffic: false,
  },
};

export async function loadMapPreferences(): Promise<MapPreferences> {
  try {
    if (Platform.OS === 'web') {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      if (!raw) return DEFAULT_MAP_PREFERENCES;
      const parsed = JSON.parse(raw);
      return {
        mapType: parsed.mapType ?? DEFAULT_MAP_PREFERENCES.mapType,
        details: { ...DEFAULT_MAP_PREFERENCES.details, ...(parsed.details || {}) },
      };
    } else {
      const raw = await SecureStore.getItemAsync(STORAGE_KEY);
      if (!raw) return DEFAULT_MAP_PREFERENCES;
      const parsed = JSON.parse(raw);
      return {
        mapType: parsed.mapType ?? DEFAULT_MAP_PREFERENCES.mapType,
        details: { ...DEFAULT_MAP_PREFERENCES.details, ...(parsed.details || {}) },
      };
    }
  } catch {
    return DEFAULT_MAP_PREFERENCES;
  }
}

export async function saveMapPreferences(prefs: MapPreferences): Promise<void> {
  try {
    const raw = JSON.stringify(prefs);
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, raw);
    } else {
      await SecureStore.setItemAsync(STORAGE_KEY, raw);
    }
  } catch {
    // ignore
  }
}
