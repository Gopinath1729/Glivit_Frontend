import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/src/components/ui/Button';
import { SearchableDropdown, type DropdownOption } from '@/src/components/ui/SearchableDropdown';
import { TextField } from '@/src/components/ui/TextField';
import { apiErrorMessage } from '@/src/services/apiError';
import { useCreateDeviceMutation, useUpdateDeviceMutation, type DeviceUpsertRequest } from '@/src/services/devicesApi';
import { useGetGroupsQuery, useGetProjectsQuery, useGetUsersQuery } from '@/src/services/operationsApi';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

type Draft = {
  name: string;
  imei: string;
  category: string;
  model: string;
  simNumber: string;
  simProvider: string;
  simApn: string;
  driverId?: number;
  driverName: string;
  driverPhone: string;
  projectId?: number;
  expiryDate: string;
  timezone: string;
  distanceUnit: 'KM' | 'MI';
  speedUnit: 'KMH' | 'MPH';
  remarks: string;
};

type FieldErrors = Partial<Record<'name' | 'imei' | 'driverPhone' | 'expiryDate', string>>;

const CATEGORIES: {
  id: string;
  label: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
}[] = [
    { id: 'CAR', label: 'Car', icon: 'car' },
    { id: 'TRUCK', label: 'Truck', icon: 'truck' },
    { id: 'BUS', label: 'Bus', icon: 'bus' },
    { id: 'BIKE', label: 'Bike', icon: 'motorbike' },
    { id: 'TRAILER', label: 'Trailer', icon: 'truck-trailer' },
    { id: 'ASSET', label: 'Asset', icon: 'package-variant-closed' },
  ];

const IMEI_LENGTH = 15;

function emptyDraft(initialDevice?: any): Draft {
  if (initialDevice) {
    return {
      category: initialDevice.category || 'CAR',
      distanceUnit: (initialDevice.distanceUnit as 'KM' | 'MI') || 'KM',
      driverId: initialDevice.driverId ?? undefined,
      driverName: initialDevice.driverName || '',
      driverPhone: initialDevice.driverPhone || '',
      expiryDate: initialDevice.expiryDate ? String(initialDevice.expiryDate).slice(0, 10) : oneYearFromNow(),
      imei: initialDevice.imei || '',
      model: initialDevice.model || '',
      name: initialDevice.name || '',
      projectId: initialDevice.projectId ?? undefined,
      remarks: initialDevice.remarks || '',
      simApn: initialDevice.simApn || '',
      simNumber: initialDevice.simNumber || '',
      simProvider: initialDevice.simProvider || '',
      speedUnit: (initialDevice.speedUnit as 'KMH' | 'MPH') || 'KMH',
      timezone: initialDevice.timezone || 'Asia/Kolkata',
    };
  }
  return {
    category: 'CAR',
    distanceUnit: 'KM',
    driverId: undefined,
    driverName: '',
    driverPhone: '',
    expiryDate: oneYearFromNow(),
    imei: '',
    model: '',
    name: '',
    projectId: undefined,
    remarks: '',
    simApn: '',
    simNumber: '',
    simProvider: '',
    speedUnit: 'KMH',
    timezone: 'Asia/Kolkata',
  };
}

type DeviceCreateFormProps = {
  initialDevice?: any;
  onSuccess?: () => void;
  onCancel?: () => void;
};

