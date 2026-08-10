import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography } from '@/src/theme/tokens';

/** Coloured status badge shared by list rows, cards and the live-track header. */
export function StatusPill({ state }: { state: string }) {
  const { stateColors } = useTheme();
  const styles = useMemo(() => makeStyles(), []);
  const color = stateColors[state] ?? stateColors.NO_DATA;
  return (
    <View style={[styles.pill, { backgroundColor: `${color}22`, borderColor: `${color}55` }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.text, { color }]}>{formatState(state)}</Text>
    </View>
  );
}

function formatState(state: string) {
  const normalized = (state ?? '').toUpperCase();
  if (normalized === 'RUNNING' || normalized === 'MOVING') return 'Running';
  if (normalized === 'IDLE') return 'Idle';
  if (normalized === 'STOPPED') return 'Stopped';
  if (normalized === 'OFFLINE' || normalized === 'NO_DATA') return 'Offline';
  return state.replace(/_/g, ' ');
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
