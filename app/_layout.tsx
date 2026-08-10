import { Stack, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Provider } from 'react-redux';

import { authStorage } from '@/src/services/authStorage';
import { preloadVehicleModels } from '@/src/components/Vehicle3DMarker';
import { TenantSwitchOverlay } from '@/src/components/TenantSwitchOverlay';
import { hydrate } from '@/src/store/authSlice';
import { adoptSessionTenant } from '@/src/store/tenantSlice';
import {
  useAppDispatch,
  useAuth,
  useTenantSwitchState,
} from '@/src/store/hooks';
import { store } from '@/src/store/store';
import { ThemeProvider, useTheme } from '@/src/theme/ThemeProvider';

/** Status bar content color is dynamically adapted based on header color and active route. */
function ThemedStatusBar() {
  const { isDark } = useTheme();
  let segments: string[] = [];
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    segments = useSegments();
  } catch {
    // Fallback if called during boot before router is initialized
  }

  // The map screen is transparent/light in light mode and dark in dark mode.
  // When we are on the map screen, status bar style follows the theme mode.
  const isMapScreen = segments.length >= 2 && segments.includes('map');

  // In all other cases (e.g. green gradient headers or dark screens like login/device-profile),
  // we require light text and icons for maximum readability.
  const statusBarStyle = (isMapScreen && !isDark) ? 'dark' : 'light';

  return (
    <StatusBar
      style={statusBarStyle}
      translucent
      backgroundColor="transparent"
    />
  );
}

// Keep the native splash up until persisted auth/branding is loaded, so no
// default React Native / placeholder screen flashes.
SplashScreen.preventAutoHideAsync().catch(() => undefined);

function Bootstrapper({ children }: { children: React.ReactNode }) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    preloadVehicleModels();
    let active = true;
    (async () => {
      try {
        const persisted = await authStorage.load();
        if (active) {
          dispatch(hydrate(persisted));
          // Restore the active tenant from the persisted SESSION, not from a
          // separately remembered id. The tenant is signed into the stored access
          // token and re-authorised by the backend on the first request, so a tenant
          // whose access has since been revoked cannot be restored: that request
          // fails and the session is cleared.
          dispatch(adoptSessionTenant(persisted.user));
        }
      } catch {
        if (active) {
          dispatch(hydrate({}));
          dispatch(adoptSessionTenant(null));
        }
      } finally {
        await SplashScreen.hideAsync().catch(() => undefined);
      }
    })();
    return () => {
      active = false;
    };
  }, [dispatch]);

  return <>{children}</>;
}

/**
 * The switching loader lives at the root, above the navigator.
 *
 * A tenant switch remounts the authenticated navigator (it is keyed on the tenant
 * epoch), so an overlay rendered inside it would disappear mid-transition and expose
 * a half-initialised app. Rendering it here keeps the screen covered from the moment
 * Yes is tapped until the new tenant's Live Map has been navigated to.
 */
function TenantSwitchGate() {
  const { status, pendingTenantName } = useTenantSwitchState();
  return <TenantSwitchOverlay tenantName={pendingTenantName} visible={status === 'switching'} />;
}

function RootNavigator() {
  const { bootstrapped } = useAuth();

  if (!bootstrapped) return null;

  return (
    <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="company-code" />
      <Stack.Screen name="login" />
      <Stack.Screen name="device-profile" />
      <Stack.Screen name="live-track" />
      <Stack.Screen name="trip-playback" />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <Provider store={store}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <ThemeProvider>
            <Bootstrapper>
              <RootNavigator />
              <TenantSwitchGate />
            </Bootstrapper>
            <ThemedStatusBar />
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Provider>
  );
}
