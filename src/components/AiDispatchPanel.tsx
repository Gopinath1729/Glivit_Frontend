import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Card } from '@/src/components/ui/Card';
import { apiErrorMessage } from '@/src/services/apiError';
import {
  useRecommendDispatchMutation,
  type DispatchRecommendResponseDto,
  type RankedVehicleDto,
} from '@/src/services/aiApi';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors, hexToRgba } from '@/src/theme/tokens';

type Props = {
  origin: { latitude: number; longitude: number } | null;
  destination: { latitude: number; longitude: number } | null;
  /**
   * Performs the actual dispatch. Omitted when the signed-in user lacks the
   * permission, in which case the panel recommends but offers no action.
   */
  onConfirmDispatch?: (vehicle: RankedVehicleDto) => Promise<void>;
};

/**
 * Ranked dispatch recommendations.
 *
 * The AI only ever recommends. Assigning a vehicle requires an explicit user
 * confirmation here AND a separate authorised backend command — the model can
 * never dispatch anything by itself.
 */
export function AiDispatchPanel({ origin, destination, onConfirmDispatch }: Props) {
  const { colors: c, stateColors } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [recommend, { isLoading }] = useRecommendDispatchMutation();

  const [jobDescription, setJobDescription] = useState('');
  const [result, setResult] = useState<DispatchRecommendResponseDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  const canRecommend = Boolean(origin && destination && jobDescription.trim());

  const onRecommend = useCallback(async () => {
    if (!origin || !destination || isLoading) return;
    setError(null);
    try {
      const response = await recommend({
        jobDescription: jobDescription.trim(),
        originLat: origin.latitude,
        originLng: origin.longitude,
        destinationLat: destination.latitude,
        destinationLng: destination.longitude,
      }).unwrap();
      setResult(response);
    } catch (err) {
      setResult(null);
      setError(apiErrorMessage(err, 'Could not produce dispatch recommendations.'));
    }
  }, [origin, destination, isLoading, recommend, jobDescription]);

  const onConfirm = useCallback(
    (vehicle: RankedVehicleDto) => {
      if (!onConfirmDispatch) return;
      // Explicit, unambiguous confirmation before anything is dispatched.
      Alert.alert(
        'Confirm dispatch',
        `Dispatch ${vehicle.name} to this job?\n\nThis is a recommendation only until you confirm.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Dispatch',
            style: 'destructive',
            onPress: async () => {
              setConfirmingId(vehicle.vehicleId);
              try {
                await onConfirmDispatch(vehicle);
              } catch (err) {
                Alert.alert('Not dispatched', apiErrorMessage(err, 'Dispatch failed.'));
              } finally {
                setConfirmingId(null);
              }
            },
          },
        ]
      );
    },
    [onConfirmDispatch]
  );

  const modeColor =
    result?.mode === 'FULL_AI' ? stateColors.RUNNING : c.warningOrange;

  return (
    <Card style={styles.card}>
      <View style={styles.header}>
        <MaterialCommunityIcons name="truck-fast-outline" size={18} color={c.primary} />
        <Text style={styles.title}>Dispatch recommendation</Text>
      </View>

      {!origin || !destination ? (
        <Text style={styles.muted}>
          Pick a pickup and drop-off point on the map to rank available vehicles.
        </Text>
      ) : (
        <>
          <TextInput
            accessibilityLabel="Job description"
            onChangeText={setJobDescription}
            placeholder="What is the job? e.g. 12 pallets to the north depot"
            placeholderTextColor={c.textMuted}
            style={styles.input}
            value={jobDescription}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Rank vehicles for this job"
            disabled={!canRecommend || isLoading}
            onPress={onRecommend}
            style={[styles.action, (!canRecommend || isLoading) && styles.actionDisabled]}>
            {isLoading ? (
              <ActivityIndicator color={c.primary} size="small" />
            ) : (
              <Text style={styles.actionText}>Rank vehicles</Text>
            )}
          </Pressable>
        </>
      )}

      {error ? (
        <View style={styles.errorRow}>
          <MaterialCommunityIcons name="alert-circle-outline" size={14} color={c.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {result ? (
        <View style={styles.results}>
          <View style={[styles.modeBadge, { borderColor: hexToRgba(modeColor, 0.33), backgroundColor: hexToRgba(modeColor, 0.09) }]}>
            <Text style={[styles.modeText, { color: modeColor }]}>
              {result.mode === 'FULL_AI' ? 'AI ranking' : 'Distance-only ranking (AI unavailable)'}
            </Text>
          </View>
          <Text style={styles.muted}>{result.topRecommendationReason}</Text>

          {result.rankedVehicles.length === 0 ? (
            <Text style={styles.muted}>
              No vehicle with a live position is available for this job.
            </Text>
          ) : (
            result.rankedVehicles.map((vehicle) => (
              <View
                key={vehicle.vehicleId}
                style={[styles.vehicleRow, !vehicle.eligible && styles.vehicleRowIneligible]}>
                <View style={styles.vehicleMain}>
                  <Text style={styles.vehicleName}>
                    #{vehicle.rank} {vehicle.name}
                  </Text>
                  <Text style={styles.vehicleMeta}>
                    {vehicle.distanceToOriginKm.toFixed(1)} km · ~
                    {Math.round(vehicle.etaToOriginMinutes)} min ·{' '}
                    {vehicle.matchScore.toFixed(0)}% match
                    {vehicle.distanceSource === 'STRAIGHT_LINE' ? ' (est.)' : ''}
                  </Text>
                  {vehicle.reasons.slice(0, 3).map((reason) => (
                    <Text key={reason} style={styles.reason}>
                      • {reason}
                    </Text>
                  ))}
                </View>
                {vehicle.eligible && onConfirmDispatch ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Confirm dispatch of ${vehicle.name}`}
                    disabled={confirmingId != null}
                    onPress={() => onConfirm(vehicle)}
                    style={styles.confirmBtn}>
                    {confirmingId === vehicle.vehicleId ? (
                      <ActivityIndicator color={c.primary} size="small" />
                    ) : (
                      <Text style={styles.confirmText}>Dispatch</Text>
                    )}
                  </Pressable>
                ) : (
                  <View style={styles.ineligiblePill}>
                    <Text style={styles.ineligibleText}>
                      {vehicle.eligible ? 'No permission' : 'Not eligible'}
                    </Text>
                  </View>
                )}
              </View>
            ))
          )}

          <Text style={styles.disclaimer}>
            The assistant recommends only. Nothing is dispatched until you confirm.
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: { gap: spacing.sm },
    header: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
    title: { color: c.textPrimary, fontSize: typography.title, fontWeight: '800' },
    muted: { color: c.textMuted, fontSize: typography.caption, lineHeight: 17 },
    input: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      color: c.textPrimary,
      fontSize: typography.label,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    action: {
      alignItems: 'center',
      backgroundColor: hexToRgba(c.primary, 0.09),
      borderColor: hexToRgba(c.primary, 0.33),
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      paddingVertical: spacing.sm,
    },
    actionDisabled: { opacity: 0.5 },
    actionText: { color: c.primary, fontSize: typography.label, fontWeight: '800' },
    results: { gap: spacing.sm },
    modeBadge: {
      alignSelf: 'flex-start',
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
    },
    modeText: { fontSize: typography.caption, fontWeight: '800' },
    vehicleRow: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.sm,
    },
    vehicleRowIneligible: { opacity: 0.55 },
    vehicleMain: { flex: 1, gap: 2 },
    vehicleName: { color: c.textPrimary, fontSize: typography.label, fontWeight: '800' },
    vehicleMeta: { color: c.textSecondary, fontSize: typography.caption },
    reason: { color: c.textMuted, fontSize: 11 },
    confirmBtn: {
      alignItems: 'center',
      backgroundColor: hexToRgba(c.primary, 0.09),
      borderColor: hexToRgba(c.primary, 0.33),
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth * 2,
      minWidth: 84,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    confirmText: { color: c.primary, fontSize: typography.caption, fontWeight: '800' },
    ineligiblePill: {
      backgroundColor: hexToRgba(c.textMuted, 0.09),
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
    },
    ineligibleText: { color: c.textMuted, fontSize: 10, fontWeight: '700' },
    disclaimer: { color: c.textMuted, fontSize: 10, fontStyle: 'italic' },
    errorRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
    errorText: { color: c.danger, flex: 1, fontSize: typography.caption },
  });