export function DeviceCreateForm({ initialDevice, onSuccess, onCancel }: DeviceCreateFormProps = {}) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [createDevice, { isLoading: isCreating }] = useCreateDeviceMutation();
  const [updateDevice, { isLoading: isUpdating }] = useUpdateDeviceMutation();
  const isLoading = isCreating || isUpdating;

  const projects = useGetProjectsQuery();
  const groups = useGetGroupsQuery();
  const driversQuery = useGetUsersQuery({ role: 'DRIVER', size: 100 });

  const [draft, setDraft] = React.useState<Draft>(() => emptyDraft(initialDevice));
  const [errors, setErrors] = React.useState<FieldErrors>({});

  const isEditing = Boolean(initialDevice?.id);

  const driverOptions: DropdownOption[] = React.useMemo(() => {
    return (driversQuery.data?.content ?? [])
      .filter((user) => user.status === 'ACTIVE')
      .map((user) => ({
        id: user.id,
        label: user.name,
        subLabel: user.username,
        phone: user.mobile ?? undefined,
      }));
  }, [driversQuery.data]);

  const projectOptions: DropdownOption[] = React.useMemo(() => {
    return (projects.data ?? []).map((project) => ({
      id: project.id,
      label: project.name,
    }));
  }, [projects.data]);

  const set = React.useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => (key in current ? { ...current, [key]: undefined } : current));
  }, []);

  const imeiDigits = draft.imei.replace(/\D/g, '');
  const requiredComplete = draft.name.trim().length >= 2 && imeiDigits.length === IMEI_LENGTH;

  const validate = React.useCallback((): FieldErrors => {
    const next: FieldErrors = {};
    if (draft.name.trim().length < 2) next.name = 'Enter the vehicle name or registration number.';
    const digits = draft.imei.replace(/\D/g, '');
    if (digits.length === 0) next.imei = 'IMEI is required.';
    else if (digits.length !== IMEI_LENGTH) next.imei = `IMEI must be ${IMEI_LENGTH} digits (currently ${digits.length}).`;
    if (draft.driverPhone.trim() && !/^\+?[\d\s-]{7,16}$/.test(draft.driverPhone.trim())) {
      next.driverPhone = 'Enter a valid phone number.';
    }
    if (draft.expiryDate.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(draft.expiryDate.trim())) {
      next.expiryDate = 'Use the format YYYY-MM-DD.';
    }
    return next;
  }, [draft]);

  const submit = React.useCallback(async () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const trimmed = (value: string) => (value.trim() ? value.trim() : undefined);
    const body: DeviceUpsertRequest = {
      category: draft.category,
      distanceUnit: draft.distanceUnit,
      driverId: draft.driverId,
      driverName: trimmed(draft.driverName),
      driverPhone: trimmed(draft.driverPhone),
      expiryDate: trimmed(draft.expiryDate),
      imei: draft.imei.replace(/\D/g, ''),
      model: trimmed(draft.model),
      name: draft.name.trim(),
      projectId: draft.projectId,
      remarks: trimmed(draft.remarks),
      simApn: trimmed(draft.simApn),
      simNumber: trimmed(draft.simNumber),
      simProvider: trimmed(draft.simProvider),
      speedUnit: draft.speedUnit,
      timezone: draft.timezone,
    };

    try {
      if (initialDevice?.id) {
        await updateDevice({ id: initialDevice.id, body }).unwrap();
      } else {
        await createDevice(body).unwrap();
      }
      setDraft(emptyDraft());
      setErrors({});
      onSuccess?.();
    } catch (err) {
      Alert.alert(isEditing ? 'Device not updated' : 'Device not saved', apiErrorMessage(err));
    }
  }, [createDevice, updateDevice, draft, validate, initialDevice, isEditing, onSuccess]);

  const showOptional = true;

  return (
    <View style={styles.root}>
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <MaterialCommunityIcons color={c.primary} name="cellphone-link" size={26} />
        </View>
        <View style={styles.heroText}>
          <Text style={styles.heroTitle}>{isEditing ? 'Edit GPS Device' : 'Create GPS Device'}</Text>
          <Text style={styles.heroSubtitle}>
            {isEditing
              ? 'Update device attributes, driver assignment, or SIM details.'
              : 'Register a tracker and bind it to a vehicle. Only the name, IMEI and type are required.'}
          </Text>
        </View>
      </View>

      <FormSection icon="identifier" step={1} title="Device identity">
        <TextField
          autoCapitalize="characters"
          error={errors.name}
          label="Vehicle name / registration number"
          onChangeText={(value) => set('name', value)}
          placeholder="TN20CM7677"
          value={draft.name}
        />
        <View style={styles.imeiRow}>
          <View style={styles.imeiInput}>
            <TextField
              error={errors.imei}
              keyboardType="number-pad"
              label={`IMEI (${imeiDigits.length}/${IMEI_LENGTH})`}
              maxLength={20}
              onChangeText={(value) => set('imei', value)}
              placeholder="864000000000001"
              value={draft.imei}
            />
          </View>
          <Pressable
            accessibilityLabel="Scan IMEI barcode"
            accessibilityRole="button"
            onPress={() =>
              Alert.alert(
                'Scan IMEI',
                'The QR/barcode scanner is available in native builds with camera permission granted.'
              )
            }
            style={[styles.scanButton, errors.imei ? styles.scanButtonRaised : null]}>
            <MaterialCommunityIcons color={c.primary} name="qrcode-scan" size={24} />
          </Pressable>
        </View>
        <FieldLabel>Vehicle type</FieldLabel>
        <View style={styles.categoryGrid}>
          {CATEGORIES.map((category) => {
            const active = draft.category === category.id;
            return (
              <Pressable
                accessibilityLabel={category.label}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                key={category.id}
                onPress={() => set('category', category.id)}
                style={[styles.categoryCard, active && styles.categoryCardActive]}>
                <MaterialCommunityIcons
                  color={active ? c.onPrimary : c.textSecondary}
                  name={category.icon}
                  size={22}
                />
                <Text style={[styles.categoryLabel, active && styles.categoryLabelActive]}>
                  {category.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </FormSection>

      {showOptional ? (
        <>
          <FormSection icon="sim" step={2} title="SIM & connectivity">
            <TextField
              keyboardType="phone-pad"
              label="SIM number"
              onChangeText={(value) => set('simNumber', value)}
              placeholder="+91 90000 00000"
              value={draft.simNumber}
            />
            <View style={styles.pairRow}>
              <View style={styles.pairItem}>
                <TextField
                  label="Provider"
                  onChangeText={(value) => set('simProvider', value)}
                  placeholder="Airtel"
                  value={draft.simProvider}
                />
              </View>
              <View style={styles.pairItem}>
                <TextField
                  autoCapitalize="none"
                  label="APN"
                  onChangeText={(value) => set('simApn', value)}
                  placeholder="airtelgprs.com"
                  value={draft.simApn}
                />
              </View>
            </View>
            <TextField
              label="Tracker model"
              onChangeText={(value) => set('model', value)}
              placeholder="GT06N"
              value={draft.model}
            />
          </FormSection>

          <FormSection icon="account-group-outline" step={3} title="Assignment">
            <SearchableDropdown
              emptyText="No active drivers found"
              label="Driver"
              loading={driversQuery.isLoading}
              onSelect={(option) => {
                if (option) {
                  setDraft((current) => ({
                    ...current,
                    driverId: option.id,
                    driverName: option.label,
                    driverPhone: option.phone || current.driverPhone,
                  }));
                } else {
                  setDraft((current) => ({
                    ...current,
                    driverId: undefined,
                    driverName: '',
                    driverPhone: '',
                  }));
                }
              }}
              options={driverOptions}
              placeholder="Select driver..."
              selectedId={draft.driverId}
            />
            <TextField
              error={errors.driverPhone}
              keyboardType="phone-pad"
              label="Driver phone"
              onChangeText={(value) => set('driverPhone', value)}
              placeholder="+91 98765 43210"
              value={draft.driverPhone}
            />
            <SearchableDropdown
              emptyText="No projects created yet"
              label="Project"
              loading={projects.isLoading}
              onSelect={(option) => {
                setDraft((current) => ({
                  ...current,
                  projectId: option ? option.id : undefined,
                }));
              }}
              options={projectOptions}
              placeholder="Select project..."
              selectedId={draft.projectId}
            />
          </FormSection>

          <FormSection icon="calendar-clock" step={4} title="Subscription & units">
            <TextField
              autoCapitalize="none"
              error={errors.expiryDate}
              label="Expiry date (YYYY-MM-DD)"
              onChangeText={(value) => set('expiryDate', value)}
              placeholder="2027-07-27"
              value={draft.expiryDate}
            />
            <TextField
              autoCapitalize="none"
              label="Timezone"
              onChangeText={(value) => set('timezone', value)}
              placeholder="Asia/Kolkata"
              value={draft.timezone}
            />
            <View style={styles.pairRow}>
              <View style={styles.pairItem}>
                <FieldLabel>Distance</FieldLabel>
                <Segmented
                  onSelect={(value) => set('distanceUnit', value)}
                  options={[
                    { label: 'Kilometres', value: 'KM' as const },
                    { label: 'Miles', value: 'MI' as const },
                  ]}
                  value={draft.distanceUnit}
                />
              </View>
              <View style={styles.pairItem}>
                <FieldLabel>Speed</FieldLabel>
                <Segmented
                  onSelect={(value) => set('speedUnit', value)}
                  options={[
                    { label: 'km/h', value: 'KMH' as const },
                    { label: 'mph', value: 'MPH' as const },
                  ]}
                  value={draft.speedUnit}
                />
              </View>
            </View>
            <TextField
              label="Remarks"
              multiline
              onChangeText={(value) => set('remarks', value)}
              placeholder="Installed under the dashboard"
              value={draft.remarks}
            />
          </FormSection>
        </>
      ) : null}

      <View style={styles.submitBar}>
        <Text style={styles.submitHint}>
          {requiredComplete
            ? 'Ready to register this tracker.'
            : 'Enter a vehicle name and a 15-digit IMEI to continue.'}
        </Text>
        <Button
          disabled={!requiredComplete}
          icon="content-save-outline"
          label={isEditing ? 'Update device' : 'Save device'}
          loading={isLoading}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

function FormSection({
  children,
  icon,
  step,
  title,
}: {
  children: React.ReactNode;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  step: number;
  title: string;
}) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionStep}>
          <Text style={styles.sectionStepText}>{step}</Text>
        </View>
        <MaterialCommunityIcons color={c.primary} name={icon} size={18} />
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return <Text style={styles.fieldLabel}>{children}</Text>;
}

/** Single-select chip row that also allows clearing the current choice. */
function OptionRow({
  emptyText,
  onSelect,
  options,
  selectedId,
}: {
  emptyText: string;
  onSelect: (id: number | undefined) => void;
  options: { id: number; label: string }[];
  selectedId?: number;
}) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  if (options.length === 0) return <Text style={styles.emptyOption}>{emptyText}</Text>;
  return (
    <View style={styles.chipRow}>
      {options.map((option) => {
        const active = selectedId === option.id;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            key={option.id}
            onPress={() => onSelect(active ? undefined : option.id)}
            style={[styles.chip, active && styles.chipActive]}>
            <Text numberOfLines={1} style={[styles.chipText, active && styles.chipTextActive]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Segmented<T extends string>({
  onSelect,
  options,
  value,
}: {
  onSelect: (value: T) => void;
  options: { label: string; value: T }[];
  value: T;
}) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.segmented}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            key={option.value}
            onPress={() => onSelect(option.value)}
            style={[styles.segment, active && styles.segmentActive]}>
            <Text numberOfLines={1} style={[styles.segmentText, active && styles.segmentTextActive]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function oneYearFromNow() {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { gap: spacing.md },
    hero: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.md,
      padding: spacing.md,
    },
    heroIcon: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderColor: c.accent,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      height: 50,
      justifyContent: 'center',
      width: 50,
    },
    heroText: { flex: 1, minWidth: 0 },
    heroTitle: { color: c.textPrimary, fontSize: typography.title, fontWeight: '900' },
    heroSubtitle: {
      color: c.textSecondary,
      fontSize: typography.caption,
      lineHeight: 17,
      marginTop: 3,
    },
    successBanner: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderColor: c.accent,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.md,
    },
    successText: { color: c.textPrimary, flex: 1, fontSize: typography.caption, fontWeight: '700' },

    section: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth * 2,
      overflow: 'hidden',
    },
    sectionHeader: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderBottomColor: c.border,
      borderBottomWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    sectionStep: {
      alignItems: 'center',
      backgroundColor: c.primary,
      borderRadius: 999,
      height: 22,
      justifyContent: 'center',
      width: 22,
    },
    sectionStepText: { color: c.onPrimary, fontSize: 11, fontWeight: '900' },
    sectionTitle: { color: c.textPrimary, fontSize: typography.label, fontWeight: '800' },
    sectionBody: { gap: spacing.md, padding: spacing.md },

    imeiRow: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.sm },
    imeiInput: { flex: 1, minWidth: 0 },
    scanButton: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderColor: c.accent,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      height: 52,
      justifyContent: 'center',
      marginTop: 24,
      width: 52,
    },
    // Keeps the button aligned with the input when an error line appears.
    scanButtonRaised: { marginTop: 24 },

    fieldLabel: {
      color: c.textSecondary,
      fontSize: typography.label,
      fontWeight: '600',
      marginBottom: -spacing.sm,
    },
    categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    categoryCard: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexBasis: '30%',
      flexGrow: 1,
      gap: 5,
      justifyContent: 'center',
      paddingVertical: spacing.md,
    },
    categoryCardActive: { backgroundColor: c.primary, borderColor: c.primary },
    categoryLabel: { color: c.textSecondary, fontSize: typography.caption, fontWeight: '700' },
    categoryLabelActive: { color: c.onPrimary, fontWeight: '900' },

    optionalToggle: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    optionalToggleText: {
      color: c.textPrimary,
      flex: 1,
      fontSize: typography.label,
      fontWeight: '700',
    },

    pairRow: { flexDirection: 'row', gap: spacing.sm },
    pairItem: { flex: 1, gap: spacing.md, minWidth: 0 },

    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: {
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      maxWidth: '100%',
      paddingHorizontal: spacing.md,
      paddingVertical: 8,
    },
    chipActive: { backgroundColor: c.primary, borderColor: c.primary },
    chipText: { color: c.textSecondary, fontSize: typography.caption, fontWeight: '700' },
    chipTextActive: { color: c.onPrimary, fontWeight: '900' },
    emptyOption: { color: c.textMuted, fontSize: typography.caption },

    segmented: {
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      overflow: 'hidden',
      padding: 3,
    },
    segment: {
      alignItems: 'center',
      borderRadius: radius.sm,
      flex: 1,
      paddingVertical: 9,
    },
    segmentActive: { backgroundColor: c.primary },
    segmentText: { color: c.textSecondary, fontSize: typography.caption, fontWeight: '700' },
    segmentTextActive: { color: c.onPrimary, fontWeight: '900' },

    submitBar: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth * 2,
      gap: spacing.sm,
      padding: spacing.md,
    },
    submitHint: { color: c.textSecondary, fontSize: typography.caption, textAlign: 'center' },
  });
