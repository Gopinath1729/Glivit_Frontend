import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TenantFormModal } from '@/src/components/TenantFormModal';
import { ManagementCreateButton } from '@/src/components/ui/ManagementPrimitives';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { apiErrorMessage } from '@/src/services/apiError';
import { useGetUsersQuery } from '@/src/services/operationsApi';
import { switchActiveTenant } from '@/src/services/tenantSwitch';
import {
  useCreateTenantMutation,
  useDeleteTenantMutation,
  useGetTenantsQuery,
  useSwitchTenantMutation,
  useUpdateTenantMutation,
} from '@/src/services/tenantsApi';
import {
  useAppDispatch,
  useCanManageTenants,
  useTenantSwitchState,
} from '@/src/store/hooks';
import { store } from '@/src/store/store';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors, hexToRgba } from '@/src/theme/tokens';
import type { TenantCreateRequest, TenantSummary, TenantUpdateRequest } from '@/src/types/api';

/**
 * Manage Tenants screen.
 * Lists available tenants, allows switching active tenant, creating and editing tenants.
 */
export default function ManageTenantsScreen() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => makeStyles(c), [c]);

  const canManage = useCanManageTenants();
  const switchState = useTenantSwitchState();

  const [formMode, setFormMode] = React.useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = React.useState<TenantSummary | null>(null);

  const tenants = useGetTenantsQuery({ size: 100 });
  const [createTenant, createState] = useCreateTenantMutation();
  const [updateTenant, updateState] = useUpdateTenantMutation();
  const [deleteTenant] = useDeleteTenantMutation();
  const [triggerSwitch] = useSwitchTenantMutation();
  const adminCandidatesQuery = useGetUsersQuery(
    { page: 0, size: 100 },
    { skip: !canManage || formMode !== 'create' }
  );
  const adminAssignmentsQuery = useGetTenantsQuery(
    { page: 0, size: 100 },
    { skip: !canManage || formMode !== 'create' }
  );

  const rows = tenants.data?.content ?? [];
  const adminCandidates = React.useMemo(() => {
    const assignedEmails = new Set(
      (adminAssignmentsQuery.data?.content ?? [])
        .map((tenant) => tenant.adminEmail?.trim().toLowerCase())
        .filter((email): email is string => Boolean(email))
    );
    return (adminCandidatesQuery.data?.content ?? []).filter(
      (member) =>
        member.status === 'ACTIVE' &&
        Boolean(member.mobile?.trim()) &&
        Boolean(member.email?.trim() || member.username?.includes('@')) &&
        !assignedEmails.has((member.email ?? member.username).trim().toLowerCase())
    );
  }, [adminAssignmentsQuery.data?.content, adminCandidatesQuery.data?.content]);
  const switching = switchState.status === 'switching';

  const performSwitch = React.useCallback(
    async (tenant: TenantSummary) => {
      const outcome = await switchActiveTenant({
        dispatch,
        getState: store.getState,
        target: tenant,
        trigger: triggerSwitch,
        onNavigate: () => {
          router.replace('/map' as never);
        },
      });

      if (!outcome.ok) {
        Alert.alert(
          'Switch Failed',
          outcome.message || 'Unable to switch tenant. Please check your credentials.'
        );
        return;
      }
    },
    [dispatch, router, triggerSwitch]
  );

  const onConfirmSwitch = React.useCallback(
    (tenant: TenantSummary) => {
      if (tenant.current) return;
      if (tenant.status !== 'ACTIVE') {
        Alert.alert('Tenant Unavailable', 'Only active tenants can be switched into.');
        return;
      }

      Alert.alert(
        'Switch Company',
        `Switch active organization to ${tenant.name}? Your current map view will update.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Switch',
            style: 'default',
            onPress: () => {
              void performSwitch(tenant);
            },
          },
        ]
      );
    },
    [performSwitch]
  );

  const onCreate = async (body: TenantCreateRequest) => {
    try {
      await createTenant(body).unwrap();
      setFormMode(null);
      setEditing(null);
      Alert.alert('Tenant Created', `${body.name} has been set up.`);
    } catch (error) {
      Alert.alert('Creation Failed', apiErrorMessage(error, 'Tenant could not be created.'));
    }
  };

  const onUpdate = async (id: number, body: TenantUpdateRequest) => {
    try {
      await updateTenant({ id, body }).unwrap();
      setFormMode(null);
      setEditing(null);
      Alert.alert('Tenant Updated', 'The changes have been saved.');
    } catch (error) {
      Alert.alert('Update Failed', apiErrorMessage(error, 'Tenant could not be updated.'));
    }
  };

  const onDelete = (tenant: TenantSummary) => {
    if (!tenant.canDelete) {
      Alert.alert(
        'Tenant cannot be deleted',
        tenant.deleteBlockedReason || 'Switch away from this tenant before deleting it.'
      );
      return;
    }
    Alert.alert(
      'Delete Tenant',
      `Permanently delete ${tenant.name}? All tracking data and member assignments will be removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteTenant({ id: tenant.id, confirmTenantId: tenant.tenantId }).unwrap();
              Alert.alert('Tenant Deleted', `${tenant.name} was removed.`);
            } catch (error) {
              Alert.alert('Delete Failed', apiErrorMessage(error, 'Tenant could not be deleted.'));
            }
          },
        },
      ]
    );
  };

  const openDetails = (tenant: TenantSummary) => {
    router.push({
      pathname: '/tenant-details' as never,
      params: { tenantId: String(tenant.id) },
    });
  };

  if (tenants.isLoading && !tenants.data) {
    return <LoadingView label="Loading tenants…" />;
  }

  if (tenants.isError && !tenants.data) {
    return (
      <ErrorRetryView
        message={apiErrorMessage(tenants.error, 'Tenants could not be loaded')}
        onRetry={tenants.refetch}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.toolbarTop}>
          <View>
            <Text style={styles.heading}>Tenant Management</Text>
            <Text style={styles.subheading}>{rows.length} registered organizations</Text>
          </View>
          {canManage ? (
            <ManagementCreateButton
              accessibilityLabel="Create tenant"
              disabled={switching}
              onPress={() => {
                setEditing(null);
                setFormMode('create');
              }}
            />
          ) : null}
        </View>

      </View>

      <FlatList
        contentContainerStyle={[
          styles.list,
          { paddingBottom: Math.max(insets.bottom, 16) + 88 },
        ]}
        data={rows}
        keyExtractor={(item) => String(item.id)}
        ListEmptyComponent={
          <EmptyView
            icon="office-building-outline"
            message="Add your first tenant to get started"
            title="No tenants yet"
          />
        }
        refreshControl={
          <RefreshControl
            onRefresh={tenants.refetch}
            refreshing={tenants.isFetching}
            tintColor={c.primary}
          />
        }
        renderItem={({ item }) => (
          <TenantRow
            canManage={canManage}
            disabled={switching}
            onDelete={() => onDelete(item)}
            onEdit={() => {
              setEditing(item);
              setFormMode('edit');
            }}
            onPress={() => openDetails(item)}
            onSwitch={() => onConfirmSwitch(item)}
            tenant={item}
          />
        )}
      />

      <TenantFormModal
        adminCandidates={adminCandidates}
        adminCandidatesError={adminCandidatesQuery.error ? apiErrorMessage(adminCandidatesQuery.error) : undefined}
        adminCandidatesLoading={adminCandidatesQuery.isLoading}
        existingTenants={rows}
        mode={formMode ?? 'create'}
        onClose={() => {
          setFormMode(null);
          setEditing(null);
        }}
        onCreate={onCreate}
        onUpdate={onUpdate}
        submitting={createState.isLoading || updateState.isLoading}
        tenant={editing}
        visible={formMode !== null}
      />
    </View>
  );
}

