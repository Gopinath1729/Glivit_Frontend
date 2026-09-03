import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Chip } from '@/src/components/ui/ModulePrimitives';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { apiErrorMessage } from '@/src/services/apiError';
import {
  useGetTenantMembersQuery,
  useGetTenantQuery,
} from '@/src/services/tenantsApi';
import { useTheme } from '@/src/theme/ThemeProvider';
import { hexToRgba, radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import type { ManagedUserDto, TenantMemberRole } from '@/src/types/api';

const FILTERS: TenantMemberRole[] = ['ALL', 'ADMIN', 'USER'];
const PAGE_SIZE = 50;

export default function TenantDetailsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tenantId?: string | string[] }>();
  const rawTenantId = Array.isArray(params.tenantId) ? params.tenantId[0] : params.tenantId;
  const parsedTenantId = Number(rawTenantId);
  const tenantId = Number.isSafeInteger(parsedTenantId) && parsedTenantId > 0 ? parsedTenantId : null;
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [filter, setFilter] = React.useState<TenantMemberRole>('ALL');
  const [page, setPage] = React.useState(0);

  const tenant = useGetTenantQuery(tenantId ?? 0, { skip: tenantId == null });
  const members = useGetTenantMembersQuery(
    { id: tenantId ?? 0, role: filter, page, size: PAGE_SIZE },
    { skip: tenantId == null }
  );

  const selectFilter = (next: TenantMemberRole) => {
    setFilter(next);
    setPage(0);
  };

  if (tenantId == null) {
    return (
      <View style={styles.screen}>
        <EmptyView
          icon="office-building-remove-outline"
          message="The tenant link is invalid. Return to Manage Tenants and select a tenant again."
          title="Tenant unavailable"
        />
      </View>
    );
  }

  if (tenant.isLoading) {
    return <LoadingView label="Loading tenant details…" />;
  }

  if (tenant.isError || !tenant.data) {
    return (
      <ErrorRetryView
        message={apiErrorMessage(tenant.error, 'Tenant details could not be loaded')}
        onRetry={() => void tenant.refetch()}
      />
    );
  }

  const selected = tenant.data;
  const statusColor =
    selected.status === 'ACTIVE' ? c.success : selected.status === 'DISABLED' ? c.danger : c.warningOrange;

  const memberRows = members.data?.content ?? [];

  return (
    <View style={styles.screen}>
      <FlatList
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, 16) + 88 },
        ]}
        data={memberRows}
        keyExtractor={(item) => String(item.id)}
        ListEmptyComponent={
          <EmptyView
            icon="account-group-outline"
            message={
              filter === 'ALL'
                ? 'No members have been assigned to this tenant yet.'
                : `No members with the ${filter} role in this tenant.`
            }
            title="No members found"
          />
        }
        ListHeaderComponent={
          <View style={styles.headerSection}>
            <View style={styles.tenantCard}>
              <View style={styles.headingRow}>
                <View style={styles.headingCopy}>
                  <Text style={styles.title}>{selected.name}</Text>
                  <Text style={styles.company}>{selected.companyName}</Text>
                </View>
                <View
                  style={[
                    styles.statusPill,
                    {
                      backgroundColor: hexToRgba(statusColor, 0.12),
                      borderColor: hexToRgba(statusColor, 0.32),
                    },
                  ]}>
                  <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                  <Text style={[styles.statusText, { color: statusColor }]}>{selected.status}</Text>
                </View>
              </View>

              <View style={styles.detailsGrid}>
                <Detail icon="identifier" label="Tenant ID" value={selected.tenantId} />
                <Detail icon="account-outline" label="Administrator" value={selected.adminName ?? 'Not set'} />
                <Detail icon="email-outline" label="Admin Email" value={selected.adminEmail ?? 'Not set'} />
                <Detail icon="phone-outline" label="Phone Number" value={selected.adminPhone ?? 'Not set'} />
                <Detail icon="calendar-blank-outline" label="Created" value={formatDate(selected.createdAt)} />
              </View>
            </View>

            <View style={styles.rosterHeader}>
              <View>
                <Text style={styles.rosterTitle}>Organization Members</Text>
                <Text style={styles.rosterSubtitle}>
                  {members.data?.totalElements ?? memberRows.length} total members
                </Text>
              </View>
            </View>

            <View style={styles.filtersRow}>
              {FILTERS.map((f) => (
                <Chip
                  active={filter === f}
                  key={f}
                  label={f === 'ALL' ? 'All Roles' : formatRole(f)}
                  onPress={() => selectFilter(f)}
                />
              ))}
            </View>
          </View>
        }
        renderItem={({ item }) => <MemberRow member={item} />}
      />
    </View>
  );
}

