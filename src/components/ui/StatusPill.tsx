import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { formatDeviceState, normalizeDeviceState } from '@/src/services/deviceState';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, hexToRgba } from '@/src/theme/tokens';

/** Coloured status badge shared by list rows, cards and the live-track header. */
export function StatusPill({ state }: { state: string }) {
  const { stateColors } = useTheme();
  const styles = useMemo(() => makeStyles(), []);
  
  const color = useMemo(() => {
    const normalized = normalizeDeviceState(state);
    // Callers pass either a raw DeviceState or one of the friendly labels the
    // live screen shows. normalizeDeviceState underscores the spaces, so these
    // aliases are matched in their underscored form.
    const colorKey =
      normalized === 'ENGINE_CUT' || normalized === 'LOCKED' ? 'IMMOBILISED' :
      normalized === 'GPS_ERROR' ? 'GPS_INVALID' :
      normalized === 'LOW_ACCURACY' ? 'LOW_ACCURACY' :
      normalized === 'POWER_CUT' ? 'POWER_DISCONNECTED' :
      normalized;
    return stateColors[colorKey] ?? stateColors[normalized] ?? stateColors.NO_DATA;
  }, [state, stateColors]);

  return (
    <View style={[styles.pill, { backgroundColor: hexToRgba(color, 0.13), borderColor: hexToRgba(color, 0.33) }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.text, { color }]}>{formatDeviceState(state)}</Text>
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    pill: {
      alignItems: 'center',
      alignSelf: 'flex-start',
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
    },
    dot: {
      borderRadius: 999,
      height: 7,
      width: 7,
    },
    text: {
      fontSize: typography.caption,
      fontWeight: '800',
      textTransform: 'uppercase',
    },
  });
