import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/src/components/ui/Button';
import { KeyboardAwareForm } from '@/src/components/ui/KeyboardAwareForm';
import { Chip } from '@/src/components/ui/ModulePrimitives';
import {
  SearchableDropdown,
  type DropdownOption,
} from '@/src/components/ui/SearchableDropdown';
import { TextField } from '@/src/components/ui/TextField';
import { apiErrorMessage } from '@/src/services/apiError';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import type {
  ApiResponse,
  ManagedUserDto,
  TenantCreateRequest,
  TenantStatus,
  TenantSummary,
  TenantUpdateRequest,
} from '@/src/types/api';

const STATUSES: TenantStatus[] = ['ACTIVE', 'DISABLED', 'MAINTENANCE'];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{7,19}$/;

type Draft = {
  name: string;
  tenantId: string;
  companyName: string;
  adminUserId?: number;
  adminName: string;
  adminEmail: string;
  adminPhone: string;
  status: TenantStatus;
};

type FieldErrors = Partial<Record<keyof Draft, string>>;

const EMPTY: Draft = {
  name: '',
  tenantId: '',
  companyName: '',
  adminUserId: undefined,
  adminName: '',
  adminEmail: '',
  adminPhone: '',
  status: 'ACTIVE',
};

function draftFrom(tenant: TenantSummary | null): Draft {
  if (!tenant) return EMPTY;
  return {
    name: tenant.name,
    tenantId: tenant.tenantId,
    companyName: tenant.companyName,
    adminUserId: undefined,
    adminName: tenant.adminName ?? '',
    adminEmail: tenant.adminEmail ?? '',
    adminPhone: tenant.adminPhone ?? '',
    status: (STATUSES.includes(tenant.status as TenantStatus)
      ? tenant.status
      : 'ACTIVE') as TenantStatus,
  };
}

/**
 * Validates the whole draft.
 *
 * Duplicate checks run against the tenant list the caller can already see, so the
 * common case is caught inline before a round trip. They are not the security
 * boundary — the backend re-checks every one of them against database unique keys,
 * which is what makes two simultaneous creates safe.
 */
export function validateTenantDraft(
  draft: Draft,
  mode: 'create' | 'edit',
  existing: TenantSummary[],
  editingId?: number
): FieldErrors {
  const errors: FieldErrors = {};
  const others = existing.filter((t) => t.id !== editingId);

  const name = draft.name.trim();
  if (!name) errors.name = 'Tenant name is required';
  else if (name.length > 160) errors.name = 'Tenant name must be 160 characters or fewer';
  else if (others.some((t) => t.name.trim().toLowerCase() === name.toLowerCase())) {
    errors.name = 'Another tenant already uses this name';
  }

  const companyName = draft.companyName.trim();
  if (!companyName) errors.companyName = 'Company name is required';
  else if (companyName.length > 160) {
    errors.companyName = 'Company name must be 160 characters or fewer';
  }

  if (mode === 'create' && !draft.adminUserId) {
    errors.adminUserId = 'Choose an administrator';
  }

  const adminName = draft.adminName.trim();
  if (!adminName) errors.adminName = 'Admin name is required';
  else if (adminName.length > 160) errors.adminName = 'Admin name must be 160 characters or fewer';

  const adminEmail = draft.adminEmail.trim();
  if (!adminEmail) errors.adminEmail = 'Admin email is required';
  else if (!EMAIL_PATTERN.test(adminEmail)) errors.adminEmail = 'Enter a valid email address';
  else if (
    others.some((t) => (t.adminEmail ?? '').trim().toLowerCase() === adminEmail.toLowerCase())
  ) {
    errors.adminEmail = 'Another tenant already uses this admin email';
  }

  const adminPhone = draft.adminPhone.trim();
  if (!adminPhone) errors.adminPhone = 'Phone number is required';
  else if (!PHONE_PATTERN.test(adminPhone)) {
    errors.adminPhone = 'Enter a valid phone number (8-20 digits, optional +)';
  }

  if (!STATUSES.includes(draft.status)) errors.status = 'Choose a tenant status';

  return errors;
}

/**
 * Maps a rejected request back onto the field that caused it.
 *
 * The server is the authority on uniqueness, so its 409 has to land on the same
 * input the inline check would have flagged — otherwise a duplicate detected only
 * server-side would surface as an unexplained banner.
 */
