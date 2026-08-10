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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TenantFormModal } from '@/src/components/TenantFormModal';
import { Button } from '@/src/components/ui/Button';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { TextField } from '@/src/components/ui/TextField';
import { apiErrorMessage } from '@/src/services/apiError';
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
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import type { TenantCreateRequest, TenantSummary, TenantUpdateRequest } from '@/src/types/api';

/**
 * Manage Tenants.
 *
 * Reached from the drawer's Switch Company entry, which no longer switches on the
 * spot — tapping a tenant here opens a confirmation dialog first, and only an
 * explicit Yes performs the switch.
 *
 * The list is exactly what the server authorises: a company admin sees their own
 * tenant, a Super Admin sees the platform. Edit and Delete are shown only when the
 * server says the caller may perform them (`canDelete` / the Super Admin role), so
 * the UI never offers an action the backend will refuse.
 */
export default function ManageTenantsScreen() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => makeStyles(c), [c]);

  const canManage = useCanManageTenants();
  const switchState = useTenantSwitchState();

  const [search, setSearch] = React.useState('');
  const [formMode, setFormMode] = React.useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = React.useState<TenantSummary | null>(null);

  // Server-side search keeps the list authoritative; the local box only debounces.
  const [appliedSearch, setAppliedSearch] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const tenants = useGetTenantsQuery({ search: appliedSearch || undefined, size: 100 });
  const [createTenant, createState] = useCreateTenantMutation();
  const [updateTenant, updateState] = useUpdateTenantMutation();
  const [deleteTenant] = useDeleteTenantMutation();
  const [triggerSwitch] = useSwitchTenantMutation();

  const rows = tenants.data?.content ?? [];
  const switching = switchState.status === 'switching';

  // ------------------------------------------------------------------
  // Switching
  // ------------------------------------------------------------------

  const performSwitch = React.useCallback(
    async (tenant: TenantSummary) => {
      const outcome = await switchActiveTenant({
        dispatch,
        getState: store.getState,
        target: tenant,
        trigger: triggerSwitch,
        // Navigation happens only after tenant initialisation succeeded. `replace`
        // rather than `push` so the previous tenant's screens are not left on the
        // stack to be swiped back into.
        onNavigate: () => router.replace('/map'),
      });

      if (outcome.ok) {
        Alert.alert('Tenant switched', `You are now working in ${tenant.name}.`);
        return;
      }
      Alert.alert('Switch failed', outcome.message, [
        { text: 'Close', style: 'cancel' },
        { text: 'Retry', onPress: () => void performSwitch(tenant) },
      ]);
    },
    [dispatch, router, triggerSwitch]
  );

  const confirmSwitch = React.useCallback(
    (tenant: TenantSummary) => {
      if (switching) return;
      if (tenant.current) {
        Alert.alert('Already active', `${tenant.name} is already your active tenant.`);
        return;
      }
      if (tenant.status.toUpperCase() === 'DISABLED') {
        Alert.alert(
          'Tenant disabled',
          `${tenant.name} is disabled and cannot be opened. Set it to Active first.`
        );
        return;
      }
      Alert.alert('Switch Tenant', `Are you sure you want to switch to "${tenant.name}"?`, [
        { text: 'No', style: 'cancel' },
        { text: 'Yes', onPress: () => void performSwitch(tenant) },
      ]);
    },
    [performSwitch, switching]
  );

  // ------------------------------------------------------------------
  // Create / edit / delete
  // ------------------------------------------------------------------

  const onCreate = React.useCallback(
    async (body: TenantCreateRequest) => {
      const created = await createTenant(body).unwrap();
      setFormMode(null);
      // Deliberately no switch: the operator stays where they are, and the new
      // tenant simply appears in the list with completely empty data.
      Alert.alert(
        'Tenant created',
        `${created.name} is ready with System Tenant ID "${created.tenantId}".`
      );
    },
    [createTenant]
  );

  const onUpdate = React.useCallback(
    async (id: number, body: TenantUpdateRequest) => {
      const saved = await updateTenant({ id, body }).unwrap();
      setFormMode(null);
      setEditing(null);
      Alert.alert('Tenant updated', `${saved.name} has been saved.`);
    },
    [updateTenant]
  );

  const runDelete = React.useCallback(
    async (tenant: TenantSummary, confirmTenantId?: string) => {
      try {
        await deleteTenant({ id: tenant.id, confirmTenantId }).unwrap();
        Alert.alert('Tenant deleted', `${tenant.name} and all of its data have been removed.`);
      } catch (error) {
        const message = apiErrorMessage(error);
        // The backend refuses an unconfirmed delete of a tenant that still holds
        // operational data, and its message names exactly what would be destroyed.
        // Surfacing that message verbatim is the safe-confirmation step.
        if (!confirmTenantId && /confirm/i.test(message)) {
          Alert.alert('Confirm deletion', message, [
            { text: 'Cancel', style: 'cancel' },
            {
              text: `Delete ${tenant.tenantId}`,
              style: 'destructive',
              onPress: () => void runDelete(tenant, tenant.tenantId),
            },
          ]);
          return;
        }
        Alert.alert('Tenant not deleted', message);
      }
    },
    [deleteTenant]
  );

  const confirmDelete = React.useCallback(
    (tenant: TenantSummary) => {
      if (!tenant.canDelete) {
        Alert.alert('Cannot delete', tenant.deleteBlockedReason ?? 'This tenant cannot be deleted.');
        return;
      }
      Alert.alert('Delete Tenant', `Delete "${tenant.name}"? This cannot be undone.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void runDelete(tenant) },
      ]);
    },
    [runDelete]
  );

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const listBody = () => {
    if (tenants.isLoading) {
      return <LoadingView label="Loading tenants…" />;
    }
    if (tenants.isError) {
      return (
        <ErrorRetryView
          message={apiErrorMessage(tenants.error)}
          onRetry={() => void tenants.refetch()}
        />
      );
    }
    if (rows.length === 0) {
      return (
        <EmptyView
          icon="office-building-outline"
          message={
            appliedSearch
              ? `No tenant matches "${appliedSearch}".`
              : canManage
                ? 'Create your first tenant to get started.'
                : 'No tenants are available for your account.'
          }
          title={appliedSearch ? 'No matches' : 'No tenants yet'}
        />
      );
    }
    return null;
  };

  const body = listBody();

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <TextField
          autoCapitalize="none"
          leftIcon="magnify"
          onChangeText={setSearch}
          placeholder="Search name, Tenant ID, company or admin email"
          value={search}
        />
        {/*
          Always rendered, never hidden. Tenant creation is a Super Admin action
          enforced by the backend; hiding the button entirely made the capability
          undiscoverable and looked like a missing feature. Showing it disabled with
          the reason states the rule instead of silently omitting it.
        */}
        <Button
          disabled={!canManage}
          icon="plus"
          label="Create Tenant"
          onPress={() => {
            setEditing(null);
            setFormMode('create');
          }}
        />
        {!canManage ? (
          <Text style={styles.permissionHint}>
            Only a Super Admin can create, edit or delete tenants. You can switch between the
            tenants you are authorised for.
          </Text>
        ) : null}
      </View>

      {body ?? (
        <FlatList
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + spacing.xl }]}
          data={rows}
          keyExtractor={(item) => String(item.id)}
          refreshControl={
            <RefreshControl
              onRefresh={() => void tenants.refetch()}
              refreshing={tenants.isFetching && !tenants.isLoading}
              tintColor={c.primary}
            />
          }
          renderItem={({ item }) => (
            <TenantRow
              canManage={canManage}
              disabled={switching}
              onDelete={() => confirmDelete(item)}
              onEdit={() => {
                setEditing(item);
                setFormMode('edit');
              }}
              onPress={() => confirmSwitch(item)}
              tenant={item}
            />
          )}
        />
      )}

      <TenantFormModal
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

      {/*
        The switching overlay is rendered at the root layout, not here: a switch
        remounts this navigator, so an overlay owned by this screen would vanish
        part-way through the transition.
      */}
    </View>
  );
}

function TenantRow({
  tenant,
  canManage,
  disabled,
  onPress,
  onEdit,
  onDelete,
}: {
  tenant: TenantSummary;
  canManage: boolean;
  disabled: boolean;
  onPress: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const status = tenant.status.toUpperCase();
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
        <View style={[styles.statusPill, { backgroundColor: `${statusColor}22`, borderColor: `${statusColor}55` }]}>
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
                onPress={onEdit}
                tint={c.textSecondary}
              />
              <IconAction
                accessibilityLabel={`Delete ${tenant.name}`}
                disabled={disabled || !tenant.canDelete}
                icon="trash-can-outline"
                onPress={onDelete}
                tint={c.danger}
              />
            </>
          ) : null}
          {!tenant.current ? (
            <MaterialCommunityIcons color={c.primary} name="chevron-right" size={22} />
          ) : null}
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
  onPress: () => void;
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
      backgroundColor: c.pageBackground,
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
    },
    permissionHint: {
      color: c.textSecondary,
      fontSize: typography.caption,
      lineHeight: 16,
      paddingHorizontal: spacing.xs,
    },
    list: { gap: spacing.sm, padding: spacing.md },
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
