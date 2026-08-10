import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/src/components/ui/Card';
import { apiErrorMessage } from '@/src/services/apiError';
import { usePredictEtaMutation, type EtaResponseDto } from '@/src/services/aiApi';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

type Props = {
  vehicleId: number;
  origin: { latitude: number; longitude: number } | null;
  destination: { latitude: number; longitude: number; label?: string } | null;
  currentSpeedKph?: number | null;
};

/**
 * Predicted arrival for a selected vehicle.
 *
 * Uses a mutation because ETA is user-triggered and costs a model call — the
 * previous read-query form was never invoked by any screen, which is why ETA
 * was unreachable in the app. Every state is shown explicitly: no data, loading,
 * full AI, rule-engine fallback, and failure.
 */
export function AiEtaPanel({ vehicleId, origin, destination, currentSpeedKph }: Props) {
  const { colors: c, stateColors } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [predictEta, { isLoading }] = usePredictEtaMutation();
  const [result, setResult] = useState<EtaResponseDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canPredict = Boolean(origin && destination);

  const onPredict = useCallback(async () => {
    if (!origin || !destination || isLoading) return;
    setError(null);
    try {
      const response = await predictEta({
        vehicleId,
        originLat: origin.latitude,
        originLng: origin.longitude,
        destinationLat: destination.latitude,
        destinationLng: destination.longitude,
        ...(currentSpeedKph != null ? { currentSpeedKph } : {}),
      }).unwrap();
      setResult(response);
    } catch (err) {
      setResult(null);
      setError(apiErrorMessage(err, 'Could not calculate an ETA right now.'));
    }
  }, [origin, destination, isLoading, predictEta, vehicleId, currentSpeedKph]);

  const modeColor =
    result?.mode === 'FULL_AI'
      ? stateColors.RUNNING
      : result?.mode === 'DEGRADED'
        ? c.warningOrange
        : c.textMuted;

  return (
    <Card style={styles.card}>
      <View style={styles.header}>
        <MaterialCommunityIcons name="clock-fast" size={18} color={c.primary} />
        <Text style={styles.title}>Predicted arrival</Text>
      </View>

      {!canPredict ? (
        <Text style={styles.muted}>
          Select a destination on the map to estimate arrival time.
        </Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Calculate estimated time of arrival"
          disabled={isLoading}
          onPress={onPredict}
          style={[styles.action, isLoading && styles.actionDisabled]}>
          {isLoading ? (
            <ActivityIndicator color={c.primary} size="small" />
          ) : (
            <Text style={styles.actionText}>
              {result ? 'Recalculate ETA' : 'Calculate ETA'}
            </Text>
          )}
        </Pressable>
      )}

      {error ? (
        <View style={styles.errorRow}>
          <MaterialCommunityIcons name="alert-circle-outline" size={14} color={c.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {result ? (
        <View style={styles.results}>
          <View style={styles.bigRow}>
            <Text style={styles.bigValue}>
              {Math.round(result.estimatedDurationMinutes)}
            </Text>
            <Text style={styles.bigUnit}>min</Text>
            {result.rangeMinutes > 0 && (
              <Text style={styles.range}>±{Math.round(result.rangeMinutes)}</Text>
            )}
          </View>

          <Row styles={styles} label="Arrives" value={formatTime(result.predictedArrivalTime)} />
          <Row
            styles={styles}
            label="Distance"
            value={`${result.estimatedDistanceKm.toFixed(1)} km${
              result.distanceSource === 'ROAD_ROUTE' ? ' (road route)' : ' (straight-line estimate)'
            }`}
          />
          <Row
            styles={styles}
            label="Confidence"
            value={`${Math.round(result.confidence * 100)}%`}
          />
          <Row
            styles={styles}
            label="Traffic"
            value={
              String(result.factors?.trafficInput ?? 'UNAVAILABLE') === 'AVAILABLE'
                ? 'Live traffic included'
                : 'No live traffic feed'
            }
          />

          <View style={[styles.sourceBadge, { borderColor: `${modeColor}55`, backgroundColor: `${modeColor}18` }]}>
            <Text style={[styles.sourceText, { color: modeColor }]}>
              {result.mode === 'FULL_AI' ? 'AI prediction' : 'Rule-engine estimate'}
            </Text>
          </View>

          <Text style={styles.muted}>{result.structuredExplanation}</Text>
          <Text style={styles.timestamp}>Calculated {formatTime(result.calculatedAt)}</Text>
        </View>
      ) : null}
    </Card>
  );
}

function Row({
  styles,
  label,
  value,
}: {
  styles: ReturnType<typeof makeStyles>;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function formatTime(iso: string | null | undefined) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: { gap: spacing.sm },
    header: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
    title: { color: c.textPrimary, fontSize: typography.title, fontWeight: '800' },
    muted: { color: c.textMuted, fontSize: typography.caption, lineHeight: 17 },
    action: {
      alignItems: 'center',
      backgroundColor: `${c.primary}18`,
      borderColor: `${c.primary}55`,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      paddingVertical: spacing.sm,
    },
    actionDisabled: { opacity: 0.6 },
    actionText: { color: c.primary, fontSize: typography.label, fontWeight: '800' },
    results: { gap: spacing.xs },
    bigRow: { alignItems: 'flex-end', flexDirection: 'row', gap: spacing.xs },
    bigValue: {
      color: c.textPrimary,
      fontSize: 36,
      fontVariant: ['tabular-nums'],
      fontWeight: '900',
      lineHeight: 40,
    },
    bigUnit: { color: c.textSecondary, fontSize: typography.body, paddingBottom: 6 },
    range: { color: c.textMuted, fontSize: typography.caption, paddingBottom: 8 },
    row: { flexDirection: 'row', justifyContent: 'space-between' },
    rowLabel: { color: c.textSecondary, fontSize: typography.caption },
    rowValue: { color: c.textPrimary, fontSize: typography.caption, fontWeight: '700' },
    sourceBadge: {
      alignSelf: 'flex-start',
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      marginTop: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
    },
    sourceText: { fontSize: typography.caption, fontWeight: '800' },
    timestamp: { color: c.textMuted, fontSize: 10 },
    errorRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
    errorText: { color: c.danger, flex: 1, fontSize: typography.caption },
  });
