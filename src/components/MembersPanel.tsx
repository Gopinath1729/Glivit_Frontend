import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/src/components/ui/Button';
import { KeyboardAwareForm } from '@/src/components/ui/KeyboardAwareForm';
import {
  ManagementActionButton,
  ManagementBottomSheet,
  ManagementCard,
  ManagementSectionHeader,
} from '@/src/components/ui/ManagementPrimitives';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { TextField } from '@/src/components/ui/TextField';
import { apiErrorMessage } from '@/src/services/apiError';
import {
  useCreateUserMutation,
  useDeleteUserMutation,
  useGetUsersQuery,
  useUpdateUserMutation,
} from '@/src/services/operationsApi';
import { useAppSelector } from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, type ThemeColors } from '@/src/theme/tokens';
import type { ManagedUserDto, MemberStatus } from '@/src/types/api';

/** The two roles a tenant has. Admin manages; User reads. */
type MemberRole = 'ADMIN' | 'COMPANY_USER';

const ROLE_TABS: { id: MemberRole; label: string }[] = [
  { id: 'ADMIN', label: 'Admin' },
  { id: 'COMPANY_USER', label: 'User' },
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function roleLabel(role: MemberRole) {
  return role === 'COMPANY_USER' ? 'User' : 'Admin';
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

/** 7-15 digits once punctuation is stripped. */
function isValidMobile(mobile: string) {
  const digits = mobile.replace(/[^0-9]/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/**
 * The real account state, spelled out.
 *
 * A member the admin just created is PENDING_ACTIVATION, and saying so is the
 * point: labelling them "Active" would claim they can sign in, which they
 * cannot until they have answered the emailed code and chosen a password.
 */
function statusLabel(status: ManagedUserDto['status']) {
  switch (status) {
    case 'PENDING_ACTIVATION':
      return 'Pending Activation';
    case 'ACTIVE':
      return 'Active';
    case 'LOCKED':
      return 'Locked';
    case 'DISABLED':
      return 'Disabled';
    default:
      return String(status ?? '');
  }
}

type Draft = {
  name: string;
  email: string;
  mobile: string;
};

const EMPTY: Draft = { name: '', email: '', mobile: '' };

/**
 * Members tab: the tenant's Admin and User accounts.
 *
 * <p>No password is collected here, by design. The admin provisions the
 * account; the member activates it themselves from the login screen with an
 * emailed code and sets their own password. That is why the create form has
 * three fields and why a new row reads "Pending Activation" rather than
 * "Active" - nobody, including the admin who created it, knows that member's
 * credential.
 */
export function MembersPanel() {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const currentUser = useAppSelector((s) => s.auth.user);

  const [roleTab, setRoleTab] = React.useState<MemberRole>('ADMIN');
  const [createVisible, setCreateVisible] = React.useState(false);
  const [editing, setEditing] = React.useState<ManagedUserDto | null>(null);
  const [draft, setDraft] = React.useState<Draft>(EMPTY);
  const [editDraft, setEditDraft] = React.useState<Draft & { status: MemberStatus }>({
    ...EMPTY,
    status: 'ACTIVE',
  });

  const members = useGetUsersQuery({ role: roleTab, size: 100 });
  const [createUser, createState] = useCreateUserMutation();
  const [updateUser, updateState] = useUpdateUserMutation();
  const [deleteUser] = useDeleteUserMutation();

  // The server filters by role, but a cached page from the other tab can still
  // be on screen for a frame during the switch.
  const rows = React.useMemo(
    () => (members.data?.content ?? []).filter((m) => m.role === roleTab),
    [members.data?.content, roleTab]
  );

  const openCreate = () => {
    setDraft(EMPTY);
    setCreateVisible(true);
  };

  const openEdit = (member: ManagedUserDto) => {
    setEditing(member);
    setEditDraft({
      name: member.name,
      email: member.email || member.username,
      mobile: member.mobile || '',
      status: (member.status as MemberStatus) ?? 'PENDING_ACTIVATION',
    });
  };

  const draftValid = (value: Draft) =>
    value.name.trim().length > 0 &&
    EMAIL_PATTERN.test(normalizeEmail(value.email)) &&
    isValidMobile(value.mobile);

  const submitCreate = async () => {
    // Checked before any await, so a fast double tap cannot create two members.
    if (createState.isLoading) return;
    if (!draftValid(draft)) {
      Alert.alert('Check the form', 'Enter a full name, a valid email address and a mobile number.');
      return;
    }
    try {
      await createUser({
        name: draft.name.trim(),
        email: normalizeEmail(draft.email),
        mobile: draft.mobile.trim(),
        role: roleTab,
        permissions: {},
      }).unwrap();
      setCreateVisible(false);
      setDraft(EMPTY);
      // The mutation invalidates the User tag; the list refetches itself.
      // Appending the response by hand is what produces a duplicate row.
      Alert.alert(
        'Member created',
        'Member created successfully. They can activate the account from the login screen.'
      );
    } catch (err) {
      Alert.alert(`${roleLabel(roleTab)} not created`, apiErrorMessage(err));
    }
  };

  const submitEdit = async () => {
    if (!editing || updateState.isLoading) return;
    if (!draftValid(editDraft)) {
      Alert.alert('Check the form', 'Enter a full name, a valid email address and a mobile number.');
      return;
    }
    const email = normalizeEmail(editDraft.email);
    const emailChanged = email !== normalizeEmail(editing.email || editing.username);

    const apply = async () => {
      try {
        await updateUser({
          id: editing.id,
          body: {
            name: editDraft.name.trim(),
            email,
            mobile: editDraft.mobile.trim(),
            role: editing.role,
            status: editDraft.status,
          },
        }).unwrap();
        setEditing(null);
        Alert.alert(
          'Member updated',
          emailChanged
            ? `${editDraft.name.trim()} must verify ${email} with a code before signing in again.`
            : `${editDraft.name.trim()} has been updated.`
        );
      } catch (err) {
        Alert.alert('Member not updated', apiErrorMessage(err));
      }
    };

    if (emailChanged) {
      // Moving an account to a new address is a security event, not a typo
      // fix: the new mailbox has proved nothing, so the member goes back
      // through activation. The admin should know that before confirming.
      Alert.alert(
        'Change email address?',
        `${editDraft.name.trim()} will be signed out and must verify ${email} using a code before they can sign in again.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Change email', style: 'destructive', onPress: () => void apply() },
        ]
      );
      return;
    }
    await apply();
  };

  const confirmDelete = (member: ManagedUserDto) => {
    if (currentUser?.id === member.id) {
      Alert.alert('Not allowed', 'You cannot delete your own account.');
      return;
    }
    Alert.alert(
      `Delete ${roleLabel(member.role as MemberRole)}`,
      `${member.name} will be disabled and signed out immediately. Their history is kept.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void deleteUser(member.id)
              .unwrap()
              .catch((err) => Alert.alert('Member not deleted', apiErrorMessage(err)));
          },
        },
      ]
    );
  };

  return (
    <View style={styles.flex}>
      <ManagementSectionHeader
        createLabel={`Create ${roleLabel(roleTab)}`}
        onCreate={openCreate}
        subtitle={`${rows.length} ${roleLabel(roleTab).toLowerCase()}${rows.length === 1 ? '' : 's'}`}
        title="Members"
      />

      <View style={styles.roleRow}>
        {ROLE_TABS.map((tab) => {
          const active = roleTab === tab.id;
          return (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              key={tab.id}
              onPress={() => setRoleTab(tab.id)}
              style={[styles.roleChip, active && styles.roleChipActive]}>
              <Text style={[styles.roleChipText, active && styles.roleChipTextActive]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {members.isLoading && !members.data ? (
        <LoadingView label="Loading members…" />
      ) : members.isError && !members.data ? (
        <ErrorRetryView message={apiErrorMessage(members.error)} onRetry={members.refetch} />
      ) : (
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 16) + 88 }]}
          refreshControl={
            <RefreshControl
              refreshing={members.isFetching}
              onRefresh={members.refetch}
              tintColor={c.primary}
            />
          }
          showsVerticalScrollIndicator={false}>
          {rows.length === 0 ? (
            <EmptyView
              icon="account-off-outline"
              title={`No ${roleLabel(roleTab).toLowerCase()} members`}
              message={`Tap + to add a ${roleLabel(roleTab).toLowerCase()} to this tenant.`}
            />
          ) : (
            rows.map((member) => {
              const isSelf = currentUser?.id === member.id;
              const pending = member.status === 'PENDING_ACTIVATION';
              const active = member.status === 'ACTIVE';
              return (
                <ManagementCard key={member.id}>
                  <View style={styles.cardHeader}>
                    <View style={styles.identity}>
                      <View style={styles.memberIcon}>
                        <MaterialCommunityIcons color={c.primary} name="account-outline" size={22} />
                      </View>
                      <View style={styles.identityText}>
                        <Text numberOfLines={1} style={styles.name}>
                          {member.name}
                        </Text>
                        <Text numberOfLines={1} style={styles.meta}>
                          {member.email || member.username}
                        </Text>
                      </View>
                    </View>
                    <View
                      style={[
                        styles.badge,
                        active ? styles.badgeActive : pending ? styles.badgePending : styles.badgeInactive,
                      ]}>
                      <Text
                        style={[
                          styles.badgeText,
                          active
                            ? styles.badgeTextActive
                            : pending
                              ? styles.badgeTextPending
                              : styles.badgeTextInactive,
                        ]}>
                        {statusLabel(member.status)}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Role</Text>
                    <Text style={styles.detailValue}>{roleLabel(member.role as MemberRole)}</Text>
                    {member.mobile ? (
                      <>
                        <Text style={styles.detailLabel}>Mobile</Text>
                        <Text style={styles.detailValue}>{member.mobile}</Text>
                      </>
                    ) : null}
                  </View>

                  <View style={styles.actions}>
                    <ManagementActionButton
                      accessibilityLabel={`Edit ${member.name}`}
                      icon="pencil-outline"
                      label="Edit"
                      onPress={() => openEdit(member)}
                    />
                    {isSelf ? null : (
                      <ManagementActionButton
                        accessibilityLabel={`Delete ${member.name}`}
                        destructive
                        icon="trash-can-outline"
                        label="Delete"
                        onPress={() => confirmDelete(member)}
                      />
                    )}
                  </View>
                </ManagementCard>
              );
            })
          )}
        </ScrollView>
      )}

      {/* Create member */}
      <ManagementBottomSheet
        onClose={() => setCreateVisible(false)}
        title={`Create ${roleLabel(roleTab)}`}
        visible={createVisible}>
        <KeyboardAwareForm
          applyBottomInset={false}
          contentContainerStyle={styles.sheetBody}
          contentSized>
              <Text style={styles.sheetHint}>
                Create a member using their email address. The member can activate the account using
                an email verification code and create their own password.
              </Text>
              <MemberRoleSummary role={roleTab} />
              <TextField
                autoCapitalize="words"
                label="Full Name"
                onChangeText={(name) => setDraft((v) => ({ ...v, name }))}
                placeholder="Full name"
                value={draft.name}
              />
              <TextField
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                error={
                  draft.email.trim() && !EMAIL_PATTERN.test(normalizeEmail(draft.email))
                    ? 'Enter a valid email address'
                    : undefined
                }
                keyboardType="email-address"
                label="Email Address"
                onChangeText={(email) => setDraft((v) => ({ ...v, email }))}
                placeholder="member@company.com"
                value={draft.email}
              />
              <TextField
                error={
                  draft.mobile.trim() && !isValidMobile(draft.mobile)
                    ? 'Enter a valid mobile number'
                    : undefined
                }
                keyboardType="phone-pad"
                label="Mobile Number"
                onChangeText={(mobile) => setDraft((v) => ({ ...v, mobile }))}
                placeholder="+91 98765 43210"
                value={draft.mobile}
              />
              <View style={styles.sheetAction}>
                <Button
                  disabled={!draftValid(draft)}
                  label={`Create ${roleLabel(roleTab).toLowerCase()}`}
                  loading={createState.isLoading}
                  onPress={submitCreate}
                />
              </View>
        </KeyboardAwareForm>
      </ManagementBottomSheet>

      {/* Edit member */}
      <ManagementBottomSheet
        onClose={() => setEditing(null)}
        title="Edit member"
        visible={editing != null}>
        <KeyboardAwareForm
          applyBottomInset={false}
          contentContainerStyle={styles.sheetBody}
          contentSized>
              <MemberRoleSummary
                role={(editing?.role as MemberRole | undefined) ?? roleTab}
              />
              <TextField
                autoCapitalize="words"
                label="Full Name"
                onChangeText={(name) => setEditDraft((v) => ({ ...v, name }))}
                value={editDraft.name}
              />
              <TextField
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                label="Email Address"
                onChangeText={(email) => setEditDraft((v) => ({ ...v, email }))}
                value={editDraft.email}
              />
              <TextField
                keyboardType="phone-pad"
                label="Mobile Number"
                onChangeText={(mobile) => setEditDraft((v) => ({ ...v, mobile }))}
                value={editDraft.mobile}
              />

              <Text style={styles.detailLabel}>Account status</Text>
              <View style={styles.roleRowInline}>
                {/* Active is offered only for a member who has already
                    activated. The server refuses to promote a pending account,
                    so the control must not imply otherwise. */}
                {editing?.status === 'PENDING_ACTIVATION' ? (
                  <View style={[styles.roleChip, styles.roleChipActive]}>
                    <Text style={[styles.roleChipText, styles.roleChipTextActive]}>
                      Pending Activation
                    </Text>
                  </View>
                ) : (
                  <Pressable
                    onPress={() => setEditDraft((v) => ({ ...v, status: 'ACTIVE' }))}
                    style={[styles.roleChip, editDraft.status === 'ACTIVE' && styles.roleChipActive]}>
                    <Text
                      style={[
                        styles.roleChipText,
                        editDraft.status === 'ACTIVE' && styles.roleChipTextActive,
                      ]}>
                      Active
                    </Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => setEditDraft((v) => ({ ...v, status: 'DISABLED' }))}
                  style={[styles.roleChip, editDraft.status === 'DISABLED' && styles.roleChipActive]}>
                  <Text
                    style={[
                      styles.roleChipText,
                      editDraft.status === 'DISABLED' && styles.roleChipTextActive,
                    ]}>
                    Disabled
                  </Text>
                </Pressable>
              </View>
              <Text style={styles.sheetHint}>
                {editing?.status === 'PENDING_ACTIVATION'
                  ? 'This member becomes Active automatically once they activate their account from the login screen.'
                  : 'Members set and change their own password. Use Forgot Password on the login screen if they cannot sign in.'}
              </Text>

              <View style={styles.sheetAction}>
                <Button
                  disabled={!draftValid(editDraft)}
                  label="Save changes"
                  loading={updateState.isLoading}
                  onPress={submitEdit}
                />
              </View>
        </KeyboardAwareForm>
      </ManagementBottomSheet>
    </View>
  );
}

function MemberRoleSummary({ role }: { role: MemberRole }) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const isAdmin = role === 'ADMIN';
  return (
    <View style={styles.roleSummary}>
      <View style={styles.roleSummaryIcon}>
        <MaterialCommunityIcons
          color={c.primary}
          name={isAdmin ? 'shield-account-outline' : 'account-outline'}
          size={21}
        />
      </View>
      <View style={styles.roleSummaryText}>
        <Text style={styles.roleSummaryLabel}>Role</Text>
        <Text style={styles.roleSummaryValue}>{roleLabel(role)}</Text>
        <Text style={styles.roleSummaryHint}>
          {isAdmin ? 'Tenant administrator' : 'Standard tenant member'}
        </Text>
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    roleRow: {
      backgroundColor: c.surface,
      borderBottomColor: c.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.sm,
      paddingBottom: spacing.sm + 2,
      paddingHorizontal: spacing.md,
    },
    roleRowInline: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
    roleChip: {
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 2,
    },
    roleChipActive: { backgroundColor: c.primary, borderColor: c.primary },
    roleChipText: { color: c.textSecondary, fontSize: 13, fontWeight: '700' },
    roleChipTextActive: { color: c.onPrimary },
    content: { gap: spacing.sm + 2, padding: spacing.md, paddingTop: spacing.sm + 2 },
    cardHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    identity: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: spacing.sm, minWidth: 0 },
    memberIcon: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderRadius: radius.md,
      height: 44,
      justifyContent: 'center',
      width: 44,
    },
    identityText: { flex: 1, minWidth: 0 },
    name: { color: c.textPrimary, fontSize: 15, fontWeight: '800' },
    meta: { color: c.textMuted, fontSize: 11, marginTop: 2 },
    badge: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
    badgeActive: { backgroundColor: 'rgba(34, 197, 94, 0.15)' },
    // Amber: a pending member is waiting on the person, not broken and not ready.
    badgePending: { backgroundColor: 'rgba(245, 158, 11, 0.16)' },
    badgeInactive: { backgroundColor: 'rgba(148, 163, 184, 0.15)' },
    badgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.4 },
    badgeTextActive: { color: '#22C55E' },
    badgeTextPending: { color: '#B45309' },
    badgeTextInactive: { color: c.textSecondary },
    detailRow: { alignItems: 'center', columnGap: spacing.sm, flexDirection: 'row', flexWrap: 'wrap' },
    detailLabel: { color: c.textMuted, fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
    detailValue: { color: c.textPrimary, fontSize: 12, fontWeight: '700', marginRight: spacing.sm },
    actions: { flexDirection: 'row', gap: spacing.sm },
    sheetBody: {
      gap: spacing.md,
      paddingBottom: spacing.lg,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
    },
    sheetHint: { color: c.textSecondary, fontSize: 12, lineHeight: 18 },
    sheetAction: { marginTop: spacing.sm },
    roleSummary: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderColor: c.primary,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.sm + 2,
    },
    roleSummaryIcon: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderRadius: radius.sm,
      height: 38,
      justifyContent: 'center',
      width: 38,
    },
    roleSummaryText: { flex: 1, minWidth: 0 },
    roleSummaryLabel: {
      color: c.textMuted,
      fontSize: 10,
      fontWeight: '800',
      textTransform: 'uppercase',
    },
    roleSummaryValue: { color: c.textPrimary, fontSize: 14, fontWeight: '800' },
    roleSummaryHint: { color: c.textSecondary, fontSize: 11, marginTop: 1 },
  });
