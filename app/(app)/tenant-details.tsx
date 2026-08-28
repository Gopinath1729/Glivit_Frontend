import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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

const FILTERS: TenantMemberRole[] = ['ALL', 'ADMIN', 'USER', 'DRIVER'];
const PAGE_SIZE = 50;

export default function TenantDetailsScreen() {
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

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
      style={styles.screen}>
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

      <View style={styles.membersCard}>
        <View style={styles.sectionHeading}>
          <View>
            <Text style={styles.sectionTitle}>Members</Text>
            <Text style={styles.sectionHint}>Only members belonging to {selected.name}</Text>
          </View>
          {members.data ? (
            <Text style={styles.memberCount}>{members.data.totalElements}</Text>
          ) : null}
        </View>

        <View style={styles.filterRow}>
          {FILTERS.map((value) => (
            <Chip
              key={value}
              active={filter === value}
              label={filterLabel(value)}
              onPress={() => selectFilter(value)}
            />
          ))}
        </View>

        {members.isLoading || members.isFetching ? (
          <LoadingView label="Loading members…" />
        ) : members.isError ? (
          <ErrorRetryView
            message={apiErrorMessage(members.error, 'Tenant members could not be loaded')}
            onRetry={() => void members.refetch()}
          />
        ) : (members.data?.content.length ?? 0) === 0 ? (
          <EmptyView
            icon="account-group-outline"
            message={`No ${filterLabel(filter).toLowerCase()} members are assigned to this tenant.`}
            title="No members found"
          />
        ) : (
          <View style={styles.memberList}>
            {members.data!.content.map((member) => (
              <MemberRow key={member.id} member={member} />
            ))}
          </View>
        )}

        {(members.data?.totalPages ?? 0) > 1 ? (
          <View style={styles.pagination}>
            <PageButton
              disabled={members.data?.first ?? true}
              icon="chevron-left"
              label="Previous"
              onPress={() => setPage((value) => Math.max(0, value - 1))}
            />
            <Text style={styles.pageText}>
              Page {page + 1} of {members.data?.totalPages ?? 1}
            </Text>
            <PageButton
              disabled={members.data?.last ?? true}
              icon="chevron-right"
              label="Next"
              onPress={() => setPage((value) => value + 1)}
            />
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

function Detail({ icon, label, value }: { icon: React.ComponentProps<typeof MaterialCommunityIcons>['name']; label: string; value: string }) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.detailRow}>
      <MaterialCommunityIcons color={c.textMuted} name={icon} size={17} />
      <View style={styles.detailCopy}>
        <Text style={styles.detailLabel}>{label}</Text>
        <Text selectable style={styles.detailValue}>{value}</Text>
      </View>
    </View>
  );
}

function MemberRow({ member }: { member: ManagedUserDto }) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.memberRow}>
      <View style={styles.avatar}>
        <MaterialCommunityIcons
          color={c.primary}
          name={member.role === 'DRIVER' ? 'steering' : 'account-outline'}
          size={20}
        />
      </View>
      <View style={styles.memberCopy}>
        <View style={styles.memberNameRow}>
          <Text numberOfLines={1} style={styles.memberName}>{member.name}</Text>
          <Text style={styles.roleBadge}>{roleLabel(member.role)}</Text>
        </View>
        <Text numberOfLines={1} style={styles.memberMeta}>{member.email ?? member.username}</Text>
        {member.mobile ? <Text style={styles.memberMeta}>{member.mobile}</Text> : null}
      </View>
      <View style={[styles.activeDot, member.status !== 'ACTIVE' && styles.disabledDot]} />
    </View>
  );
}

function PageButton({ disabled, icon, label, onPress }: { disabled: boolean; icon: 'chevron-left' | 'chevron-right'; label: string; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.pageButton, disabled && styles.pageButtonDisabled, pressed && !disabled && { opacity: 0.75 }]}>
      {icon === 'chevron-left' ? <MaterialCommunityIcons color={disabled ? c.textMuted : c.primary} name={icon} size={17} /> : null}
      <Text style={[styles.pageButtonText, disabled && { color: c.textMuted }]}>{label}</Text>
      {icon === 'chevron-right' ? <MaterialCommunityIcons color={disabled ? c.textMuted : c.primary} name={icon} size={17} /> : null}
    </Pressable>
  );
}

