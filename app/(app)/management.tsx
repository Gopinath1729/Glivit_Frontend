import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { TenantManagementPanel } from '@/app/(app)/manage-tenants';
import { MembersPanel } from '@/src/components/MembersPanel';
import { EmptyView } from '@/src/components/ui/StateViews';
import { P } from '@/src/constants/permissions';
import { useCanManageTenants, useHasPermission } from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

type ManagementSection = 'members' | 'organizations';

/** A single administration hub for people, roles and Super Admin organizations. */
export default function ManagementScreen() {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const canManageMembers = useHasPermission(P.MANAGE_USERS);
  const isSuperAdmin = useCanManageTenants();
  const [section, setSection] = useState<ManagementSection>('members');

  if (!canManageMembers && !isSuperAdmin) {
    return (
      <View style={styles.screen}>
        <View style={styles.empty}>
          <EmptyView
            icon="shield-lock-outline"
            message="Ask an administrator for access to people and role management."
            title="Management access required"
          />
        </View>
      </View>
    );
  }

  const activeSection = section === 'organizations' && isSuperAdmin ? section : 'members';
  const organizationsActive = activeSection === 'organizations';

  return (
    <View style={styles.screen}>
      <View style={styles.heroWrap}>
        <LinearGradient
          colors={['#1769D2', '#153C8A', '#0A1D49']}
          end={{ x: 1, y: 1 }}
          locations={[0, 0.58, 1]}
          start={{ x: 0, y: 0 }}
          style={styles.hero}>
          <View pointerEvents="none" style={styles.heroGlow} />
          <View style={styles.heroIcon}>
            <MaterialCommunityIcons color="#FFFFFF" name="shield-crown-outline" size={25} />
          </View>
          <View style={styles.heroCopy}>
            <Text style={styles.eyebrow}>CONTROL CENTER</Text>
            <Text numberOfLines={1} style={styles.title}>Workspace management</Text>
            <Text numberOfLines={2} style={styles.subtitle}>
              {organizationsActive
                ? 'Create organizations, assign their first admin and switch workspaces.'
                : 'Invite people, shape access and keep account ownership clear.'}
            </Text>
          </View>
          <View style={styles.secureBadge}>
            <MaterialCommunityIcons color="#B9D8FF" name="lock-check" size={13} />
            <Text style={styles.secureBadgeText}>{isSuperAdmin ? 'SUPER ADMIN' : 'ADMIN'}</Text>
          </View>
        </LinearGradient>
      </View>

      <View style={styles.segmentBar}>
        {canManageMembers ? (
          <Segment
            active={!organizationsActive}
            icon="account-multiple-outline"
            label="People"
            onPress={() => setSection('members')}
          />
        ) : null}
        {isSuperAdmin ? (
          <Segment
            active={organizationsActive}
            icon="office-building-cog-outline"
            label="Organizations"
            onPress={() => setSection('organizations')}
          />
        ) : null}
      </View>

      <View style={styles.content}>
        {organizationsActive ? <TenantManagementPanel embedded /> : <MembersPanel />}
      </View>
    </View>
  );
}

function Segment({
  active,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  onPress: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.segment,
        active && styles.segmentActive,
        pressed && styles.segmentPressed,
      ]}>
      <MaterialCommunityIcons color={active ? c.primary : c.textMuted} name={icon} size={18} />
      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
      {active ? <View style={styles.segmentIndicator} /> : null}
    </Pressable>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    empty: { flex: 1, justifyContent: 'center' },
    heroWrap: { paddingHorizontal: spacing.md, paddingTop: spacing.sm },
    hero: {
      alignItems: 'center',
      borderRadius: radius.lg,
      elevation: 7,
      flexDirection: 'row',
      gap: spacing.sm + 2,
      minHeight: 104,
      overflow: 'hidden',
      padding: spacing.md,
      shadowColor: '#07142E',
      shadowOffset: { width: 0, height: 7 },
      shadowOpacity: 0.22,
      shadowRadius: 16,
    },
    heroGlow: {
      backgroundColor: 'rgba(120, 196, 255, 0.18)',
      borderRadius: 100,
      height: 150,
      position: 'absolute',
      right: -36,
      top: -86,
      width: 190,
    },
    heroIcon: {
      alignItems: 'center',
      backgroundColor: 'rgba(255,255,255,0.14)',
      borderColor: 'rgba(255,255,255,0.24)',
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      height: 48,
      justifyContent: 'center',
      width: 48,
    },
    heroCopy: { flex: 1, minWidth: 0 },
    eyebrow: { color: '#B9D8FF', fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
    title: { color: '#FFFFFF', fontSize: 18, fontWeight: '900', letterSpacing: -0.35, marginTop: 2 },
    subtitle: { color: 'rgba(255,255,255,0.72)', fontSize: 11, lineHeight: 15, marginTop: 3 },
    secureBadge: {
      alignItems: 'center',
      alignSelf: 'flex-start',
      backgroundColor: 'rgba(5,18,48,0.34)',
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 5,
    },
    secureBadgeText: { color: '#D8EAFF', fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
    segmentBar: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 4,
      marginHorizontal: spacing.md,
      marginTop: spacing.md,
      padding: 4,
    },
    segment: {
      alignItems: 'center',
      borderRadius: radius.sm,
      flex: 1,
      flexDirection: 'row',
      gap: 7,
      justifyContent: 'center',
      minHeight: 42,
      overflow: 'hidden',
      paddingHorizontal: spacing.sm,
      position: 'relative',
    },
    segmentActive: { backgroundColor: c.accentSoft },
    segmentPressed: { opacity: 0.74 },
    segmentText: { color: c.textMuted, fontSize: typography.label, fontWeight: '800' },
    segmentTextActive: { color: c.primary },
    segmentIndicator: {
      backgroundColor: c.primary,
      borderRadius: 2,
      bottom: 0,
      height: 3,
      position: 'absolute',
      width: 34,
    },
    content: { flex: 1, marginTop: spacing.sm, minHeight: 0 },
  });
