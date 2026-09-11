import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import {
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
import { CompactSearchBar } from '@/src/components/ui/CompactSearchBar';
import { ListPagination } from '@/src/components/ui/ListPagination';
import { useAppDialog } from '@/src/components/ui/useAppDialog';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
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
import { radius, spacing, typography, type ThemeColors, hexToRgba } from '@/src/theme/tokens';
import type { TenantCreateRequest, TenantSummary, TenantUpdateRequest } from '@/src/types/api';

/**
 * Manage Tenants screen.
 * Lists available tenants, allows switching active tenant, creating and editing tenants.
 */
const TENANT_PAGE_SIZE = 10;

export default function ManageTenantsScreen() {
  return <TenantManagementPanel />;
}

export function TenantManagementPanel({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => makeStyles(c), [c]);

  const canManage = useCanManageTenants();
  const switchState = useTenantSwitchState();

  const [formMode, setFormMode] = React.useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = React.useState<TenantSummary | null>(null);

  const [searchInput, setSearchInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(0);
  const { confirm, dialogElement, notify } = useAppDialog();

  React.useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const tenants = useGetTenantsQuery(
    { page, search: search || undefined, size: TENANT_PAGE_SIZE },
    { skip: !canManage }
  );
  const [createTenant, createState] = useCreateTenantMutation();
  const [updateTenant, updateState] = useUpdateTenantMutation();
  const [deleteTenant] = useDeleteTenantMutation();
  const [triggerSwitch] = useSwitchTenantMutation();
  const rows = tenants.data?.content ?? [];
  const totalTenants = tenants.data?.totalElements ?? rows.length;
  const totalTenantPages = tenants.data?.totalPages ?? 1;
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
        notify({
          message: outcome.message || 'Unable to switch tenant. Please check your credentials.',
          title: 'Switch failed',
          tone: 'danger',
        });
        return;
      }
    },
    [dispatch, notify, router, triggerSwitch]
  );

  const onConfirmSwitch = React.useCallback(
    (tenant: TenantSummary) => {
      if (tenant.current) return;
      if (tenant.status !== 'ACTIVE') {
        notify({
          message: 'Only active tenants can be switched into.',
          title: 'Tenant unavailable',
          tone: 'info',
        });
        return;
      }

      confirm({
        confirmLabel: 'Switch',
        message: `Switch active organization to ${tenant.name}? Your current map view will update.`,
        onConfirm: () => performSwitch(tenant),
        title: 'Switch organization?',
        tone: 'info',
      });
    },
    [confirm, notify, performSwitch]
  );

  const onCreate = async (body: TenantCreateRequest) => {
    try {
      await createTenant(body).unwrap();
      setFormMode(null);
      setEditing(null);
      notify({
        message: `${body.name} is ready and its administrator activation code was emailed.`,
        title: 'Tenant created',
        tone: 'success',
      });
    } catch (error) {
      notify({
        message: apiErrorMessage(error, 'Tenant could not be created.'),
        title: 'Tenant not created',
        tone: 'danger',
      });
    }
  };

  const onUpdate = async (id: number, body: TenantUpdateRequest) => {
    try {
      await updateTenant({ id, body }).unwrap();
      setFormMode(null);
      setEditing(null);
      notify({
        message: 'The changes have been saved.',
        title: 'Tenant updated',
        tone: 'success',
      });
    } catch (error) {
      notify({
        message: apiErrorMessage(error, 'Tenant could not be updated.'),
        title: 'Tenant not updated',
        tone: 'danger',
      });
    }
  };

  const onDelete = (tenant: TenantSummary) => {
    if (!tenant.canDelete) {
      notify({
        message: tenant.deleteBlockedReason || 'Switch away from this tenant before deleting it.',
        title: 'Tenant cannot be deleted',
        tone: 'info',
      });
      return;
    }
    confirm({
      confirmLabel: 'Delete',
      message: `Permanently delete ${tenant.name}? All tracking data and member assignments will be removed.`,
      onConfirm: async () => {
        try {
          await deleteTenant({ id: tenant.id, confirmTenantId: tenant.tenantId }).unwrap();
          notify({
            message: `${tenant.name} was removed.`,
            title: 'Tenant deleted',
            tone: 'success',
          });
        } catch (error) {
          notify({
            message: apiErrorMessage(error, 'Tenant could not be deleted.'),
            title: 'Tenant not deleted',
            tone: 'danger',
          });
        }
      },
      title: 'Delete tenant?',
      tone: 'danger',
    });
  };

  const openDetails = (tenant: TenantSummary) => {
    router.push({
      pathname: '/tenant-details' as never,
      params: { tenantId: String(tenant.id) },
    });
  };

  if (!canManage) {
    return (
      <View style={styles.screen}>
        <View style={styles.denied}>
          <EmptyView
            icon="shield-lock-outline"
            message="Organization controls are reserved for the platform Super Admin."
            title="Super Admin access required"
          />
        </View>
      </View>
    );
  }

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
      <View style={[styles.toolbar, embedded && styles.toolbarEmbedded]}>
        <View style={styles.toolbarTop}>
          <View style={styles.headingWrap}>
            <Text style={styles.heading}>{embedded ? 'Organizations' : 'Tenant Management'}</Text>
            <Text style={styles.subheading}>
              {totalTenants} registered organization{totalTenants === 1 ? '' : 's'}
            </Text>
          </View>
        </View>

        <View style={styles.searchRow}>
          <View style={styles.searchField}>
            <CompactSearchBar
              loading={tenants.isFetching && searchInput.trim() === search}
              onChangeText={setSearchInput}
              placeholder="Search organizations"
              value={searchInput}
            />
          </View>
          <ManagementCreateButton
            accessibilityLabel="Create tenant"
            disabled={switching}
            onPress={() => {
              setEditing(null);
              setFormMode('create');
            }}
          />
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
            message={
              search
                ? `Nothing matches "${search}". Try a different name or code.`
                : 'Add your first tenant to get started'
            }
            title={search ? 'No matching organizations' : 'No tenants yet'}
          />
        }
        ListFooterComponent={
          <ListPagination
            itemLabel="organizations"
            onPageChange={setPage}
            page={page}
            pageSize={TENANT_PAGE_SIZE}
            totalItems={totalTenants}
            totalPages={totalTenantPages}
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

      {dialogElement}
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
    headingWrap: { flex: 1, minWidth: 0 },
    searchRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
    searchField: { flex: 1, minWidth: 0 },
    denied: { flex: 1, justifyContent: 'center' },
    toolbar: {
      backgroundColor: c.surface,
      borderBottomColor: c.border,
      borderBottomWidth: StyleSheet.hairlineWidth * 2,
      gap: spacing.sm,
      padding: spacing.md,
    },
    toolbarEmbedded: { paddingTop: spacing.sm },
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