function filterLabel(role: TenantMemberRole) {
  if (role === 'ALL') return 'All';
  if (role === 'ADMIN') return 'Admin';
  if (role === 'USER') return 'User';
  return 'Driver';
}

function roleLabel(role: ManagedUserDto['role']) {
  if (role === 'DRIVER') return 'Driver';
  if (role === 'COMPANY_USER') return 'User';
  return 'Admin';
}

function formatDate(value?: string | null) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat([], { day: '2-digit', month: 'short', year: 'numeric' }).format(parsed);
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    content: { gap: spacing.md, padding: spacing.md },
    tenantCard: { backgroundColor: c.surface, borderColor: c.border, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2, gap: spacing.md, padding: spacing.md },
    headingRow: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.sm },
    headingCopy: { flex: 1, minWidth: 0 },
    title: { color: c.textPrimary, fontSize: typography.h2, fontWeight: '900' },
    company: { color: c.textSecondary, fontSize: typography.caption, marginTop: 2 },
    statusPill: { alignItems: 'center', borderRadius: radius.pill, borderWidth: 1, flexDirection: 'row', gap: 5, paddingHorizontal: spacing.sm, paddingVertical: 4 },
    statusDot: { borderRadius: 99, height: 6, width: 6 },
    statusText: { fontSize: 10, fontWeight: '900' },
    detailsGrid: { gap: spacing.sm },
    detailRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
    detailCopy: { flex: 1, minWidth: 0 },
    detailLabel: { color: c.textMuted, fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
    detailValue: { color: c.textPrimary, fontSize: typography.caption, fontWeight: '700', marginTop: 1 },
    membersCard: { backgroundColor: c.surface, borderColor: c.border, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2, gap: spacing.md, padding: spacing.md },
    sectionHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    sectionTitle: { color: c.textPrimary, fontSize: typography.body, fontWeight: '900' },
    sectionHint: { color: c.textMuted, fontSize: 11, marginTop: 2 },
    memberCount: { backgroundColor: c.accentSoft, borderRadius: radius.pill, color: c.primary, fontSize: typography.caption, fontWeight: '900', minWidth: 28, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 4, textAlign: 'center' },
    filterRow: { alignItems: 'center', alignSelf: 'flex-start', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'flex-start' },
    memberList: { borderColor: c.border, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth * 2, overflow: 'hidden' },
    memberRow: { alignItems: 'center', backgroundColor: c.surface, borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: spacing.sm, padding: spacing.sm },
    avatar: { alignItems: 'center', backgroundColor: c.accentSoft, borderRadius: radius.pill, height: 38, justifyContent: 'center', width: 38 },
    memberCopy: { flex: 1, minWidth: 0 },
    memberNameRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
    memberName: { color: c.textPrimary, flexShrink: 1, fontSize: typography.label, fontWeight: '800' },
    roleBadge: { backgroundColor: c.surfaceAlt, borderRadius: radius.pill, color: c.textSecondary, fontSize: 9, fontWeight: '800', overflow: 'hidden', paddingHorizontal: 6, paddingVertical: 2 },
    memberMeta: { color: c.textSecondary, fontSize: 11, marginTop: 1 },
    activeDot: { backgroundColor: c.success, borderRadius: 99, height: 8, width: 8 },
    disabledDot: { backgroundColor: c.textMuted },
    pagination: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    pageButton: { alignItems: 'center', borderColor: c.border, borderRadius: radius.sm, borderWidth: 1, flexDirection: 'row', gap: 2, paddingHorizontal: spacing.sm, paddingVertical: 7 },
    pageButtonDisabled: { opacity: 0.55 },
    pageButtonText: { color: c.primary, fontSize: 11, fontWeight: '800' },
    pageText: { color: c.textSecondary, fontSize: 11, fontWeight: '700' },
  });
