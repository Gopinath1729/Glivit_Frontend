import { MaterialCommunityIcons } from '@expo/vector-icons';
import { type DrawerContentComponentProps } from '@react-navigation/drawer';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { P } from '@/src/constants/permissions';
import { authStorage } from '@/src/services/authStorage';
import { useLogoutMutation } from '@/src/services/authApi';
import { baseApi } from '@/src/services/baseApi';
import { clearSession } from '@/src/store/authSlice';
import { clearActiveTenant } from '@/src/store/tenantSlice';
import { useAppDispatch, useAppSelector, useHasPermission } from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

type DrawerRoute =
  | '/vehicles'
  | '/map'
  | '/geofences'
  | '/reports'
  | '/commands'
  | '/management'
  | '/manage-tenants'
  | '/settings';

type DrawerLink = {
  label: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  route: DrawerRoute;
  permission?: string;
  module?: string;
};

const LINKS: DrawerLink[] = [
  { label: 'Live Map', icon: 'map-marker-radius-outline', route: '/map', permission: P.VIEW_ALL_VEHICLES },
  { label: 'All Vehicles', icon: 'car', route: '/vehicles', permission: P.VIEW_ALL_VEHICLES },
  { label: 'Geofences', icon: 'vector-polygon', route: '/geofences', permission: P.MANAGE_GEOFENCES, module: 'geofences' },
  { label: 'Reports', icon: 'file-chart-outline', route: '/reports', permission: P.VIEW_REPORTS, module: 'reports' },
  { label: 'Management', icon: 'shield-account-outline', route: '/management', permission: P.MANAGE_DEVICES },
];

function HeaderBackground() {
  const { colors: c } = useTheme();
  return (
    <View style={StyleSheet.absoluteFill}>
      <View style={[StyleSheet.absoluteFillObject, { backgroundColor: c.primary }]} />
      <Svg height="100%" preserveAspectRatio="none" viewBox="0 0 300 200" width="100%">
        <Defs>
          <LinearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor="#0B8043" stopOpacity={0.35} />
            <Stop offset="100%" stopColor="#066935" stopOpacity={0.35} />
          </LinearGradient>
        </Defs>
        <Rect fill="url(#bgGrad)" height="200" width="300" x="0" y="0" />
        <Path
          d="M 100 0 C 180 60, 240 20, 320 80 L 320 0 Z"
          fill="rgba(255, 255, 255, 0.09)"
        />
        <Path
          d="M 0 40 C 100 100, 200 40, 320 120 L 320 0 L 0 0 Z"
          fill="rgba(255, 255, 255, 0.05)"
        />
      </Svg>
    </View>
  );
}

