import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/src/components/ui/Button';
import { SearchableDropdown, type DropdownOption } from '@/src/components/ui/SearchableDropdown';
import { TextField } from '@/src/components/ui/TextField';
import { apiErrorMessage } from '@/src/services/apiError';
import {
  useCreateDeviceMutation,
  useIssueIngestTokenMutation,
  useUpdateDeviceMutation,
  type DeviceUpsertRequest,
} from '@/src/services/devicesApi';
import { useGetProjectsQuery, useGetUsersQuery } from '@/src/services/operationsApi';
import { requestTrackingPermission, startTracking } from '@/src/services/phoneTracker';
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
type DeviceSourceType = 'GPS_DEVICE' | 'MOBILE_GPS';

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

export function DeviceCreateForm({ initialDevice, onSuccess }: DeviceCreateFormProps = {}) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [createDevice, { isLoading: isCreating }] = useCreateDeviceMutation();
  const [updateDevice, { isLoading: isUpdating }] = useUpdateDeviceMutation();
  const [issueIngestToken, { isLoading: isIssuingToken }] = useIssueIngestTokenMutation();
  const isLoading = isCreating || isUpdating || isIssuingToken;

  const projects = useGetProjectsQuery();
  const driversQuery = useGetUsersQuery({ role: 'DRIVER', size: 100 });

  const [draft, setDraft] = React.useState<Draft>(() => emptyDraft(initialDevice));
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [sourceType, setSourceType] = React.useState<DeviceSourceType>(
    () => (initialDevice?.sourceType === 'MOBILE_GPS' ? 'MOBILE_GPS' : 'GPS_DEVICE')
  );
  const [sourceMenuOpen, setSourceMenuOpen] = React.useState(false);

  const isEditing = Boolean(initialDevice?.id);

  React.useEffect(() => {
    setDraft(emptyDraft(initialDevice));
    setErrors({});
    setSourceType(initialDevice?.sourceType === 'MOBILE_GPS' ? 'MOBILE_GPS' : 'GPS_DEVICE');
    setSourceMenuOpen(false);
  }, [initialDevice]);

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
  const isMobileGps = sourceType === 'MOBILE_GPS';
  // Mobile GPS needs no blurb: the label and icon already say what it is,
  // and the selector directly above repeated the same sentence.
  const heroSubtitle = isMobileGps
    ? isEditing
      ? 'Update vehicle attributes and assignments for this phone tracker.'
      : ''
    : isEditing
      ? 'Update device attributes, driver assignment, or SIM details.'
      : 'Register a tracker and bind it to a vehicle. Only the name, IMEI and type are required.';
  const requiredComplete =
    draft.name.trim().length >= 2 && (isMobileGps || imeiDigits.length === IMEI_LENGTH);

  const validate = React.useCallback((): FieldErrors => {
    const next: FieldErrors = {};
    if (draft.name.trim().length < 2) next.name = 'Enter the vehicle name or registration number.';
    if (!isMobileGps) {
      const digits = draft.imei.replace(/\D/g, '');
      if (digits.length === 0) next.imei = 'IMEI is required.';
      else if (digits.length !== IMEI_LENGTH) next.imei = `IMEI must be ${IMEI_LENGTH} digits (currently ${digits.length}).`;
    }
    if (draft.driverPhone.trim() && !/^\+?[\d\s-]{7,16}$/.test(draft.driverPhone.trim())) {
      next.driverPhone = 'Enter a valid phone number.';
    }
    if (draft.expiryDate.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(draft.expiryDate.trim())) {
      next.expiryDate = 'Use the format YYYY-MM-DD.';
    }
    return next;
  }, [draft, isMobileGps]);

  const submit = React.useCallback(async () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    if (isMobileGps && !isEditing) {
      const permission = await requestTrackingPermission();
      if (!permission.granted) {
        Alert.alert('Location access required', permission.message);
        return;
      }
    }

    const trimmed = (value: string) => (value.trim() ? value.trim() : undefined);
    const body: DeviceUpsertRequest = {
      category: draft.category,
      distanceUnit: draft.distanceUnit,
      driverId: draft.driverId,
      driverName: trimmed(draft.driverName),
      driverPhone: trimmed(draft.driverPhone),
      expiryDate: trimmed(draft.expiryDate),
      imei: isMobileGps ? undefined : draft.imei.replace(/\D/g, ''),
      model: isMobileGps ? undefined : trimmed(draft.model),
      name: draft.name.trim(),
      projectId: draft.projectId,
      remarks: trimmed(draft.remarks),
      simApn: isMobileGps ? undefined : trimmed(draft.simApn),
      simNumber: isMobileGps ? undefined : trimmed(draft.simNumber),
      simProvider: isMobileGps ? undefined : trimmed(draft.simProvider),
      sourceType,
      speedUnit: draft.speedUnit,
      timezone: draft.timezone,
    };

    try {
      if (initialDevice?.id) {
        await updateDevice({ id: initialDevice.id, body }).unwrap();
      } else {
        const created = await createDevice(body).unwrap();
        if (isMobileGps) {
          try {
            const { ingestToken } = await issueIngestToken(created.id).unwrap();
            const tracking = await startTracking({
              accuracy: 'high',
              ingestToken,
              onStats: () => undefined,
            });
            Alert.alert(
              'Mobile GPS is live',
              tracking.background
                ? `${created.name} is now using this phone's live GPS location, including in the background.`
                : `${created.name} is using this phone's live GPS location. Keep the app open because background access was not granted.`
            );
          } catch (trackingError) {
            Alert.alert(
              'Mobile GPS created',
              `The vehicle was saved, but live tracking could not start: ${apiErrorMessage(trackingError)}`
            );
          }
        }
      }
      setDraft(emptyDraft());
      setErrors({});
      setSourceType('GPS_DEVICE');
      setSourceMenuOpen(false);
      onSuccess?.();
    } catch (err) {
      Alert.alert(isEditing ? 'Device not updated' : 'Device not saved', apiErrorMessage(err));
    }
  }, [
    createDevice,
    draft,
    initialDevice,
    isEditing,
    isMobileGps,
    issueIngestToken,
    onSuccess,
    sourceType,
    updateDevice,
    validate,
  ]);

  return (
    <View style={styles.root}>
      {!isEditing ? (
        <DeviceTypeSelector
          onChange={(value) => {
            setSourceType(value);
            setSourceMenuOpen(false);
            setErrors((current) => ({ ...current, imei: undefined }));
          }}
          onToggle={() => setSourceMenuOpen((open) => !open)}
          open={sourceMenuOpen}
          value={sourceType}
        />
      ) : null}

      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <MaterialCommunityIcons
            color={c.primary}
            name={isMobileGps ? 'cellphone-marker' : 'cellphone-link'}
            size={26}
          />
        </View>
        <View style={styles.heroText}>
          <Text style={styles.heroTitle}>
            {isEditing
              ? isMobileGps
                ? 'Edit Mobile GPS'
                : 'Edit GPS Device'
              : isMobileGps
                ? 'Mobile GPS'
                : 'Create GPS Device'}
          </Text>
          {heroSubtitle ? <Text style={styles.heroSubtitle}>{heroSubtitle}</Text> : null}
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
        {!isMobileGps ? (
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
        ) : null}
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

      {!isMobileGps ? (
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
      ) : null}

          <FormSection icon="account-group-outline" step={isMobileGps ? 2 : 3} title="Assignment">
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

          <FormSection icon="calendar-clock" step={isMobileGps ? 3 : 4} title="Subscription & units">
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

      <View style={styles.submitBar}>
        <Text style={styles.submitHint}>
          {requiredComplete
            ? isMobileGps
              ? 'Ready to use this phone as the GPS source.'
              : 'Ready to register this tracker.'
            : isMobileGps
              ? 'Enter a vehicle name to continue.'
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

const DEVICE_TYPE_OPTIONS: {
  description?: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  value: DeviceSourceType;
}[] = [
  {
    description: 'Register a tracker and bind it to a vehicle.',
    icon: 'router-wireless',
    label: 'Create GPS Device',
    value: 'GPS_DEVICE',
  },
  {
    // Mobile GPS deliberately has no description. It was the same sentence three
    // times over -- selector card, dropdown row and hero subtitle -- so the
    // option now shows just its label and icon.
    icon: 'cellphone-marker',
    label: 'Mobile GPS',
    value: 'MOBILE_GPS',
  },
];

function DeviceTypeSelector({
  onChange,
  onToggle,
  open,
  value,
}: {
  onChange: (value: DeviceSourceType) => void;
  onToggle: () => void;
  open: boolean;
  value: DeviceSourceType;
}) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const selected = DEVICE_TYPE_OPTIONS.find((option) => option.value === value)!;

  return (
    <View style={styles.deviceTypeField}>
      <FieldLabel>Choose device type</FieldLabel>
      <Pressable
        accessibilityLabel={`Choose device type. ${selected.label} selected`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={[styles.deviceTypeSelected, open && styles.deviceTypeSelectedOpen]}>
        <View style={styles.deviceTypeIcon}>
          <MaterialCommunityIcons color={c.primary} name={selected.icon} size={22} />
        </View>
        <View style={styles.deviceTypeCopy}>
          <Text style={styles.deviceTypeTitle}>{selected.label}</Text>
          {selected.description ? (
            <Text style={styles.deviceTypeDescription}>{selected.description}</Text>
          ) : null}
        </View>
        <MaterialCommunityIcons
          color={c.textSecondary}
          name={open ? 'chevron-up' : 'chevron-down'}
          size={20}
        />
      </Pressable>

      {open ? (
        <View style={styles.deviceTypeMenu}>
          {DEVICE_TYPE_OPTIONS.map((option, index) => {
            const active = option.value === value;
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: active }}
                key={option.value}
                onPress={() => onChange(option.value)}
                style={[
                  styles.deviceTypeOption,
                  index > 0 && styles.deviceTypeOptionDivider,
                  active && styles.deviceTypeOptionActive,
                ]}>
                <View style={styles.deviceTypeIcon}>
                  <MaterialCommunityIcons color={c.primary} name={option.icon} size={21} />
                </View>
                <View style={styles.deviceTypeCopy}>
                  <Text style={[styles.deviceTypeTitle, active && { color: c.primary }]}>
                    {option.label}
                  </Text>
                  {option.description ? (
                    <Text style={styles.deviceTypeDescription}>{option.description}</Text>
                  ) : null}
                </View>
                {active ? (
                  <MaterialCommunityIcons color={c.primary} name="check-circle" size={19} />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
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
    deviceTypeField: { gap: spacing.sm },
    deviceTypeSelected: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.primary,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 64,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    deviceTypeSelectedOpen: {
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
    },
    deviceTypeMenu: {
      backgroundColor: c.surface,
      borderBottomLeftRadius: radius.md,
      borderBottomRightRadius: radius.md,
      borderColor: c.border,
      borderTopWidth: 0,
      borderWidth: StyleSheet.hairlineWidth * 2,
      marginTop: -spacing.sm,
      overflow: 'hidden',
    },
    deviceTypeOption: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 58,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    deviceTypeOptionActive: { backgroundColor: c.accentSoft },
    deviceTypeOptionDivider: {
      borderTopColor: c.divider,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    deviceTypeIcon: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderRadius: radius.sm,
      height: 36,
      justifyContent: 'center',
      width: 36,
    },
    deviceTypeCopy: { flex: 1, minWidth: 0 },
    deviceTypeTitle: { color: c.textPrimary, fontSize: typography.label, fontWeight: '800' },
    deviceTypeDescription: {
      color: c.textMuted,
      fontSize: 10.5,
      lineHeight: 14,
      marginTop: 2,
    },
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
