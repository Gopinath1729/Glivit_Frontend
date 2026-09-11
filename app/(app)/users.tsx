import React, { useMemo, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { UserFormModal } from '@/src/components/UserFormModal';
import { Chip } from '@/src/components/ui/ModulePrimitives';
import {
  ManagementActionButton,
  ManagementCreateButton,
} from '@/src/components/ui/ManagementPrimitives';
import { CompactSearchBar } from '@/src/components/ui/CompactSearchBar';
import { ListPagination } from '@/src/components/ui/ListPagination';
import { useAppDialog } from '@/src/components/ui/useAppDialog';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { P } from '@/src/constants/permissions';
import { apiErrorMessage } from '@/src/services/apiError';
import {
  useCreateUserMutation,
  useDeleteUserMutation,
  useGetUsersQuery,
  useUpdateUserMutation,
  type UserRequest,
} from '@/src/services/operationsApi';
import { useHasPermission } from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import { hexToRgba, radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import type { ManagedUserDto, Role } from '@/src/types/api';

const ROLE_FILTERS: (Role | 'ALL')[] = ['ALL', 'ADMIN', 'TENANT_ADMIN', 'COMPANY_USER'];

const USER_PAGE_SIZE = 10;

export default function UsersScreen() {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(c), [c]);

  const canManage = useHasPermission(P.MANAGE_USERS);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'ALL'>('ALL');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<ManagedUserDto | null>(null);

  const [page, setPage] = useState(0);
  const { confirm, dialogElement, notify } = useAppDialog();

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedSearch(search.trim());
      setPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  // A new filter is a new result set, so it starts at its own first page.
  React.useEffect(() => setPage(0), [roleFilter]);

  const queryRole = roleFilter === 'ALL' ? undefined : roleFilter;
  const usersQuery = useGetUsersQuery({
    search: appliedSearch || undefined,
    role: queryRole,
    page,
    size: USER_PAGE_SIZE,
  });

  const [createUser, createState] = useCreateUserMutation();
  const [updateUser, updateState] = useUpdateUserMutation();
  const [deleteUser] = useDeleteUserMutation();

  const openCreate = () => {
    setEditingUser(null);
    setModalVisible(true);
  };

  const openEdit = (user: ManagedUserDto) => {
    setEditingUser(user);
    setModalVisible(true);
  };

  const handleFormSubmit = async (body: UserRequest) => {
    try {
      if (editingUser) {
        await updateUser({ id: editingUser.id, body }).unwrap();
        setModalVisible(false);
        setEditingUser(null);
        notify({
          message: `${body.name} was updated successfully.`,
          title: 'User updated',
          tone: 'success',
        });
        return;
      }
      await createUser(body).unwrap();
      setModalVisible(false);
      setEditingUser(null);
      notify({
        message: `${body.name} has been added.`,
        title: 'User created',
        tone: 'success',
      });
    } catch (err) {
      notify({
        message: apiErrorMessage(err, 'Unable to save user.'),
        title: editingUser ? 'Update failed' : 'Creation failed',
        tone: 'danger',
      });
    }
  };

  const handleDelete = (user: ManagedUserDto) => {
    confirm({
      confirmLabel: 'Deactivate',
      message: `${user.name} will lose access to the system. Their history is kept.`,
      onConfirm: async () => {
        try {
          await deleteUser(user.id).unwrap();
        } catch (err) {
          notify({
            message: apiErrorMessage(err),
            title: 'Could not deactivate user',
            tone: 'danger',
          });
        }
      },
      title: 'Remove user?',
      tone: 'danger',
    });
  };

  if (usersQuery.isLoading && !usersQuery.data) {
    return <LoadingView label="Loading users…" />;
  }

  if (usersQuery.isError && !usersQuery.data) {
    return (
      <ErrorRetryView
        message={apiErrorMessage(usersQuery.error, 'Users could not be loaded')}
        onRetry={usersQuery.refetch}
      />
    );
  }

  const rows = usersQuery.data?.content ?? [];
  const totalUsers = usersQuery.data?.totalElements ?? rows.length;
  const totalUserPages = usersQuery.data?.totalPages ?? 1;

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.toolbarTop}>
          <View style={styles.headingWrap}>
            <Text style={styles.heading}>User Management</Text>
            <Text style={styles.subheading}>
              {totalUsers} member{totalUsers === 1 ? '' : 's'} in this organization
            </Text>
          </View>
        </View>

        <View style={styles.searchRow}>
          <View style={styles.searchField}>
            <CompactSearchBar
              loading={usersQuery.isFetching && search.trim() === appliedSearch}
              onChangeText={setSearch}
              placeholder="Search by name, email or phone"
              value={search}
            />
          </View>
          {canManage ? (
            <ManagementCreateButton accessibilityLabel="Add user" onPress={openCreate} />
          ) : null}
        </View>

        <View style={styles.filtersRow}>
          {ROLE_FILTERS.map((r) => (
            <Chip
              active={roleFilter === r}
              key={r}
              label={r === 'ALL' ? 'All Roles' : formatRole(r)}
              onPress={() => setRoleFilter(r)}
            />
          ))}
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
            icon="account-search-outline"
            message={
              appliedSearch || roleFilter !== 'ALL'
                ? 'No users match your search and filter criteria.'
                : 'No users found in this organization. Add a user to get started.'
            }
            title="No users found"
          />
        }
        refreshControl={
          <RefreshControl
            onRefresh={usersQuery.refetch}
            refreshing={usersQuery.isFetching}
            tintColor={c.primary}
          />
        }
        ListFooterComponent={
          <ListPagination
            itemLabel="members"
            onPageChange={setPage}
            page={page}
            pageSize={USER_PAGE_SIZE}
            totalItems={totalUsers}
            totalPages={totalUserPages}
          />
        }
        renderItem={({ item }) => (
          <UserCard
            canManage={canManage}
            onDelete={() => handleDelete(item)}
            onEdit={() => openEdit(item)}
            user={item}
          />
        )}
      />

      {dialogElement}

      <UserFormModal
        onClose={() => {
          setModalVisible(false);
          setEditingUser(null);
        }}
        onSubmit={handleFormSubmit}
        submitting={createState.isLoading || updateState.isLoading}
        user={editingUser}
        visible={modalVisible}
      />
    </View>
  );
}