export function AppDrawerContent(props: DrawerContentComponentProps) {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(c), [c]);
  const tenant = useAppSelector((s) => s.auth.tenantConfig);
  const companyCode = useAppSelector((s) => s.auth.companyCode);
  const user = useAppSelector((s) => s.auth.user);
  const activeTenantCode = useAppSelector((s) => s.tenant.activeTenantCode);
  const activeTenantName = useAppSelector((s) => s.tenant.activeTenantName);
  const activeCompanyName = useAppSelector((s) => s.tenant.activeCompanyName);
  const isSwitchedTenant = useAppSelector(
    (s) =>
      s.auth.user?.homeTenantId != null && s.auth.user.homeTenantId !== s.tenant.activeTenantId
  );

  const canViewAll = useHasPermission(P.VIEW_ALL_VEHICLES);
  const canLive = useHasPermission(P.VIEW_LIVE_LOCATION);
  const canGeofence = useHasPermission(P.MANAGE_GEOFENCES);
  const canReports = useHasPermission(P.VIEW_REPORTS);
  const canCommands = useHasPermission(P.SEND_COMMANDS);
  const canManageDevices = useHasPermission(P.MANAGE_DEVICES);
  const permissionMap: Record<string, boolean> = { [P.VIEW_ALL_VEHICLES]: canViewAll };
  permissionMap[P.VIEW_LIVE_LOCATION] = canLive;
  permissionMap[P.MANAGE_GEOFENCES] = canGeofence;
  permissionMap[P.VIEW_REPORTS] = canReports;
  permissionMap[P.SEND_COMMANDS] = canCommands;
  permissionMap[P.MANAGE_DEVICES] = canManageDevices;
  const enabledModules = new Set((tenant?.enabledModules ?? []).map((m) => m.toLowerCase()));

  const activeRouteName = props.state.routeNames[props.state.index];

  const visible = (links: DrawerLink[]) =>
    links.filter((link) => {
      const allowed = !link.permission || permissionMap[link.permission];
      const moduleEnabled =
        !link.module ||
        enabledModules.size === 0 ||
        enabledModules.has(link.module) ||
        (link.module === 'geofences' && (enabledModules.has('geofencing') || enabledModules.has('geofences')));
      return allowed && moduleEnabled;
    });

  const go = (route: DrawerRoute) => {
    props.navigation.closeDrawer();
    router.push(route as never);
  };



  const displayName = user?.name ?? user?.username ?? 'Demo Admin';
  const tenantLabel = activeTenantName ?? tenant?.appName ?? tenant?.name ?? 'Glivt Demo Fleet';
  const companySublabel = activeCompanyName ?? user?.companyName ?? tenant?.name ?? 'Glivt Demo Logistics Pvt Ltd';
  const tenantCodeLabel = activeTenantCode ?? companyCode ?? 'DEMO';
  const roleLabel = formatRole(user?.role) || 'Admin';

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 24) + spacing.md }]}>
        <HeaderBackground />
        <View style={styles.headerContent}>
          <View style={styles.identityRow}>
            <View style={styles.avatar}>
              {tenant?.logoUrl ? (
                <Image contentFit="cover" source={{ uri: tenant.logoUrl }} style={styles.avatarImage} />
              ) : (
                <Text style={styles.avatarInitials}>{initials(displayName)}</Text>
              )}
            </View>
            <View style={styles.identityText}>
              <Text numberOfLines={1} style={styles.tenantName}>
                {tenantLabel}
              </Text>
              <Text numberOfLines={1} style={styles.companyName}>
                {companySublabel}
              </Text>
            </View>
          </View>

          <View style={styles.userPill}>
            <MaterialCommunityIcons color="#FFFFFF" name="account-outline" size={15} />
            <Text numberOfLines={1} style={styles.userPillText}>
              {displayName}
            </Text>
          </View>

          <View style={styles.chipRow}>
            <Chip icon="shield-outline" label={roleLabel} />
            <Chip icon="card-account-details-outline" label={tenantCodeLabel} />
            {isSwitchedTenant ? <Chip icon="swap-horizontal" label="Switched" /> : null}
          </View>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.items}
        showsVerticalScrollIndicator={false}
        style={styles.scroll}>
        <Text style={styles.sectionHeading}>FLEET</Text>
        {visible(LINKS).map((link) => (
          <DrawerRow
            active={activeRouteName === routeKey(link.route)}
            icon={link.icon}
            key={link.route}
            label={link.label}
            onPress={() => go(link.route)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function Chip({
  icon,
  label,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  if (!label) return null;
  return (
    <View style={styles.chip}>
      <MaterialCommunityIcons color="rgba(255,255,255,0.95)" name={icon} size={13} />
      <Text numberOfLines={1} style={styles.chipText}>
        {label}
      </Text>
    </View>
  );
}

function DrawerRow({
  icon,
  label,
  onPress,
  active = false,
  isLogout = false,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  onPress: () => void;
  active?: boolean;
  isLogout?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);

  const iconColor = isLogout ? c.danger : active ? c.primary : c.textPrimary;
  const textColor = isLogout ? c.danger : active ? c.primary : c.textPrimary;
  const chevronColor = isLogout ? c.danger : active ? c.primary : '#9CA3AF';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        active && styles.rowActive,
        pressed && !active && { backgroundColor: isLogout ? 'rgba(239, 68, 68, 0.08)' : c.surfaceAlt },
      ]}>
      <MaterialCommunityIcons color={iconColor} name={icon} size={22} />
      <Text numberOfLines={1} style={[styles.rowLabel, { color: textColor }, active && styles.rowLabelActive]}>
        {label}
      </Text>
      <MaterialCommunityIcons color={chevronColor} name="chevron-right" size={20} />
    </Pressable>
  );
}

function routeKey(route: DrawerRoute): string {
  return route.replace(/^\//, '');
}

function formatRole(role?: string) {
  if (!role) return '';
  return role.charAt(0) + role.slice(1).toLowerCase().replace(/_/g, ' ');
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'DA';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { backgroundColor: c.surface, flex: 1 },

    // --- Header ---------------------------------------------------------
    header: {
      position: 'relative',
      backgroundColor: c.primary,
      borderBottomLeftRadius: 20,
      borderBottomRightRadius: 20,
      overflow: 'hidden',
      paddingBottom: spacing.lg,
      paddingHorizontal: spacing.md,
    },
    headerContent: {
      gap: spacing.sm + 4,
      zIndex: 1,
    },
    identityRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm + 4,
    },
    avatar: {
      alignItems: 'center',
      backgroundColor: 'rgba(255, 255, 255, 0.22)',
      borderColor: 'rgba(255, 255, 255, 0.4)',
      borderRadius: radius.pill,
      borderWidth: 1.5,
      height: 48,
      justifyContent: 'center',
      overflow: 'hidden',
      width: 48,
    },
    avatarImage: { height: 48, width: 48 },
    avatarInitials: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
    identityText: { flex: 1, minWidth: 0 },
    tenantName: { color: '#FFFFFF', fontSize: 18, fontWeight: '800', letterSpacing: 0.2 },
    companyName: {
      color: 'rgba(255, 255, 255, 0.88)',
      fontSize: 13,
      fontWeight: '400',
      marginTop: 2,
    },

    // --- User Pill ------------------------------------------------------
    userPill: {
      alignItems: 'center',
      alignSelf: 'flex-start',
      backgroundColor: 'rgba(0, 0, 0, 0.20)',
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 6,
      maxWidth: '100%',
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    userPillText: {
      color: '#FFFFFF',
      fontSize: 13,
      fontWeight: '600',
    },

    // --- Chips Row ------------------------------------------------------
    chipRow: {
      alignItems: 'center',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    chip: {
      alignItems: 'center',
      backgroundColor: 'rgba(255, 255, 255, 0.22)',
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 5,
      paddingHorizontal: 11,
      paddingVertical: 5,
    },
    chipText: {
      color: '#FFFFFF',
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.4,
    },

    // --- Menu List ------------------------------------------------------
    scroll: { flex: 1 },
    items: { paddingBottom: spacing.md, paddingTop: spacing.sm },
    sectionHeading: {
      color: c.textMuted,
      fontSize: 11,
      fontWeight: '800',
      letterSpacing: 0.8,
      paddingBottom: spacing.xs,
      paddingHorizontal: spacing.md + 4,
      paddingTop: spacing.xs + 4,
      textTransform: 'uppercase',
    },
    row: {
      alignItems: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: 'transparent',
      flexDirection: 'row',
      gap: spacing.sm + 4,
      marginHorizontal: spacing.sm + 2,
      paddingHorizontal: spacing.md,
      paddingVertical: 11,
      marginVertical: 2,
    },
    rowActive: {
      backgroundColor: c.accentSoft,
      borderColor: 'rgba(34, 197, 94, 0.3)',
    },
    rowLabel: {
      flex: 1,
      fontSize: 15,
      fontWeight: '600',
    },
    rowLabelActive: {
      fontWeight: '700',
    },
    divider: {
      backgroundColor: c.border,
      height: StyleSheet.hairlineWidth * 2,
      marginHorizontal: spacing.md + 4,
      marginVertical: spacing.sm + 2,
    },

    // --- Footer ---------------------------------------------------------
    footer: {
      backgroundColor: c.surface,
      borderTopColor: c.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: spacing.xs,
      paddingTop: spacing.xs,
    },
  });

