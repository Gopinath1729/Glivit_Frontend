import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Redirect, Tabs, useNavigation } from 'expo-router';
import React, { useState, useEffect } from 'react';
import { ActivityIndicator, Pressable, Text, View, StyleSheet } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { Image } from 'expo-image';

import { ProfilePanel } from '@/src/components/ProfilePanel';
import { NotificationCenter } from '@/src/components/NotificationCenter';
import { baseApi } from '@/src/services/baseApi';
import {
  useAppSelector,
  useHasTenant,
  useIsAuthenticated,
  useTenantEpoch,
} from '@/src/store/hooks';
import { store } from '@/src/store/store';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius } from '@/src/theme/tokens';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';

function HeaderBackButton() {
  const { colors: c } = useTheme();
  const navigation = useNavigation();
  return (
    <Pressable
      accessibilityLabel="Go back"
      accessibilityRole="button"
      onPress={() => {
        if (navigation.canGoBack()) {
          navigation.goBack();
        }
      }}
      style={{ paddingLeft: 16, paddingRight: 8 }}
      hitSlop={12}
    >
      <MaterialCommunityIcons name="arrow-left" color={c.onPrimary} size={24} />
    </Pressable>
  );
}

function HeaderReloadButton() {
  const [reloading, setReloading] = React.useState(false);
  const { colors: c } = useTheme();

  const handleReload = React.useCallback(async () => {
    if (reloading) return;
    setReloading(true);
    try {
      store.dispatch(
        baseApi.util.invalidateTags([
          'Device',
          'Geofence',
          'Report',
          'Command',
          'User',
          'Project',
          'Group',
          'Audit',
          'Dashboard',
          'Settings',
        ])
      );
      await new Promise((resolve) => setTimeout(resolve, 650));
    } catch {
      // Catch any unexpected store or network error gracefully
    } finally {
      setReloading(false);
    }
  }, [reloading]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Pressable
        accessibilityLabel="Reload page data"
        accessibilityRole="button"
        disabled={reloading}
        hitSlop={12}
        onPress={handleReload}
        style={{ paddingHorizontal: 12, opacity: reloading ? 0.75 : 1 }}>
        {reloading ? (
          <ActivityIndicator color={c.onPrimary} size="small" />
        ) : (
          <MaterialCommunityIcons color={c.onPrimary} name="refresh" size={22} />
        )}
      </Pressable>
    </View>
  );
}

const PROFILE_IMG_KEY = 'glivt.profile.imageUri';

