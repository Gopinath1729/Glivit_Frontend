import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, hexToRgba } from '@/src/theme/tokens';

/** Coloured status badge shared by list rows, cards and the live-track header. */
export function StatusPill({ state }: { state: string }) {
  const { stateColors } = useTheme();
  const styles = useMemo(() => makeStyles(), []);
  
  const color = useMemo(() => {
    const normalized = (state ?? '').trim().toUpperCase();
    const colorKey = 
      normalized === 'ENGINE CUT' || normalized === 'LOCKED' ? 'IMMOBILISED' :
      normalized === 'GPS ERROR' ? 'GPS_INVALID' :
      normalized === 'LOW ACCURACY' ? 'IDLE' :
      normalized;
    return stateColors[colorKey] ?? stateColors[state] ?? stateColors.NO_DATA;
  }, [state, stateColors]);

  return (
    <View style={[styles.pill, { backgroundColor: hexToRgba(color, 0.13), borderColor: hexToRgba(color, 0.33) }]}>
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
