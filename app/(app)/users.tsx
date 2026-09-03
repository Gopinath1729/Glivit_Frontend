import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
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

import { UserFormModal } from '@/src/components/UserFormModal';
import { Button } from '@/src/components/ui/Button';
import { Chip } from '@/src/components/ui/ModulePrimitives';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { TextField } from '@/src/components/ui/TextField';
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

  React.useEffect(() => {
    const timer = setTimeout(() => setAppliedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const queryRole = roleFilter === 'ALL' ? undefined : roleFilter;
  const usersQuery = useGetUsersQuery({
    search: appliedSearch || undefined,
    role: queryRole,
    page: 0,
    size: 100,
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
        Alert.alert('User updated', `${body.name} was updated successfully.`);
      } else {
        await createUser(body).unwrap();
        Alert.alert('User created', `${body.name} has been added.`);
      }
      setModalVisible(false);
      setEditingUser(null);
    } catch (err) {
      Alert.alert(
        editingUser ? 'Update failed' : 'Creation failed',
        apiErrorMessage(err, 'Unable to save user.')
      );
    }
  };

  const handleDelete = (user: ManagedUserDto) => {
    Alert.alert(
      'Remove user?',
      `Are you sure you want to deactivate ${user.name}? They will lose access to the system.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteUser(user.id).unwrap();
            } catch (err) {
              Alert.alert('Could not deactivate user', apiErrorMessage(err));
            }
          },
        },
      ]
    );
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

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <View style={styles.toolbarTop}>
          <View>
            <Text style={styles.heading}>User Management</Text>
            <Text style={styles.subheading}>{rows.length} members in this organization</Text>
          </View>
          {canManage ? (
            <Button icon="account-plus" label="Add User" onPress={openCreate} />
          ) : null}
        </View>

        <TextField
          autoCapitalize="none"
          clearButtonMode="while-editing"
          onChangeText={setSearch}
          placeholder="Search by name, email or phone…"
          value={search}
        />

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
        renderItem={({ item }) => (
          <UserCard
            canManage={canManage}
            onDelete={() => handleDelete(item)}
            onEdit={() => openEdit(item)}
            user={item}
          />
        )}
      />

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
          <Text style={[styles.statusText, { color: statusColor }]}>
            {formatStatus(status)}
          </Text>
        </View>
      </View>

      <View style={styles.cardMeta}>
        <MetaRow icon="shield-outline" label="Role" value={formatRole(user.role)} />
        {user.mobile ? (
          <MetaRow icon="phone-outline" label="Phone" value={user.mobile} />
        ) : null}
        {user.address ? (
          <MetaRow icon="map-marker-outline" label="Location" value={user.address} />
        ) : null}
      </View>

      {canManage ? (
        <View style={styles.cardActions}>
          <Pressable
            accessibilityLabel={`Edit ${user.name}`}
            onPress={onEdit}
            style={({ pressed }) => [
              styles.actionBtn,
              pressed && { backgroundColor: c.surfaceAlt },
            ]}>
            <MaterialCommunityIcons color={c.primary} name="pencil-outline" size={18} />
            <Text style={[styles.actionBtnText, { color: c.primary }]}>Edit</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={`Deactivate ${user.name}`}
            onPress={onDelete}
            style={({ pressed }) => [
              styles.actionBtn,
              pressed && { backgroundColor: c.surfaceAlt },
            ]}>
            <MaterialCommunityIcons color={c.danger} name="account-off-outline" size={18} />
            <Text style={[styles.actionBtnText, { color: c.danger }]}>Deactivate</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function MetaRow({
  icon,
  label,
  value,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  value: string;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.metaRow}>
      <MaterialCommunityIcons color={c.textMuted} name={icon} size={15} />
      <Text numberOfLines={1} style={styles.metaText}>
        <Text style={styles.metaLabel}>{label}: </Text>
        {value}
      </Text>
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
    cardMeta: { gap: 4, paddingVertical: spacing.xs },
    metaRow: { alignItems: 'center', flexDirection: 'row', gap: 6 },
    metaText: { color: c.textSecondary, flex: 1, fontSize: typography.caption },
    metaLabel: { color: c.textMuted, fontWeight: '700' },
    cardActions: {
      borderTopColor: c.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: spacing.sm,
      paddingTop: spacing.xs + 2,
    },
    actionBtn: {
      alignItems: 'center',
      borderRadius: radius.sm,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
    },
    actionBtnText: { fontSize: 12, fontWeight: '700' },
  });