function HeaderRight({
  profileUri,
  initials,
  onPressProfile,
}: {
  profileUri: string | null;
  initials: string;
  onPressProfile: () => void;
}) {
  const { colors: c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingRight: 16 }}>
      <NotificationCenter tint={c.onPrimary} />
      <Pressable onPress={onPressProfile} hitSlop={8}>
        {profileUri ? (
          <Image
            source={{ uri: profileUri }}
            style={{ width: 30, height: 30, borderRadius: 15, borderWidth: 1.5, borderColor: c.onPrimary }}
            contentFit="cover"
          />
        ) : (
          <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(255, 255, 255, 0.25)', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: c.onPrimary }}>
            <Text style={{ color: c.onPrimary, fontSize: 11, fontWeight: '800' }}>{initials}</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

export default function AppLayout() {
  const authed = useIsAuthenticated();
  const hasTenant = useHasTenant();
  const bootstrapped = useAppSelector((s) => s.auth.bootstrapped);
  const tenantEpoch = useTenantEpoch();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();

  const [profileVisible, setProfileVisible] = useState(false);
  const [profileUri, setProfileUri] = useState<string | null>(null);
  const user = useAppSelector((s) => s.auth.user);
  const displayName = user?.name ?? user?.username ?? 'Demo Admin';
  const initials = displayName.substring(0, 2).toUpperCase();

  useEffect(() => {
    let interval = setInterval(() => {
      SecureStore.getItemAsync(PROFILE_IMG_KEY).then(uri => {
        if (uri && uri !== profileUri) setProfileUri(uri);
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(interval);
  }, [profileUri]);

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

  const renderTabIcon = (iconName: string, focused: boolean) => {
    return (
      <MaterialCommunityIcons
        name={iconName as any}
        color={focused ? c.primaryGreen : c.textMuted}
        size={24}
      />
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.pageBackground }}>
      <Tabs
        key={`tenant-${tenantEpoch}`}
        // @ts-expect-error - sceneContainerStyle is supported at runtime by BottomTabNavigator but missing in Expo Router's Tabs typings
        sceneContainerStyle={{ backgroundColor: c.pageBackground }}
        screenOptions={{
          headerStyle: {
            borderBottomLeftRadius: 20,
            borderBottomRightRadius: 20,
            backgroundColor: c.pageBackground,
            elevation: 8,
            shadowColor: c.shadowColor,
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.12,
            shadowRadius: 8,
          },
          headerBackground: () => (
            <LinearGradient
              colors={[c.primaryGreen, c.darkGreen]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={{
                ...StyleSheet.absoluteFillObject,
                borderBottomLeftRadius: 20,
                borderBottomRightRadius: 20,
              }}
            />
          ),
          headerTintColor: c.onPrimary,
          headerTitleStyle: { fontWeight: '800' },
          headerShadowVisible: false,
          tabBarActiveTintColor: c.primaryGreen,
          tabBarInactiveTintColor: c.textMuted,
          tabBarStyle: {
            backgroundColor: c.surface,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            borderTopWidth: 0,
            height: barHeight,
            paddingBottom: bottomPadding,
            paddingTop: 8,
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            elevation: 16,
            shadowColor: c.shadowColor,
            shadowOffset: { width: 0, height: -4 },
            shadowOpacity: 0.08,
            shadowRadius: 12,
          },
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '700',
          },
          headerTitleAlign: 'center',
          headerLeft: () => (
            <View style={{ paddingLeft: 16, justifyContent: 'center', alignItems: 'center' }}>
              <Image
                source={require('@/assets/images/glivt-wordmark-cropped.png')}
                style={{ width: 84, height: 26 }}
                contentFit="contain"
              />
            </View>
          ),
          headerRight: () => (
            <HeaderRight
              profileUri={profileUri}
              initials={initials}
              onPressProfile={() => setProfileVisible(true)}
            />
          ),
        }}>
        <Tabs.Screen
          name="map"
          options={{
            title: 'Live Map',
            headerTransparent: true,
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
            tabBarIcon: ({ focused }) => renderTabIcon('file-chart-outline', focused),
          }}
        />
        <Tabs.Screen
          name="management"
          options={{
            title: 'Management',
            tabBarIcon: ({ focused }) => renderTabIcon('shield-account-outline', focused),
          }}
        />
        
        {/* Hide other drawer routes from bottom navigation tabs */}
        <Tabs.Screen
          name="ai-chat"
          options={{
            href: null,
            title: 'AI Command Centre',
            headerLeft: () => <HeaderBackButton />,
            tabBarStyle: { display: 'none' },
          }}
        />
        <Tabs.Screen
          name="commands"
          options={{
            href: null,
            title: 'Commands',
            headerLeft: () => <HeaderBackButton />,
          }}
        />
        <Tabs.Screen
          name="manage-tenants"
          options={{
            href: null,
            title: 'Manage Tenants',
            headerLeft: () => <HeaderBackButton />,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            href: null,
            title: 'Settings',
            headerLeft: () => <HeaderBackButton />,
          }}
        />
        <Tabs.Screen
          name="timeline"
          options={{
            href: null,
            title: 'Your Timeline',
            headerLeft: () => <HeaderBackButton />,
          }}
        />
      </Tabs>

      {profileVisible && (
        <ProfilePanel visible={profileVisible} onClose={() => setProfileVisible(false)} />
      )}
    </View>
  );
}