/**
 * One member, as a card.
 *
 * <p>Same anatomy as the Members tab: identity and account state on top, the
 * two facts an administrator actually acts on in a footer strip, and the row
 * actions beside them. Address and phone used to stack as full-width rows,
 * which made a card with a long address twice the height of one without and
 * left the list looking ragged - the footer keeps every card the same height.
 */
function UserCard({
  user,
  canManage,
  onEdit,
  onDelete,
}: {
  user: ManagedUserDto;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);

  const status = (user.status || 'ACTIVE').toUpperCase();
  const statusColor =
    status === 'ACTIVE'
      ? c.success
      : status === 'PENDING_ACTIVATION'
        ? c.warningOrange
        : c.danger;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(user.name || user.username)}</Text>
        </View>
        <View style={styles.identity}>
          <Text numberOfLines={1} style={styles.name}>
            {user.name || user.username}
          </Text>
          <Text numberOfLines={1} style={styles.email}>
            {user.email || user.username}
          </Text>
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
          <Text style={[styles.statusText, { color: statusColor }]}>{formatStatus(status)}</Text>
        </View>
      </View>

      <View style={styles.cardFooter}>
        <View style={styles.facts}>
          <View style={styles.fact}>
            <Text style={styles.factLabel}>Role</Text>
            <Text numberOfLines={1} style={styles.factValue}>
              {formatRole(user.role)}
            </Text>
          </View>
          <View style={styles.factDivider} />
          <View style={[styles.fact, styles.factGrow]}>
            <Text style={styles.factLabel}>Mobile</Text>
            <Text numberOfLines={1} style={styles.factValue}>
              {user.mobile || 'Not set'}
            </Text>
          </View>
        </View>

        {canManage ? (
          <View style={styles.cardActions}>
            <ManagementActionButton
              accessibilityLabel={`Edit ${user.name}`}
              icon="pencil-outline"
              label="Edit"
              onPress={onEdit}
            />
            <ManagementActionButton
              accessibilityLabel={`Deactivate ${user.name}`}
              destructive
              icon="account-off-outline"
              label="Remove"
              onPress={onDelete}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function formatRole(role: string): string {
  if (!role) return 'Member';
  return role.charAt(0) + role.slice(1).toLowerCase().replace(/_/g, ' ');
}

function formatStatus(status: string): string {
  if (status === 'PENDING_ACTIVATION') return 'Pending';
  return status.charAt(0) + status.slice(1).toLowerCase();
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'US';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    cardFooter: {
      alignItems: 'center',
      borderTopColor: c.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: spacing.sm,
      paddingTop: spacing.sm,
    },
    facts: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: spacing.sm, minWidth: 0 },
    fact: { minWidth: 0 },
    factGrow: { flex: 1 },
    factDivider: { backgroundColor: c.border, height: 22, width: StyleSheet.hairlineWidth * 2 },
    factLabel: {
      color: c.textMuted,
      fontSize: 10,
      fontWeight: '800',
      textTransform: 'uppercase',
    },
    factValue: { color: c.textPrimary, fontSize: 12, fontWeight: '700' },
    headingWrap: { flex: 1, minWidth: 0 },
    searchRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
    searchField: { flex: 1, minWidth: 0 },
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
    filtersRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      paddingTop: spacing.xs,
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
    cardHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
    },
    avatar: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderColor: c.primary,
      borderRadius: radius.pill,
      borderWidth: 1.5,
      height: 42,
      justifyContent: 'center',
      width: 42,
    },
    avatarText: {
      color: c.primary,
      fontSize: 15,
      fontWeight: '800',
    },
    identity: { flex: 1, minWidth: 0 },
    name: { color: c.textPrimary, fontSize: typography.body, fontWeight: '800' },
    email: { color: c.textMuted, fontSize: typography.caption, marginTop: 1 },
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
    cardActions: {
      borderTopColor: c.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: spacing.sm,
      paddingTop: spacing.xs + 2,
    },
  });
