import React, { useMemo } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Chip } from '@/src/components/ui/ModulePrimitives';
import { ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { apiErrorMessage } from '@/src/services/apiError';
import { useGetSettingsQuery, useUpdateSettingsMutation } from '@/src/services/operationsApi';
import type { SettingsDto } from '@/src/types/api';
import { useTheme, type ThemeMode } from '@/src/theme/ThemeProvider';
import { spacing, typography, type ThemeColors } from '@/src/theme/tokens';

const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function SettingsScreen() {
  const { colors: c, mode, setMode } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const { data, isLoading, isError, error, refetch } = useGetSettingsQuery();
  const [draft, setDraft] = React.useState<SettingsDto | null>(null);
  const [updateSettings, { isLoading: isSaving }] = useUpdateSettingsMutation();

  React.useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  if (isLoading) return <LoadingView label="Loading settings..." />;
  if (isError || !data) return <ErrorRetryView message={apiErrorMessage(error)} onRetry={refetch} />;
  if (!draft) return <LoadingView label="Loading settings..." />;

  const save = async () => {
    try {
      await updateSettings(draft).unwrap();
      Alert.alert('Settings saved', 'Preferences updated for this account.');
    } catch (err) {
      Alert.alert('Settings not saved', apiErrorMessage(err));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Card style={styles.card}>
        <Text style={styles.title}>Appearance</Text>
        <View style={styles.segment}>
          <Text style={styles.label}>Theme</Text>
          <View style={styles.chips}>
            {THEME_MODES.map((m) => (
              <Chip key={m.value} active={m.value === mode} label={m.label} onPress={() => setMode(m.value)} />
            ))}
          </View>
          <Text style={styles.hint}>
            {mode === 'system' ? 'Following your device appearance.' : `Always ${mode}.`}
          </Text>
        </View>
      </Card>

      <Card style={styles.card}>
        <Text style={styles.title}>Units</Text>
        <Segment
          label="Distance"
          options={['KM', 'MI']}
          value={draft.distanceUnit}
          onChange={(distanceUnit) => setDraft((v) => v && { ...v, distanceUnit })}
        />
        <Segment
          label="Speed"
          options={['KMH', 'MPH']}
          value={draft.speedUnit}
          onChange={(speedUnit) => setDraft((v) => v && { ...v, speedUnit })}
        />
      </Card>

      <Card style={styles.card}>
        <Text style={styles.title}>Map & Tracking</Text>
        <Segment
          label="Map style"
          options={['street', 'bright', 'dark']}
          value={draft.mapStyle}
          onChange={(mapStyle) => setDraft((v) => v && { ...v, mapStyle })}
        />
        <SwitchRow
          label="Traffic preference"
          value={draft.trafficEnabled}
          onValueChange={(trafficEnabled) => setDraft((v) => v && { ...v, trafficEnabled })}
        />
        <SwitchRow
          label="Auto-follow vehicle"
          value={draft.autoFollowVehicle}
          onValueChange={(autoFollowVehicle) => setDraft((v) => v && { ...v, autoFollowVehicle })}
        />
        <Segment
          label="Refresh"
          options={['15', '30', '60', '120']}
          value={String(draft.refreshFrequencySeconds)}
          onChange={(refreshFrequencySeconds) =>
            setDraft((v) => v && { ...v, refreshFrequencySeconds: Number(refreshFrequencySeconds) })
          }
        />
      </Card>

      <Card style={styles.card}>
        <Text style={styles.title}>Regional</Text>
        <Segment
          label="Time"
          options={['24H', '12H']}
          value={draft.timeFormat}
          onChange={(timeFormat) => setDraft((v) => v && { ...v, timeFormat })}
        />
        <Segment
          label="History"
          options={['today', 'yesterday', 'week']}
          value={draft.defaultHistoryRange}
          onChange={(defaultHistoryRange) => setDraft((v) => v && { ...v, defaultHistoryRange })}
        />
        <SwitchRow
          label="Notification sound"
          value={draft.notificationSound}
          onValueChange={(notificationSound) => setDraft((v) => v && { ...v, notificationSound })}
        />
      </Card>

      <Button label="Save settings" icon="content-save-outline" loading={isSaving} onPress={save} />
    </ScrollView>
  );
}

function Segment({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.segment}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chips}>
        {options.map((option) => (
          <Chip key={option} active={option === value} label={option.toUpperCase()} onPress={() => onChange(option)} />
        ))}
      </View>
    </View>
  );
}

function SwitchRow({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.switchRow}>
      <Text style={styles.switchLabel}>{label}</Text>
      <Switch
        onValueChange={onValueChange}
        thumbColor="#FFFFFF"
        trackColor={{ false: c.borderStrong, true: c.primary }}
        value={value}
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    // The ScrollView itself must carry the page background: the content
    // container is only as tall as its children, so anything below the last card
    // otherwise falls through to the default white backdrop in dark mode.
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    content: {
      backgroundColor: c.pageBackground,
      flexGrow: 1,
      gap: spacing.md,
      padding: spacing.md,
    },
    card: { gap: spacing.md },
    title: { color: c.textPrimary, fontSize: typography.title, fontWeight: '900' },
    segment: { gap: spacing.sm },
    label: { color: c.textSecondary, fontSize: typography.caption, fontWeight: '800', textTransform: 'uppercase' },
    hint: { color: c.textMuted, fontSize: typography.caption },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    switchRow: {
      alignItems: 'center',
      borderColor: c.border,
      borderTopWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingTop: spacing.md,
    },
    switchLabel: { color: c.textPrimary, fontSize: typography.body, fontWeight: '700' },
  });
