import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Redirect, Tabs, useNavigation, useRouter } from 'expo-router';
import React, { useState, useEffect } from 'react';
import { Pressable, Text, View, StyleSheet, useWindowDimensions } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { Image } from 'expo-image';

import { ProfileMenu } from '@/src/components/ProfileMenu';
import { NotificationCenter } from '@/src/components/NotificationCenter';
import {
  useAppSelector,
  useHasTenant,
  useIsAuthenticated,
  useTenantEpoch,
} from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import { hexToRgba } from '@/src/theme/tokens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { MobileGpsTrackingGate } from '@/src/components/MobileGpsTrackingGate';

const PROFILE_IMG_KEY = 'glivt.profile.imageUri';

const PRIMARY_ROUTES = new Set(['map', 'vehicles', 'geofences', 'reports', 'management']);

/**
 * Per-route header identity.
 *
 * The photographic hero band this used to draw was 134 px tall before the safe
 * area, which is a fifth of a phone screen spent on a decorative image - on the
 * Live Map it covered the map itself. What a header owes an operator is where
 * they are, what they can do from here, and a way back; this carries all three
 * in a 54 pt bar, and spends its remaining budget on being beautiful rather
 * than on being big.
 *
 * `tint` shifts the bar's gradient so each section still has a colour of its
 * own - which, with the leading medallion removed, is now the only thing that
 * distinguishes one section's bar from another's.
 */
const HEROES = {
  map: {
    title: 'Live Map',
    subtitle: 'REAL-TIME FLEET TRACKING',
    tint: '#0B63CE',
  },
  vehicles: {
    title: 'Vehicles',
    subtitle: 'FLEET & TRACKERS',
    tint: '#0F5FBE',
  },
  geofences: {
    title: 'Geofences',
    subtitle: 'SMART ZONES & ALERTS',
    tint: '#1657C4',
  },
  reports: {
    title: 'Reports',
    subtitle: 'DRIVE INSIGHTS',
    tint: '#1B4FB8',
  },
  management: {
    title: 'Management',
    subtitle: 'PEOPLE & ACCESS',
    tint: '#20489F',
  },
  users: {
    title: 'Users',
    subtitle: 'ACCESS, ROLES & ACCOUNTS',
    tint: '#20489F',
  },
  'manage-tenants': {
    title: 'Tenants',
    subtitle: 'ORGANIZATIONS & WORKSPACES',
    tint: '#20489F',
  },
  'tenant-details': {
    title: 'Tenant Details',
    subtitle: 'PROFILE & MEMBERS',
    tint: '#20489F',
  },
  settings: {
    title: 'Settings',
    subtitle: 'YOUR FLEET, YOUR PREFERENCES',
    tint: '#20489F',
  },
  'change-password': {
    title: 'Change Password',
    subtitle: 'KEEP YOUR ACCOUNT SECURE',
    tint: '#20489F',
  },
} as const;

type HeroRouteName = keyof typeof HEROES;

