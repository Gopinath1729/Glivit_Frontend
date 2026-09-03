import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/src/components/ui/Button';
import { TextField } from '@/src/components/ui/TextField';
import { apiErrorMessage } from '@/src/services/apiError';
import {
  useCreateDeviceMutation,
  useUpdateDeviceMutation,
  type DeviceUpsertRequest,
} from '@/src/services/devicesApi';
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
  driverName: string;
  driverPhone: string;
  driverAddress: string;
  expiryDate: string;
  timezone: string;
  distanceUnit: 'KM' | 'MI';
  speedUnit: 'KMH' | 'MPH';
  remarks: string;
};

type FieldErrors = Partial<Record<'name' | 'imei' | 'expiryDate' | 'driverPhone', string>>;
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

function oneYearFromNow(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function emptyDraft(initialDevice?: any): Draft {
  if (initialDevice) {
    return {
      category: initialDevice.category || 'CAR',
      distanceUnit: (initialDevice.distanceUnit as 'KM' | 'MI') || 'KM',
      expiryDate: initialDevice.expiryDate ? String(initialDevice.expiryDate).slice(0, 10) : oneYearFromNow(),
      imei: initialDevice.imei || '',
      model: initialDevice.model || '',
      name: initialDevice.name || '',
      driverName: initialDevice.driverName ?? '',
      driverPhone: initialDevice.driverPhone ?? '',
      driverAddress: initialDevice.driverAddress ?? '',
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
    expiryDate: oneYearFromNow(),
    imei: '',
    model: '',
    name: '',
    driverName: '',
    driverPhone: '',
    driverAddress: '',
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
  const isLoading = isCreating || isUpdating;


  const [draft, setDraft] = React.useState<Draft>(() => emptyDraft(initialDevice));
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const [sourceType, setSourceType] = React.useState<DeviceSourceType>(
    initialDevice?.sourceType === 'MOBILE_GPS' ? 'MOBILE_GPS' : 'GPS_DEVICE'
  );

  const isEditing = Boolean(initialDevice?.id);

  React.useEffect(() => {
    setDraft(emptyDraft(initialDevice));
    setSourceType(initialDevice?.sourceType === 'MOBILE_GPS' ? 'MOBILE_GPS' : 'GPS_DEVICE');
    setErrors({});
  }, [initialDevice]);


  const set = React.useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => (key in current ? { ...current, [key]: undefined } : current));
  }, []);

  const imeiDigits = draft.imei.replace(/\D/g, '');
  const isMobileGps = sourceType === 'MOBILE_GPS';

  const heroSubtitle = isMobileGps
    ? isEditing
      ? 'Update vehicle details and assignments for this Mobile GPS tracker.'
      : 'Register a vehicle tracked via smartphone / driver mobile GPS (no hardware tracker required).'
    : isEditing
      ? 'Update device attributes, driver details, or SIM details.'
      : 'Register a hardware tracker and bind it to a vehicle with its 15-digit IMEI.';

  const requiredComplete =
    draft.name.trim().length >= 2 && (isMobileGps || imeiDigits.length === IMEI_LENGTH);

  const validate = React.useCallback((): FieldErrors => {
    const next: FieldErrors = {};
    if (draft.name.trim().length < 2) next.name = 'Enter the vehicle name or registration number.';
    if (!isMobileGps) {
      const digits = draft.imei.replace(/\D/g, '');
      if (digits.length === 0) next.imei = 'IMEI is required for hardware GPS tracker.';
      else if (digits.length !== IMEI_LENGTH) {
        next.imei = `IMEI must be ${IMEI_LENGTH} digits (currently ${digits.length}).`;
      }
    }
    if (draft.expiryDate.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(draft.expiryDate.trim())) {
      next.expiryDate = 'Use the format YYYY-MM-DD.';
    }
    // Optional, but a number that is present has to be dialable.
    if (draft.driverPhone.trim() && !/^\+?[\d\s()-]{7,20}$/.test(draft.driverPhone.trim())) {
      next.driverPhone = 'Enter a valid contact number.';
    }
    return next;
  }, [draft, isMobileGps]);

  const submit = React.useCallback(async () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const trimmed = (value: string) => (value.trim() ? value.trim() : undefined);
    const body: DeviceUpsertRequest = {
      category: draft.category,
      distanceUnit: draft.distanceUnit,
      expiryDate: trimmed(draft.expiryDate),
      imei: isMobileGps ? undefined : draft.imei.replace(/\D/g, ''),
      model: isMobileGps ? undefined : trimmed(draft.model),
      name: draft.name.trim(),
      driverName: trimmed(draft.driverName),
      driverPhone: trimmed(draft.driverPhone),
      driverAddress: trimmed(draft.driverAddress),
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
        await createDevice(body).unwrap();
        if (isMobileGps) {
          // The authenticated app shell observes the invalidated Device tag,
          // confirms this user owns the new Mobile GPS tracker, and only then
          // performs the platform location/permission flow.
          Alert.alert('Mobile GPS registered', 'Location setup will continue for this device.');
        }
      }
      setDraft(emptyDraft());
      setErrors({});
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
    onSuccess,
    sourceType,
    updateDevice,
    validate,
  ]);

  return (
    <View style={styles.root}>
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <MaterialCommunityIcons
            color={c.primary}
            name={isMobileGps ? 'cellphone-marker' : 'access-point'}
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
                ? 'Register Mobile GPS'
                : 'Register GPS Device'}
          </Text>
          {heroSubtitle ? <Text style={styles.heroSubtitle}>{heroSubtitle}</Text> : null}
        </View>
      </View>

      {/* Tracking Mode / Source Type Selector */}
      <View style={styles.sourceTypeSection}>
        <Text style={styles.sourceTypeHeading}>TRACKING METHOD</Text>
        <View style={styles.sourceTypeGrid}>
          <Pressable
            accessibilityLabel="GPS Hardware Tracker"
            accessibilityRole="button"
            accessibilityState={{ selected: sourceType === 'GPS_DEVICE' }}
            onPress={() => setSourceType('GPS_DEVICE')}
            style={({ pressed }) => [
              styles.sourceTypeCard,
              sourceType === 'GPS_DEVICE' && styles.sourceTypeCardActive,
              pressed && { opacity: 0.9 },
            ]}>
            <View
              style={[
                styles.sourceTypeIconWrap,
                sourceType === 'GPS_DEVICE' && styles.sourceTypeIconWrapActive,
              ]}>
              <MaterialCommunityIcons
                color={sourceType === 'GPS_DEVICE' ? c.onPrimary : c.primary}
                name="access-point"
                size={22}
              />
            </View>
            <View style={styles.sourceTypeTextWrap}>
              <Text
                style={[
                  styles.sourceTypeTitle,
                  sourceType === 'GPS_DEVICE' && styles.sourceTypeTitleActive,
                ]}>
                GPS Tracker
              </Text>
              <Text style={styles.sourceTypeDesc}>
                Physical OBD / hardwired tracker with SIM & IMEI
              </Text>
            </View>
            {sourceType === 'GPS_DEVICE' ? (
              <MaterialCommunityIcons color={c.primary} name="check-circle" size={22} />
            ) : (
              <MaterialCommunityIcons color={c.border} name="checkbox-blank-circle-outline" size={22} />
            )}
          </Pressable>

          <Pressable
            accessibilityLabel="Mobile GPS"
            accessibilityRole="button"
            accessibilityState={{ selected: sourceType === 'MOBILE_GPS' }}
            onPress={() => setSourceType('MOBILE_GPS')}
            style={({ pressed }) => [
              styles.sourceTypeCard,
              sourceType === 'MOBILE_GPS' && styles.sourceTypeCardActive,
              pressed && { opacity: 0.9 },
            ]}>
            <View
              style={[
                styles.sourceTypeIconWrap,
                sourceType === 'MOBILE_GPS' && styles.sourceTypeIconWrapActive,
              ]}>
              <MaterialCommunityIcons
                color={sourceType === 'MOBILE_GPS' ? c.onPrimary : c.primary}
                name="cellphone-marker"
                size={22}
              />
            </View>
            <View style={styles.sourceTypeTextWrap}>
              <Text
                style={[
                  styles.sourceTypeTitle,
                  sourceType === 'MOBILE_GPS' && styles.sourceTypeTitleActive,
                ]}>
                Mobile GPS
              </Text>
              <Text style={styles.sourceTypeDesc}>
                Driver / Smartphone app tracking (no device required)
              </Text>
            </View>
            {sourceType === 'MOBILE_GPS' ? (
              <MaterialCommunityIcons color={c.primary} name="check-circle" size={22} />
            ) : (
              <MaterialCommunityIcons color={c.border} name="checkbox-blank-circle-outline" size={22} />
            )}
          </Pressable>
        </View>
      </View>

      <FormSection icon="identifier" step={1} title="Device identity">
        <TextField
          autoCapitalize="characters"
          error={errors.name}
          label="Vehicle name / registration number *"
          onChangeText={(value) => set('name', value)}
          placeholder="e.g. TN20CM7677 or Delivery Van 1"
          value={draft.name}
        />
        {!isMobileGps ? (
          <View style={styles.imeiRow}>
            <View style={styles.imeiInput}>
              <TextField
                error={errors.imei}
                keyboardType="number-pad"
                label={`IMEI (${imeiDigits.length}/${IMEI_LENGTH}) *`}
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

      {/* Driver contact, not a driver account. Free text on the device so
          there is somebody to call about this vehicle; nothing here creates a
          login or a record to keep in step. All three are optional. */}
      <FormSection icon="account-outline" step={isMobileGps ? 2 : 3} title="Driver details">
        <TextField
          autoCapitalize="words"
          label="Driver name"
          onChangeText={(value) => set('driverName', value)}
          placeholder="Full name"
          value={draft.driverName}
        />
        <TextField
          error={errors.driverPhone}
          keyboardType="phone-pad"
          label="Contact number"
          onChangeText={(value) => set('driverPhone', value)}
          placeholder="+91 98765 43210"
          value={draft.driverPhone}
        />
        <TextField
          label="Address"
          multiline
          onChangeText={(value) => set('driverAddress', value)}
          placeholder="Street, city"
          value={draft.driverAddress}
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
          placeholder={isMobileGps ? 'Driver phone assigned' : 'Installed under the dashboard'}
          value={draft.remarks}
        />
      </FormSection>

      <View style={styles.submitBar}>
        <Text style={styles.submitHint}>
          {requiredComplete
            ? isMobileGps
              ? 'Ready to register this Mobile GPS tracker.'
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
  options,
  value,
  onSelect,
}: {
  options: { label: string; value: T }[];
  value: T;
  onSelect: (value: T) => void;
}) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.segmented}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            accessibilityLabel={option.label}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            key={option.value}
            onPress={() => onSelect(option.value)}
            style={[styles.segment, active && styles.segmentActive]}>
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { gap: spacing.md, padding: spacing.md, paddingBottom: 64 },
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
      borderColor: c.primary,
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

    // --- Tracking Method Selection -------------------------------------
    sourceTypeSection: { gap: spacing.xs },
    sourceTypeHeading: {
      color: c.textMuted,
      fontSize: typography.caption,
      fontWeight: '800',
      letterSpacing: 0.8,
    },
    sourceTypeGrid: { gap: spacing.sm },
    sourceTypeCard: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.md,
    },
    sourceTypeCardActive: {
      backgroundColor: c.accentSoft,
      borderColor: c.primary,
    },
    sourceTypeIconWrap: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    sourceTypeIconWrapActive: {
      backgroundColor: c.primary,
    },
    sourceTypeTextWrap: { flex: 1, minWidth: 0 },
    sourceTypeTitle: {
      color: c.textPrimary,
      fontSize: typography.body,
      fontWeight: '800',
    },
    sourceTypeTitleActive: {
      color: c.primary,
      fontWeight: '900',
    },
    sourceTypeDesc: {
      color: c.textMuted,
      fontSize: typography.caption,
      marginTop: 2,
    },

    // --- Sections ------------------------------------------------------
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
      borderColor: c.primary,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      height: 52,
      justifyContent: 'center',
      marginTop: 24,
      width: 52,
    },
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