function serverFieldErrors(error: unknown): { fields: FieldErrors; banner: string | null } {
  const envelope = (error as { data?: ApiResponse<unknown> } | undefined)?.data;
  const apiError = envelope?.error;
  const fields: FieldErrors = {};

  if (apiError?.fieldErrors) {
    for (const [key, message] of Object.entries(apiError.fieldErrors)) {
      if (key in EMPTY) fields[key as keyof Draft] = message;
    }
  }

  const message = apiError?.message ?? '';
  if (/tenant id/i.test(message)) fields.tenantId = message;
  else if (/tenant name/i.test(message)) fields.name = message;
  else if (/admin email/i.test(message)) fields.adminEmail = message;

  const banner = Object.keys(fields).length > 0 ? null : apiErrorMessage(error);
  return { fields, banner };
}

export function TenantFormModal({
  visible,
  mode,
  tenant,
  existingTenants,
  adminCandidates,
  adminCandidatesLoading,
  adminCandidatesError,
  submitting,
  onClose,
  onCreate,
  onUpdate,
}: {
  visible: boolean;
  mode: 'create' | 'edit';
  tenant: TenantSummary | null;
  existingTenants: TenantSummary[];
  adminCandidates: ManagedUserDto[];
  adminCandidatesLoading?: boolean;
  adminCandidatesError?: string;
  submitting: boolean;
  onClose: () => void;
  onCreate: (body: TenantCreateRequest) => Promise<void>;
  onUpdate: (id: number, body: TenantUpdateRequest) => Promise<void>;
}) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => makeStyles(c), [c]);

  const [draft, setDraft] = React.useState<Draft>(EMPTY);
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [banner, setBanner] = React.useState<string | null>(null);
  const [touched, setTouched] = React.useState(false);

  const adminOptions = React.useMemo<DropdownOption[]>(
    () =>
      adminCandidates.map((member) => ({
        id: member.id,
        label: member.name,
        subLabel: `${roleLabel(member.role)} · ${member.email ?? member.username}`,
        phone: member.mobile ?? undefined,
        searchTags: [member.username, member.email ?? '', roleLabel(member.role)],
      })),
    [adminCandidates]
  );

  // Reopening the form must never show the previous tenant's values or errors.
  React.useEffect(() => {
    if (!visible) return;
    setDraft(draftFrom(mode === 'edit' ? tenant : null));
    setErrors({});
    setBanner(null);
    setTouched(false);
  }, [visible, mode, tenant]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    // Clearing the field's own error as it is edited keeps the message tied to the
    // current value instead of a stale one.
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
    setBanner(null);
  };

  const selectAdmin = (option: DropdownOption | undefined) => {
    const member = option
      ? adminCandidates.find((candidate) => candidate.id === option.id)
      : undefined;
    setDraft((prev) => ({
      ...prev,
      adminUserId: member?.id,
      adminName: member?.name ?? '',
      adminEmail: member?.email ?? (member?.username.includes('@') ? member.username : ''),
      adminPhone: member?.mobile ?? '',
    }));
    setErrors((prev) => ({
      ...prev,
      adminUserId: undefined,
      adminName: undefined,
      adminEmail: undefined,
      adminPhone: undefined,
    }));
    setBanner(null);
  };

  const submit = async () => {
    if (submitting) return;
    setTouched(true);
    const found = validateTenantDraft(draft, mode, existingTenants, tenant?.id);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setBanner(null);
      return;
    }

    try {
      if (mode === 'create') {
        await onCreate({
          name: draft.name.trim(),
          companyName: draft.companyName.trim(),
          adminUserId: draft.adminUserId!,
          status: draft.status,
        });
      } else if (tenant) {
        await onUpdate(tenant.id, {
          name: draft.name.trim(),
          companyName: draft.companyName.trim(),
          adminName: draft.adminName.trim(),
          adminEmail: draft.adminEmail.trim(),
          adminPhone: draft.adminPhone.trim(),
          status: draft.status,
        });
      }
    } catch (error) {
      const mapped = serverFieldErrors(error);
      setErrors(mapped.fields);
      setBanner(mapped.banner);
    }
  };

  const liveErrors = touched ? errors : {};

  return (
    <Modal animationType="slide" onRequestClose={onClose} statusBarTranslucent visible={visible}>
      <View style={styles.flex}>
        <View style={[styles.header, { paddingTop: Math.max(insets.top + spacing.sm, spacing.lg) }]}>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            hitSlop={12}
            onPress={onClose}
            style={styles.headerButton}>
            <MaterialCommunityIcons color={c.onPrimary} name="arrow-left" size={24} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.headerEyebrow}>TENANT MANAGEMENT</Text>
            <Text numberOfLines={1} style={styles.headerTitle}>
              {mode === 'create' ? 'Create tenant' : 'Edit tenant'}
            </Text>
            <Text style={styles.headerSubtitle}>
              {mode === 'create'
                ? 'Set up the organization and assign its first administrator.'
                : 'Update organization, administrator and access details.'}
            </Text>
          </View>
        </View>

        <KeyboardAwareForm
          applyBottomInset={false}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: Math.max(insets.bottom, spacing.md) + spacing.xl },
          ]}
          extraOffset={32}
          style={styles.flex}>
          <View style={styles.page}>
            {banner ? (
              <View style={styles.banner}>
                <MaterialCommunityIcons color={c.danger} name="alert-circle-outline" size={18} />
                <Text style={styles.bannerText}>{banner}</Text>
              </View>
            ) : null}

            <View style={styles.sectionCard}>
              <View style={styles.sectionHeader}>
                <View style={styles.sectionIcon}>
                  <MaterialCommunityIcons color={c.primary} name="office-building-outline" size={20} />
                </View>
                <View style={styles.sectionCopy}>
                  <Text style={styles.sectionTitle}>Organization details</Text>
                  <Text style={styles.sectionSubtitle}>The names shown throughout the fleet workspace.</Text>
                </View>
              </View>
              <View style={styles.fieldStack}>
                <TextField
                  error={liveErrors.name}
                  label="Tenant Name"
                  onChangeText={(v) => set('name', v)}
                  placeholder="Northern Fleet Operations"
                  value={draft.name}
                />
                {mode === 'edit' ? (
                  <View>
                    <Text style={styles.readOnlyLabel}>Tenant ID (System Identifier)</Text>
                    <View style={styles.readOnlyBox}>
                      <Text style={styles.readOnlyValue}>{draft.tenantId}</Text>
                      <MaterialCommunityIcons color={c.textMuted} name="lock-outline" size={16} />
                    </View>
                    <Text style={styles.readOnlyHint}>Auto-generated internal system identifier.</Text>
                  </View>
                ) : null}
                <TextField
                  error={liveErrors.companyName}
                  label="Company Name"
                  onChangeText={(v) => set('companyName', v)}
                  placeholder="Northern Logistics Pvt Ltd"
                  value={draft.companyName}
                />
              </View>
            </View>

            <View style={styles.sectionCard}>
              <View style={styles.sectionHeader}>
                <View style={styles.sectionIcon}>
                  <MaterialCommunityIcons color={c.primary} name="account-tie-outline" size={20} />
                </View>
                <View style={styles.sectionCopy}>
                  <Text style={styles.sectionTitle}>Tenant administrator</Text>
                  <Text style={styles.sectionSubtitle}>Choose the member responsible for this organization.</Text>
                </View>
              </View>
              <View style={styles.fieldStack}>
                {mode === 'create' ? (
                  <SearchableDropdown
                    emptyText="No available members found"
                    error={liveErrors.adminUserId ?? adminCandidatesError}
                    label="Admin Name"
                    loading={adminCandidatesLoading}
                    onSelect={selectAdmin}
                    options={adminOptions}
                    placeholder="Choose an admin or member"
                    selectedId={draft.adminUserId}
                  />
                ) : (
                  <TextField
                    error={liveErrors.adminName}
                    label="Admin Name"
                    onChangeText={(v) => set('adminName', v)}
                    placeholder="Priya Sharma"
                    value={draft.adminName}
                  />
                )}
                <TextField
                  autoCapitalize="none"
                  editable={mode !== 'create'}
                  error={liveErrors.adminEmail}
                  keyboardType="email-address"
                  label="Admin Email"
                  onChangeText={(v) => set('adminEmail', v.trim())}
                  placeholder="admin@northfleet.com"
                  value={draft.adminEmail}
                />
                <TextField
                  editable={mode !== 'create'}
                  error={liveErrors.adminPhone}
                  keyboardType="phone-pad"
                  label="Phone Number"
                  onChangeText={(v) => set('adminPhone', v)}
                  placeholder="+91 98765 43210"
                  value={draft.adminPhone}
                />
                {mode === 'create' ? (
                  <View style={styles.infoNote}>
                    <MaterialCommunityIcons color={c.primary} name="information-outline" size={17} />
                    <Text style={styles.infoNoteText}>
                      Contact details come from the selected member. They activate their own account
                      and choose their password from the login screen.
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>

            <View style={styles.sectionCard}>
              <View style={styles.sectionHeader}>
                <View style={styles.sectionIcon}>
                  <MaterialCommunityIcons color={c.primary} name="shield-check-outline" size={20} />
                </View>
                <View style={styles.sectionCopy}>
                  <Text style={styles.sectionTitle}>Access status</Text>
                  <Text style={styles.sectionSubtitle}>Control sign-in and tenant-switch availability.</Text>
                </View>
              </View>
              <View style={styles.fieldStack}>
                <View style={styles.statusRow}>
                  {STATUSES.map((status) => (
                    <Chip
                      key={status}
                      active={draft.status === status}
                      label={statusLabel(status)}
                      onPress={() => set('status', status)}
                    />
                  ))}
                </View>
                {liveErrors.status ? <Text style={styles.fieldError}>{liveErrors.status}</Text> : null}
                <Text style={styles.sectionHint}>{statusHint(draft.status)}</Text>
              </View>
            </View>

            <View style={styles.actions}>
              <Button
                label={mode === 'create' ? 'Create tenant' : 'Save changes'}
                loading={submitting}
                onPress={submit}
              />
              <Button disabled={submitting} label="Cancel" onPress={onClose} variant="secondary" />
            </View>
          </View>
        </KeyboardAwareForm>
      </View>
    </Modal>
  );
}