function HeaderActions({
  profileUri,
  initials,
  onPressProfile,
}: {
  profileUri: string | null;
  initials: string;
  onPressProfile: () => void;
}) {
  const { colors: c, isDark, toggle } = useTheme();
  const router = useRouter();
  return (
    <View style={styles.heroActions}>
      <View style={styles.heroActionButton}>
        <NotificationCenter tint={c.onPrimary} />
      </View>
      {/* Sized and shaped as the theme toggle's twin: both are one-tap account
          utilities that belong in the bar rather than three taps deep. */}
      <Pressable
        accessibilityLabel="Change password"
        accessibilityRole="button"
        hitSlop={7}
        onPress={() => router.push('/change-password' as never)}
        style={({ pressed }) => [styles.iconPill, pressed && styles.actionPressed]}>
        <MaterialCommunityIcons color="#FFFFFF" name="lock-reset" size={16} />
      </Pressable>
      <Pressable
        accessibilityLabel={isDark ? 'Use light theme' : 'Use dark theme'}
        accessibilityRole="switch"
        accessibilityState={{ checked: isDark }}
        hitSlop={7}
        onPress={toggle}
        style={({ pressed }) => [styles.iconPill, pressed && styles.actionPressed]}>
        <MaterialCommunityIcons
          color="#FFFFFF"
          name={isDark ? 'weather-night' : 'white-balance-sunny'}
          size={16}
        />
      </Pressable>
      <Pressable
        accessibilityLabel="Open profile"
        accessibilityRole="button"
        onPress={onPressProfile}
        hitSlop={8}
        style={({ pressed }) => [styles.profileButton, pressed && styles.actionPressed]}>
        {profileUri ? (
          <Image source={{ uri: profileUri }} style={styles.profileImage} contentFit="cover" />
        ) : (
          <View style={styles.profileFallback}>
            <Text style={styles.profileInitials}>{initials}</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

/**
 * The application bar.
 *
 * One continuous brand gradient that runs edge to edge and under the status
 * bar, so the bar reads as part of the device rather than as a card floating on
 * the page. Depth comes from three cheap, static layers - a diagonal sheen, a
 * soft corner bloom and a hairline of light along the bottom edge - none of
 * which animate, re-measure or re-render, which matters because this sits above
 * the Live Map and must never cost it a frame.
 */
function HeroHeader({
  routeName,
  profileUri,
  initials,
  onPressProfile,
  onMeasureBottom,
}: {
  routeName: string;
  profileUri: string | null;
  initials: string;
  onPressProfile: () => void;
  onMeasureBottom: (value: number) => void;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const routeKey = (routeName in HEROES ? routeName : 'management') as HeroRouteName;
  const hero = HEROES[routeKey];
  const showBack = !PRIMARY_ROUTES.has(routeName);
  const compact = width < 370;
  const barHeight = compact ? 50 : 54;

  React.useEffect(() => {
    onMeasureBottom(insets.top + barHeight);
  }, [barHeight, insets.top, onMeasureBottom]);

  return (
    <View style={[styles.headerRoot, { height: insets.top + barHeight }]}>
      <LinearGradient
        colors={[hero.tint, HEADER_GRADIENT_MID, HEADER_GRADIENT_END]}
        end={{ x: 1, y: 1 }}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }}
        style={StyleSheet.absoluteFillObject}
      />
      {/* A single diagonal sheen. This is what stops a flat fill from reading
          as flat, and it costs one static gradient. */}
      <LinearGradient
        colors={['rgba(255,255,255,0.20)', 'rgba(255,255,255,0.03)', 'rgba(255,255,255,0)']}
        end={{ x: 0.9, y: 1 }}
        locations={[0, 0.42, 1]}
        start={{ x: 0.05, y: 0 }}
        style={StyleSheet.absoluteFillObject}
      />
      <View pointerEvents="none" style={styles.headerBloom} />
      <View pointerEvents="none" style={styles.headerEdge} />

      <View style={[styles.bar, { height: barHeight, marginTop: insets.top }]}>
        {/* Only a back affordance may lead the title. The medallion that used
            to sit here on primary routes restated the icon of the tab already
            highlighted at the bottom of the screen, and pushed the title in by
            44 pt to do it. */}
        {showBack ? (
          <Pressable
            accessibilityLabel="Go back"
            accessibilityRole="button"
            hitSlop={10}
            onPress={() => {
              if (navigation.canGoBack()) navigation.goBack();
            }}
            style={({ pressed }) => [styles.leadButton, pressed && styles.actionPressed]}>
            <MaterialCommunityIcons color="#FFFFFF" name="arrow-left" size={20} />
          </Pressable>
        ) : null}

        <View style={styles.barCopy}>
          {routeKey === 'map' ? (
            <View style={styles.mapTitleRow}>
              <Image
                contentFit="contain"
                source={require('@/assets/images/glivt-wordmark-cropped.png')}
                style={[styles.heroWordmark, compact && styles.heroWordmarkCompact]}
              />
              <View style={styles.wordmarkDivider} />
              <Text numberOfLines={1} style={[styles.heroTitle, compact && styles.heroTitleCompact]}>
                {hero.title}
              </Text>
            </View>
          ) : (
            <>
              <Text numberOfLines={1} style={[styles.heroTitle, compact && styles.heroTitleCompact]}>
                {hero.title}
              </Text>
              {compact ? null : (
                <Text numberOfLines={1} style={styles.heroSubtitle}>
                  {hero.subtitle}
                </Text>
              )}
            </>
          )}
        </View>

        <HeaderActions initials={initials} onPressProfile={onPressProfile} profileUri={profileUri} />
      </View>
    </View>
  );
}

/**
 * The floating bar's glass.
 *
 * <p>A real backdrop blur, not a translucent fill pretending to be one: this
 * sits over the Live Map, and the difference between the two is exactly
 * visible when the map scrolls underneath. The tint layer above the blur is
 * what keeps label contrast constant - blur alone leaves the bar as light or
 * as dark as whatever happens to be beneath it, so a white label over a pale
 * road becomes unreadable.
 *
 * <p>The hairline along the top edge is the lit rim that makes a glass surface
 * read as a surface rather than a hole.
 */
function TabBarGlass() {
  const { isDark } = useTheme();
  return (
    <View style={styles.tabGlassClip}>
      <BlurView
        intensity={isDark ? 42 : 60}
        style={StyleSheet.absoluteFill}
        tint={isDark ? 'dark' : 'light'}
      />
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: isDark ? 'rgba(17,26,42,0.62)' : 'rgba(255,255,255,0.66)' },
        ]}
      />
      <LinearGradient
        colors={
          isDark
            ? ['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.02)']
            : ['rgba(255,255,255,0.85)', 'rgba(255,255,255,0.18)']
        }
        end={{ x: 0.6, y: 1 }}
        pointerEvents="none"
        start={{ x: 0.1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
      <View
        pointerEvents="none"
        style={[
          styles.tabGlassRim,
          { backgroundColor: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.9)' },
        ]}
      />
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.tabGlassEdge,
          { borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(15,42,80,0.08)' },
        ]}
      />
    </View>
  );
}

export default function AppLayout() {
  const authed = useIsAuthenticated();
  const hasTenant = useHasTenant();
  const bootstrapped = useAppSelector((s) => s.auth.bootstrapped);
  const tenantEpoch = useTenantEpoch();
  const { colors: c, isDark } = useTheme();
  const insets = useSafeAreaInsets();

  const [profileVisible, setProfileVisible] = useState(false);
  const [headerBottom, setHeaderBottom] = useState(insets.top + 54);
  const [profileUri, setProfileUri] = useState<string | null>(null);
  const user = useAppSelector((s) => s.auth.user);
  const displayName = user?.name ?? user?.username ?? 'Fleet user';
  const initials = displayName.substring(0, 2).toUpperCase();

  // The avatar is read once on mount and then only occasionally, because it
  // only ever changes from inside the profile panel. It used to be polled every
  // two seconds off a keyed effect that also tore the timer down and rebuilt it
  // on every value it read - a secure-store round trip and a re-render of the
  // whole navigator, forever, for a value that changes about once a year.
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      SecureStore.getItemAsync(PROFILE_IMG_KEY)
        .then((uri) => {
          if (cancelled) return;
          setProfileUri((current) => (uri && uri !== current ? uri : current));
        })
        .catch(() => {});
    };
    read();
    const interval = setInterval(read, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!bootstrapped) {
    return null;
  }
  if (!hasTenant) {
    return <Redirect href="/company-code" />;
  }
  if (!authed) {
    return <Redirect href="/login" />;
  }

  const bottomPadding = insets.bottom > 0 ? insets.bottom : 8;
  const barHeight = 68 + bottomPadding;

  // The active tab is marked once, by the pill behind it. It also carried a
  // dot underneath and grew its icon two points, so three things changed at
  // once to say one thing - and on the glass the dot read as a smudge.
  const renderTabIcon = (iconName: string, focused: boolean) => {
    return (
      <View
        style={[
          styles.tabIconShell,
          focused && { backgroundColor: hexToRgba(c.accent, isDark ? 0.26 : 0.14) },
        ]}>
        <MaterialCommunityIcons
          color={focused ? c.accent : c.textMuted}
          name={iconName as any}
          size={22}
        />
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.pageBackground }}>
      <MobileGpsTrackingGate />
      <Tabs
        key={`tenant-${tenantEpoch}`}
        // @ts-expect-error - sceneContainerStyle is supported at runtime by BottomTabNavigator but missing in Expo Router's Tabs typings
        sceneContainerStyle={{ backgroundColor: c.pageBackground }}
        screenOptions={{
          header: ({ route }) => (
            <HeroHeader
              initials={initials}
              onMeasureBottom={setHeaderBottom}
              onPressProfile={() => setProfileVisible(true)}
              profileUri={profileUri}
              routeName={route.name}
            />
          ),
          headerTintColor: c.onPrimary,
          headerShadowVisible: false,
          tabBarActiveTintColor: c.accent,
          tabBarInactiveTintColor: c.textMuted,
          // The bar itself is transparent; TabBarGlass draws the surface, so
          // the blur is not fighting an opaque fill painted over it.
          tabBarBackground: () => <TabBarGlass />,
          tabBarStyle: {
            backgroundColor: 'transparent',
            borderRadius: TAB_BAR_RADIUS,
            borderTopWidth: 0,
            bottom: 10,
            elevation: 0,
            height: barHeight,
            left: 12,
            paddingBottom: bottomPadding,
            paddingTop: 7,
            position: 'absolute',
            right: 12,
            shadowColor: '#08172E',
            shadowOffset: { width: 0, height: 10 },
            shadowOpacity: 0.16,
            shadowRadius: 20,
          },
          tabBarHideOnKeyboard: true,
          tabBarLabelStyle: {
            fontSize: 9.5,
            fontWeight: '800',
            marginTop: -2,
          },
          tabBarItemStyle: { paddingHorizontal: 1 },
        }}>
        <Tabs.Screen
          name="map"
          options={{
            title: 'Live Map',
            headerTransparent: true,
            headerTitle: () => <Text style={{ color: c.onPrimary, fontSize: 16, fontWeight: '800' }}>Live Map</Text>,
            tabBarIcon: ({ focused }) => renderTabIcon('map-marker-radius-outline', focused),
          }}
        />
        <Tabs.Screen
          name="vehicles"
          options={{
            title: 'Vehicles',
            headerTitle: 'All Vehicles',
            tabBarIcon: ({ focused }) => renderTabIcon('car', focused),
          }}
        />
        <Tabs.Screen
          name="geofences"
          options={{
            title: 'Geofences',
            tabBarIcon: ({ focused }) => renderTabIcon('vector-polygon', focused),
          }}
        />
        <Tabs.Screen
          name="reports"
          options={{
            title: 'Reports',
            headerTitle: 'Reports',
            tabBarIcon: ({ focused }) => renderTabIcon('file-chart-outline', focused),
          }}
        />
        <Tabs.Screen
          name="management"
          options={{
            title: 'Management',
            headerTitle: 'Management',
            tabBarIcon: ({ focused }) => renderTabIcon('shield-account-outline', focused),
          }}
        />

        {/* Administration routes */}
        <Tabs.Screen
          name="users"
          options={{
            href: null,
            title: 'User Management',
          }}
        />
        <Tabs.Screen
          name="manage-tenants"
          options={{
            href: null,
            title: 'Tenant Management',
          }}
        />
        <Tabs.Screen
          name="tenant-details"
          options={{
            href: null,
            title: 'Tenant Details',
          }}
        />

        {/* Hide other drawer routes from bottom navigation tabs */}
        <Tabs.Screen
          name="settings"
          options={{
            href: null,
            title: 'Settings',
          }}
        />
        <Tabs.Screen
          name="change-password"
          options={{
            href: null,
            title: 'Change Password',
            tabBarStyle: { display: 'none' },
          }}
        />
      </Tabs>

      <ProfileMenu
        anchorTop={headerBottom}
        onClose={() => setProfileVisible(false)}
        visible={profileVisible}
      />
    </View>
  );
}