function TenantRow({
  tenant,
  canManage,
  disabled,
  onPress,
  onSwitch,
  onEdit,
  onDelete,
}: {
  tenant: TenantSummary;
  canManage: boolean;
  disabled: boolean;
  onPress: () => void;
  onSwitch: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const status = (tenant.status || 'ACTIVE').toUpperCase();
  const statusColor =
    status === 'ACTIVE' ? c.success : status === 'DISABLED' ? c.danger : c.warningOrange;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: tenant.current }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        tenant.current && styles.cardCurrent,
        pressed && !disabled && { opacity: 0.9 },
        disabled && { opacity: 0.6 },
      ]}>
      <View style={styles.cardTop}>
        <View style={styles.cardTitleWrap}>
          <Text numberOfLines={1} style={styles.cardTitle}>
            {tenant.name}
          </Text>
          <Text numberOfLines={1} style={styles.cardCompany}>
            {tenant.companyName}
          </Text>
        </View>
        {tenant.current ? (
          <View style={styles.currentBadge}>
            <MaterialCommunityIcons color={c.onPrimary} name="check" size={13} />
            <Text style={styles.currentBadgeText}>Current</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.metaGrid}>
        <MetaItem icon="identifier" label="Tenant ID" value={tenant.tenantId} />
        <MetaItem
          icon="email-outline"
          label="Admin email"
          value={tenant.adminEmail ?? 'Not set'}
        />
        <MetaItem
          icon="calendar-blank-outline"
          label="Created"
          value={formatDate(tenant.createdAt)}
        />
      </View>

      <View style={styles.cardBottom}>
        <View
          style={[
            styles.statusPill,
            {
              backgroundColor: hexToRgba(statusColor, 0.13),
              borderColor: hexToRgba(statusColor, 0.33),
            },
          ]}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[styles.statusText, { color: statusColor }]}>{status}</Text>
        </View>

        <View style={styles.actionRow}>
          {canManage ? (
            <>
              <IconAction
                accessibilityLabel={`Edit ${tenant.name}`}
                disabled={disabled}
                icon="pencil-outline"
                onPress={(event) => {
                  event.stopPropagation();
                  onEdit();
                }}
                tint={c.textSecondary}
              />
              <IconAction
                accessibilityLabel={`Delete ${tenant.name}`}
                disabled={disabled}
                icon="trash-can-outline"
                onPress={(event) => {
                  event.stopPropagation();
                  onDelete();
                }}
                tint={tenant.canDelete ? c.danger : c.textMuted}
              />
            </>
          ) : null}
          {!tenant.current ? (
            <IconAction
              accessibilityLabel={`Switch to ${tenant.name}`}
              disabled={disabled || status !== 'ACTIVE'}
              icon="swap-horizontal"
              onPress={(event) => {
                event.stopPropagation();
                onSwitch();
              }}
              tint={c.primary}
            />
          ) : (
            <MaterialCommunityIcons color={c.primary} name="chevron-right" size={22} />
          )}
        </View>
      </View>
    </Pressable>
  );
}