function statusLabel(status: TenantStatus) {
  if (status === 'ACTIVE') return 'Active';
  if (status === 'DISABLED') return 'Disabled';
  return 'Maintenance';
}

function statusHint(status: TenantStatus) {
  if (status === 'ACTIVE') return 'Users can sign in and this tenant can be switched to.';
  if (status === 'DISABLED') return 'Sign-in is blocked and nobody can switch into this tenant.';
  return 'Sign-in is blocked with a maintenance message; existing sessions keep working.';
}

function roleLabel(role: ManagedUserDto['role']) {
  if (role === 'COMPANY_USER') return 'User';
  return 'Admin';
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    flex: { backgroundColor: c.pageBackground, flex: 1 },
    header: {
      alignItems: 'center',
      backgroundColor: c.primary,
      flexDirection: 'row',
      gap: spacing.md,
      paddingBottom: spacing.lg,
      paddingHorizontal: spacing.md,
    },
    headerButton: {
      alignItems: 'center',
      alignSelf: 'flex-start',
      borderRadius: radius.pill,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    headerCopy: { flex: 1, gap: 3, minWidth: 0 },
    headerEyebrow: {
      color: c.onPrimary,
      fontSize: 10,
      fontWeight: '900',
      letterSpacing: 1,
      opacity: 0.78,
    },
    headerTitle: { color: c.onPrimary, fontSize: typography.h2, fontWeight: '900' },
    headerSubtitle: {
      color: c.onPrimary,
      fontSize: typography.caption,
      lineHeight: 17,
      opacity: 0.9,
    },
    content: {
      padding: spacing.md,
    },
    page: { alignSelf: 'center', gap: spacing.md, maxWidth: 680, width: '100%' },
    banner: {
      alignItems: 'center',
      backgroundColor: 'rgba(220,38,38,0.10)',
      borderColor: 'rgba(220,38,38,0.30)',
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.md,
    },
    bannerText: { color: c.danger, flex: 1, fontSize: typography.caption, lineHeight: 17 },
    sectionCard: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth * 2,
      gap: spacing.md,
      padding: spacing.md,
    },
    sectionHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
    sectionIcon: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderRadius: radius.sm,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    sectionCopy: { flex: 1, minWidth: 0 },
    sectionTitle: { color: c.textPrimary, fontSize: typography.title, fontWeight: '900' },
    sectionSubtitle: { color: c.textMuted, fontSize: typography.caption, lineHeight: 17, marginTop: 2 },
    fieldStack: { gap: spacing.md },
    sectionHint: { color: c.textSecondary, fontSize: typography.caption, lineHeight: 17 },
    infoNote: {
      alignItems: 'flex-start',
      backgroundColor: c.accentSoft,
      borderRadius: radius.md,
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.sm + 2,
    },
    infoNoteText: { color: c.textSecondary, flex: 1, fontSize: typography.caption, lineHeight: 17 },
    readOnlyLabel: {
      color: c.textSecondary,
      fontSize: typography.label,
      fontWeight: '600',
      marginBottom: spacing.xs,
    },
    readOnlyBox: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'space-between',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    readOnlyValue: { color: c.textMuted, fontSize: typography.body, fontWeight: '700' },
    readOnlyHint: {
      color: c.textMuted,
      fontSize: typography.caption,
      lineHeight: 16,
      marginTop: spacing.xs,
    },
    statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    fieldError: { color: c.danger, fontSize: typography.caption },
    actions: { gap: spacing.sm, paddingTop: spacing.xs },
  });