/** The two fixed stops every section's gradient resolves toward. */
const HEADER_GRADIENT_MID = '#153D8E';
const HEADER_GRADIENT_END = '#0B1F4B';

/** Shared by the bar's own corners and the glass that fills them. */
const TAB_BAR_RADIUS = 26;

const styles = StyleSheet.create({
  tabGlassClip: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: TAB_BAR_RADIUS,
    overflow: 'hidden',
  },
  tabGlassRim: {
    height: StyleSheet.hairlineWidth * 2,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  tabGlassEdge: { borderRadius: TAB_BAR_RADIUS, borderWidth: StyleSheet.hairlineWidth * 2 },
  headerRoot: {
    backgroundColor: HEADER_GRADIENT_END,
    overflow: 'hidden',
  },
  headerBloom: {
    backgroundColor: 'rgba(120, 190, 255, 0.20)',
    borderRadius: 130,
    height: 160,
    position: 'absolute',
    right: -54,
    top: -92,
    width: 220,
  },
  headerEdge: {
    backgroundColor: 'rgba(255,255,255,0.24)',
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  bar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 12,
  },
  leadButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderColor: 'rgba(255,255,255,0.26)',
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  barCopy: { flex: 1, justifyContent: 'center', minWidth: 0 },
  heroTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  heroTitleCompact: { fontSize: 15.5 },
  heroSubtitle: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 8.5,
    fontWeight: '800',
    letterSpacing: 1.25,
    marginTop: 1,
  },
  mapTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 9 },
  heroWordmark: { height: 19, width: 60 },
  heroWordmarkCompact: { height: 17, width: 53 },
  wordmarkDivider: { backgroundColor: 'rgba(255,255,255,0.42)', height: 18, width: 1 },
  heroActions: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  heroActionButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderColor: 'rgba(255,255,255,0.26)',
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  iconPill: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderColor: 'rgba(255,255,255,0.28)',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  profileButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderColor: 'rgba(255,255,255,0.78)',
    borderRadius: 17,
    borderWidth: 1.4,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  profileImage: { borderRadius: 14, height: 28, width: 28 },
  profileFallback: { alignItems: 'center', height: 28, justifyContent: 'center', width: 28 },
  profileInitials: { color: '#FFFFFF', fontSize: 11, fontWeight: '900', letterSpacing: 0.3 },
  actionPressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
  tabIconShell: {
    alignItems: 'center',
    borderRadius: 12,
    height: 30,
    justifyContent: 'center',
    width: 50,
  },
});
