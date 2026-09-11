import { Stack, useSegments } from 'expo-router';
import { ThemeProvider as NavigationThemeProvider, DefaultTheme, DarkTheme } from '@react-navigation/native';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { authStorage } from '@/src/services/authStorage';
// Side-effect import, and it has to stay one. The background location task must
// be DEFINED before the OS can hand a fix back to a relaunched app, which
// happens before any screen mounts -- so defining it inside a component or a
// lazy import means every background update after a cold start is dropped.
import '@/src/services/mobileGpsBackgroundTask';
import { BrandSplash } from '@/src/components/BrandSplash';
import { TenantSwitchOverlay } from '@/src/components/TenantSwitchOverlay';
import { hydrate } from '@/src/store/authState';
import { adoptSessionTenant } from '@/src/store/tenantState';
import {
  useAppDispatch,
  useAuth,
  useHasTenant,
  useIsAuthenticated,
  useTenantSwitchState,
} from '@/src/store/hooks';
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

  // Light mode keeps the system area pale above the inset hero card, matching
  // the reference header. Dark mode retains light glyphs on its dark surface.
  const hasAppHero = segments.includes('(app)');
  const isPublicMap = segments.includes('shared-trip');
  const statusBarStyle = hasAppHero
    ? isDark ? 'light' : 'dark'
    : isPublicMap && !isDark ? 'dark' : 'light';

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

function Bootstrapper({
  children,
  onReady,
}: {
  children: React.ReactNode;
  onReady: () => void;
}) {
  const dispatch = useAppDispatch();

  useEffect(() => {
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
        // The animated splash is already painted over the whole screen, so
        // dropping the native one here is invisible -- both draw the same mark
        // on the same brand navy. Hiding it is what lets the animation run.
        await SplashScreen.hideAsync().catch(() => undefined);
        if (active) onReady();
      }
    })();
    return () => {
      active = false;
    };
  }, [dispatch, onReady]);

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
  const hasTenant = useHasTenant();
  const authenticated = useIsAuthenticated();
  const { isDark, colors: c } = useTheme();

  if (!bootstrapped) return null;

  const baseTheme = isDark ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...baseTheme,
    dark: isDark,
    colors: {
      ...baseTheme.colors,
      primary: c.primary,
      background: c.pageBackground,
      card: c.cardBackground,
      text: c.textPrimary,
      border: c.border,
      notification: c.danger,
    },
  };

  return (
    <NavigationThemeProvider value={navTheme}>
      <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="shared-trip" />
        <Stack.Protected guard={!hasTenant}>
          <Stack.Screen name="company-code" />
        </Stack.Protected>
        <Stack.Protected guard={hasTenant && !authenticated}>
          <Stack.Screen name="login" />
          {/* Both live behind the same guard as Login: they act on an existing
              member of the already-chosen tenant, and a signed-in user has no
              use for either. */}
          <Stack.Screen name="activate-account" />
          <Stack.Screen name="forgot-password" />
        </Stack.Protected>
        <Stack.Protected guard={authenticated}>
          <Stack.Screen name="vehicle-documents" />
          <Stack.Screen name="live-track" />
          {/* Turns this phone into one of the fleet's trackers. Registered here
              rather than under (app) because it keeps reporting while the tab
              navigator is not mounted. */}
          <Stack.Screen name="tracker-mode" />
          <Stack.Screen name="trip-playback" />
          <Stack.Screen name="(app)" />
        </Stack.Protected>
      </Stack>
    </NavigationThemeProvider>
  );
}

export default function RootLayout() {
  const [booted, setBooted] = React.useState(false);
  const [splashDone, setSplashDone] = React.useState(false);
  const handleReady = React.useCallback(() => setBooted(true), []);
  const handleSplashFinished = React.useCallback(() => setSplashDone(true), []);

  // The app store is a module singleton rather than a context value, so there is
  // no provider to mount here: any component can read it through
  // `useAppSelector` from the moment the bundle loads.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <Bootstrapper onReady={handleReady}>
            <RootNavigator />
            <TenantSwitchGate />
          </Bootstrapper>
          <ThemedStatusBar />
          {/* Sits above the navigator so the app can mount and settle behind
              it; it only fades out once boot has finished, which is why a slow
              cold start never shows a half-built screen. */}
          {splashDone ? null : <BrandSplash onFinished={handleSplashFinished} ready={booted} />}
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
