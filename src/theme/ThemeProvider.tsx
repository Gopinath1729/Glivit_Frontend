import * as SecureStore from 'expo-secure-store';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

import { useAppSelector } from '@/src/store/hooks';
import {
  useGetSettingsQuery,
  useUpdateSettingsMutation,
} from '@/src/services/operationsApi';
import {
  buildColors,
  elevation as elevationFor,
  stateColorsFor,
  type Scheme,
  type ThemeColors,
} from '@/src/theme/tokens';

export type ThemeMode = 'system' | 'light' | 'dark';

type ThemeContextValue = {
  mode: ThemeMode;
  scheme: Scheme;
  isDark: boolean;
  colors: ThemeColors;
  stateColors: Record<string, string>;
  elevation: (level?: 1 | 2 | 3) => ReturnType<typeof elevationFor>;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
  setPrimaryColor: (hex: string | null) => void;
  autoFollowVehicle: boolean;
  setAutoFollowVehicle: (val: boolean) => void;
};

const STORAGE_KEY = 'glivt.theme.mode';
const COLOR_STORAGE_KEY = 'glivt.theme.primaryColor';
const AUTO_FOLLOW_STORAGE_KEY = 'glivt.preferences.autoFollow';

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [customPrimaryColor, setCustomPrimaryColorState] = useState<string | null>(null);
  const [autoFollowVehicle, setAutoFollowVehicleState] = useState<boolean>(true);
  const tenant = useAppSelector((s) => s.auth.tenantConfig);
  const user = useAppSelector((s) => s.auth.user);
  const userId = user?.id;

  const storageKey = userId ? `${STORAGE_KEY}.${userId}` : STORAGE_KEY;
  const colorStorageKey = userId ? `${COLOR_STORAGE_KEY}.${userId}` : COLOR_STORAGE_KEY;
  const autoFollowStorageKey = userId ? `${AUTO_FOLLOW_STORAGE_KEY}.${userId}` : AUTO_FOLLOW_STORAGE_KEY;

  // Retrieve user settings from backend
  const { data: backendSettings } = useGetSettingsQuery(undefined, { skip: !userId });
  const [updateSettings] = useUpdateSettingsMutation();

  // Restore the persisted preferences once when user changes or on mount
  useEffect(() => {
    let active = true;
    Promise.all([
      SecureStore.getItemAsync(storageKey),
      SecureStore.getItemAsync(colorStorageKey),
      SecureStore.getItemAsync(autoFollowStorageKey),
    ])
      .then(([savedMode, savedColor, savedAutoFollow]) => {
        if (active) {
          if (savedMode === 'light' || savedMode === 'dark' || savedMode === 'system') {
            setModeState(savedMode);
          } else {
            setModeState('system');
          }
          if (savedColor) {
            setCustomPrimaryColorState(savedColor);
          } else {
            setCustomPrimaryColorState(null);
          }
          if (savedAutoFollow !== null) {
            setAutoFollowVehicleState(savedAutoFollow === 'true');
          } else {
            setAutoFollowVehicleState(true);
          }
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [userId, storageKey, colorStorageKey, autoFollowStorageKey]);

  // Sync backend settings to local states if they are loaded
  useEffect(() => {
    if (backendSettings) {
      if (backendSettings.themeMode === 'light' || backendSettings.themeMode === 'dark' || backendSettings.themeMode === 'system') {
        setModeState(backendSettings.themeMode);
      }
      if (backendSettings.themeColor) {
        setCustomPrimaryColorState(backendSettings.themeColor);
      }
      setAutoFollowVehicleState(backendSettings.autoFollowVehicle);
    }
  }, [backendSettings]);

  const scheme: Scheme = mode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : mode;

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    SecureStore.setItemAsync(storageKey, next).catch(() => undefined);
    if (userId) {
      updateSettings({ themeMode: next }).unwrap().catch(() => undefined);
    }
  }, [storageKey, userId, updateSettings]);

  const setPrimaryColor = useCallback((hex: string | null) => {
    setCustomPrimaryColorState(hex);
    if (hex) {
      SecureStore.setItemAsync(colorStorageKey, hex).catch(() => undefined);
      if (userId) {
        updateSettings({ themeColor: hex }).unwrap().catch(() => undefined);
      }
    } else {
      SecureStore.deleteItemAsync(colorStorageKey).catch(() => undefined);
      if (userId) {
        updateSettings({ themeColor: null }).unwrap().catch(() => undefined);
      }
    }
  }, [colorStorageKey, userId, updateSettings]);

  const setAutoFollowVehicle = useCallback((val: boolean) => {
    setAutoFollowVehicleState(val);
    SecureStore.setItemAsync(autoFollowStorageKey, val ? 'true' : 'false').catch(() => undefined);
    if (userId) {
      updateSettings({ autoFollowVehicle: val }).unwrap().catch(() => undefined);
    }
  }, [autoFollowStorageKey, userId, updateSettings]);

  const toggle = useCallback(() => {
    setMode(scheme === 'dark' ? 'light' : 'dark');
  }, [scheme, setMode]);

  const value = useMemo<ThemeContextValue>(() => {
    const colors = buildColors(scheme, {
      primary: customPrimaryColor || tenant?.primaryColor || undefined,
      secondary: tenant?.secondaryColor || undefined,
    });
    return {
      mode,
      scheme,
      isDark: scheme === 'dark',
      colors,
      stateColors: stateColorsFor(colors),
      elevation: (level: 1 | 2 | 3 = 1) => elevationFor(colors, level),
      setMode,
      toggle,
      setPrimaryColor,
      autoFollowVehicle,
      setAutoFollowVehicle,
    };
  }, [scheme, mode, customPrimaryColor, tenant?.primaryColor, tenant?.secondaryColor, setMode, toggle, setPrimaryColor, autoFollowVehicle, setAutoFollowVehicle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Access the active theme. Falls back to a light theme if used outside a provider. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    const colors = buildColors('light');
    return {
      mode: 'system',
      scheme: 'light',
      isDark: false,
      colors,
      stateColors: stateColorsFor(colors),
      elevation: (level: 1 | 2 | 3 = 1) => elevationFor(colors, level),
      setMode: () => undefined,
      toggle: () => undefined,
      setPrimaryColor: () => undefined,
      autoFollowVehicle: true,
      setAutoFollowVehicle: () => undefined,
    };
  }
  return ctx;
}

/** Convenience: just the active colours. */
export function useThemeColors(): ThemeColors {
  return useTheme().colors;
}