function MemberRow({ member }: { member: ManagedUserDto }) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);

  const status = (member.status || 'ACTIVE').toUpperCase();
  const statusColor =
    status === 'ACTIVE'
      ? c.success
      : status === 'PENDING_ACTIVATION'
        ? c.warningOrange
        : c.danger;

  return (
    <View style={styles.memberCard}>
      <View style={styles.memberAvatar}>
        <Text style={styles.memberAvatarText}>
          {initials(member.name || member.username)}
        </Text>
      </View>
      <View style={styles.memberInfo}>
        <Text numberOfLines={1} style={styles.memberName}>
          {member.name || member.username}
        </Text>
        <Text numberOfLines={1} style={styles.memberEmail}>
          {member.email || member.username}
        </Text>
        <View style={styles.memberTags}>
          <Text style={styles.memberRole}>{formatRole(member.role)}</Text>
          {member.mobile ? <Text style={styles.memberPhone}>• {member.mobile}</Text> : null}
        </View>
      </View>
      <View
        style={[
          styles.statusPill,
          {
            backgroundColor: hexToRgba(statusColor, 0.12),
            borderColor: hexToRgba(statusColor, 0.32),
          },
        ]}>
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
        <Text style={[styles.statusText, { color: statusColor }]}>{status}</Text>
      </View>
    </View>
  );
}

function Detail({
  icon,
  label,
  value,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  value: string;
}) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.detailRow}>
      <MaterialCommunityIcons color={c.textMuted} name={icon} size={16} />
      <Text numberOfLines={1} style={styles.detailText}>
        <Text style={styles.detailLabel}>{label}: </Text>
        {value}
      </Text>
    </View>
  );
}

function formatRole(role: string): string {
  return role.charAt(0) + role.slice(1).toLowerCase().replace(/_/g, ' ');
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'US';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat([], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(parsed);
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    content: { gap: spacing.sm, padding: spacing.md },
    headerSection: { gap: spacing.md, marginBottom: spacing.xs },
    tenantCard: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      gap: spacing.sm,
      padding: spacing.md,
    },
    headingRow: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    headingCopy: { flex: 1, minWidth: 0 },
    title: { color: c.textPrimary, fontSize: typography.h2, fontWeight: '800' },
    company: { color: c.textSecondary, fontSize: typography.body, marginTop: 2 },
    detailsGrid: { gap: 6, marginTop: spacing.xs },
    detailRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
    detailText: { color: c.textSecondary, flex: 1, fontSize: typography.body },
    detailLabel: { color: c.textMuted, fontWeight: '700' },
    rosterHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: spacing.sm,
    },
    rosterTitle: { color: c.textPrimary, fontSize: typography.body, fontWeight: '800' },
    rosterSubtitle: { color: c.textMuted, fontSize: typography.caption, marginTop: 1 },
    filtersRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    memberCard: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.md,
    },
    memberAvatar: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderColor: c.primary,
      borderRadius: radius.pill,
      borderWidth: 1.5,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    memberAvatarText: { color: c.primary, fontSize: 14, fontWeight: '800' },
    memberInfo: { flex: 1, minWidth: 0 },
    memberName: { color: c.textPrimary, fontSize: typography.body, fontWeight: '700' },
    memberEmail: { color: c.textMuted, fontSize: typography.caption, marginTop: 1 },
    memberTags: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
    memberRole: { color: c.primary, fontSize: 11, fontWeight: '700' },
    memberPhone: { color: c.textMuted, fontSize: 11 },
    statusPill: {
      alignItems: 'center',
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
    },
    statusDot: { borderRadius: 999, height: 6, width: 6 },
    statusText: { fontSize: 10, fontWeight: '900' },
  });