function MetaItem({
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
    <View style={styles.metaItem}>
      <MaterialCommunityIcons color={c.textMuted} name={icon} size={14} />
      <Text numberOfLines={1} style={styles.metaText}>
        <Text style={styles.metaLabel}>{label}: </Text>
        {value}
      </Text>
    </View>
  );
}

function IconAction({
  accessibilityLabel,
  disabled,
  icon,
  onPress,
  tint,
}: {
  accessibilityLabel: string;
  disabled: boolean;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  onPress: (event: GestureResponderEvent) => void;
  tint: string;
}) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconAction,
        pressed && !disabled && { backgroundColor: c.surfaceAlt },
        disabled && { opacity: 0.35 },
      ]}>
      <MaterialCommunityIcons color={tint} name={icon} size={18} />
    </Pressable>
  );
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
    toolbar: {
      backgroundColor: c.surface,
      borderBottomColor: c.border,
      borderBottomWidth: StyleSheet.hairlineWidth * 2,
      gap: spacing.sm,
      padding: spacing.md,
    },
    toolbarTop: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    heading: { color: c.textPrimary, fontSize: typography.h2, fontWeight: '800' },
    subheading: { color: c.textMuted, fontSize: typography.caption, marginTop: 2 },
    list: { flexGrow: 1, gap: spacing.sm, padding: spacing.md },
    card: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      gap: spacing.sm,
      padding: spacing.md,
    },
    cardCurrent: { borderColor: c.primary, backgroundColor: c.accentSoft },
    cardTop: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.sm },
    cardTitleWrap: { flex: 1, minWidth: 0 },
    cardTitle: { color: c.textPrimary, fontSize: typography.body, fontWeight: '900' },
    cardCompany: { color: c.textSecondary, fontSize: typography.caption, marginTop: 1 },
    currentBadge: {
      alignItems: 'center',
      backgroundColor: c.primary,
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 3,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
    },
    currentBadgeText: {
      color: c.onPrimary,
      fontSize: 10,
      fontWeight: '900',
      textTransform: 'uppercase',
    },
    metaGrid: { gap: 3 },
    metaItem: { alignItems: 'center', flexDirection: 'row', gap: 6 },
    metaText: { color: c.textSecondary, flex: 1, fontSize: typography.caption },
    metaLabel: { color: c.textMuted, fontWeight: '700' },
    cardBottom: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 2,
    },
    statusPill: {
      alignItems: 'center',
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: 5,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
    },
    statusDot: { borderRadius: 999, height: 6, width: 6 },
    statusText: { fontSize: 10, fontWeight: '900' },
    actionRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
    iconAction: {
      alignItems: 'center',
      borderRadius: radius.sm,
      height: 32,
      justifyContent: 'center',
      width: 32,
    },
  });
