import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/src/components/ui/Button';
import { Chip } from '@/src/components/ui/ModulePrimitives';
import { TextField } from '@/src/components/ui/TextField';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import type { UserRequest } from '@/src/services/operationsApi';
import type { ManagedUserDto, MemberStatus, Role } from '@/src/types/api';

const ROLES: Role[] = ['ADMIN', 'TENANT_ADMIN', 'COMPANY_USER'];
const STATUSES: MemberStatus[] = ['ACTIVE', 'PENDING_ACTIVATION', 'DISABLED', 'LOCKED'];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{7,19}$/;

type Draft = {
  name: string;
  email: string;
  mobile: string;
  address: string;
  role: Role;
  status: MemberStatus;
};

type FieldErrors = Partial<Record<keyof Draft, string>>;

const EMPTY: Draft = {
  name: '',
  email: '',
  mobile: '',
  address: '',
  role: 'COMPANY_USER',
  status: 'ACTIVE',
};

function draftFrom(user: ManagedUserDto | null): Draft {
  if (!user) return EMPTY;
  return {
    name: user.name ?? '',
    email: user.email ?? (user.username?.includes('@') ? user.username : ''),
    mobile: user.mobile ?? '',
    address: user.address ?? '',
    role: (ROLES.includes(user.role) ? user.role : 'COMPANY_USER') as Role,
    status: (STATUSES.includes(user.status as MemberStatus)
      ? user.status
      : 'ACTIVE') as MemberStatus,
  };
}

export function validateUserDraft(draft: Draft): FieldErrors {
  const errors: FieldErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'Full name is required';
  else if (name.length > 160) errors.name = 'Name must be 160 characters or fewer';

  const email = draft.email.trim();
  if (!email) errors.email = 'Email address is required';
  else if (!EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email address';
  else if (email.length > 160) errors.email = 'Email must be 160 characters or fewer';

  const mobile = draft.mobile.trim();
  if (!mobile) errors.mobile = 'Mobile number is required';
  else if (!PHONE_PATTERN.test(mobile)) errors.mobile = 'Enter a valid phone number';

  return errors;
}

export function UserFormModal({
  visible,
  user,
  submitting,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  user: ManagedUserDto | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (body: UserRequest) => void;
}) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => makeStyles(c), [c]);

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (visible) {
      setDraft(draftFrom(user));
      setErrors({});
    }
  }, [user, visible]);

  const isEdit = user != null;

  const setField = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) {
      setErrors((prev) => ({ ...prev, [key]: undefined }));
    }
  };

  const handleSave = () => {
    const errs = validateUserDraft(draft);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    onSubmit({
      name: draft.name.trim(),
      email: draft.email.trim(),
      mobile: draft.mobile.trim(),
      address: draft.address.trim() || undefined,
      role: draft.role,
      status: draft.status,
    });
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} visible={visible}>
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>{isEdit ? 'Edit User' : 'Add New User'}</Text>
            <Text style={styles.subtitle}>
              {isEdit ? 'Update member details and permissions' : 'Create a new user in this organization'}
            </Text>
          </View>
          <Pressable accessibilityLabel="Close" hitSlop={8} onPress={onClose} style={styles.closeBtn}>
            <MaterialCommunityIcons color={c.textPrimary} name="close" size={24} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
          <TextField
            autoCapitalize="words"
            error={errors.name}
            label="Full name *"
            onChangeText={(text) => setField('name', text)}
            placeholder="e.g. John Doe"
            value={draft.name}
          />

          <TextField
            autoCapitalize="none"
            error={errors.email}
            keyboardType="email-address"
            label="Email address *"
            onChangeText={(text) => setField('email', text)}
            placeholder="e.g. john.doe@company.com"
            value={draft.email}
          />

          <TextField
            error={errors.mobile}
            keyboardType="phone-pad"
            label="Mobile number *"
            onChangeText={(text) => setField('mobile', text)}
            placeholder="e.g. +91 98765 43210"
            value={draft.mobile}
          />

          <TextField
            label="Address / Region"
            onChangeText={(text) => setField('address', text)}
            placeholder="e.g. Chennai, Tamil Nadu"
            value={draft.address}
          />

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>User Role</Text>
            <View style={styles.chipsRow}>
              {ROLES.map((r) => (
                <Chip
                  active={draft.role === r}
                  key={r}
                  label={formatRole(r)}
                  onPress={() => setField('role', r)}
                />
              ))}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Account Status</Text>
            <View style={styles.chipsRow}>
              {STATUSES.map((st) => (
                <Chip
                  active={draft.status === st}
                  key={st}
                  label={formatStatus(st)}
                  onPress={() => setField('status', st)}
                />
              ))}
            </View>
          </View>

          <View style={styles.actionRow}>
            <Button
              disabled={submitting}
              label="Cancel"
              onPress={onClose}
              variant="secondary"
            />
            <Button
              disabled={submitting}
              icon={isEdit ? 'check' : 'account-plus'}
              label={submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Create User'}
              onPress={handleSave}
            />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function formatRole(role: string): string {
  return role.charAt(0) + role.slice(1).toLowerCase().replace(/_/g, ' ');
}

function formatStatus(status: string): string {
  if (status === 'PENDING_ACTIVATION') return 'Pending';
  return status.charAt(0) + status.slice(1).toLowerCase();
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    header: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderBottomColor: c.border,
      borderBottomWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    title: { color: c.textPrimary, fontSize: typography.h2, fontWeight: '800' },
    subtitle: { color: c.textMuted, fontSize: typography.caption, marginTop: 2 },
    closeBtn: {
      alignItems: 'center',
      borderRadius: radius.sm,
      height: 38,
      justifyContent: 'center',
      width: 38,
    },
    formContent: { gap: spacing.md, padding: spacing.md, paddingBottom: 64 },
    section: { gap: spacing.xs + 2 },
    sectionTitle: { color: c.textPrimary, fontSize: typography.body, fontWeight: '700' },
    chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs + 2 },
    actionRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'flex-end',
      marginTop: spacing.md,
    },
  });
