import React, { useMemo } from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';

import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, type ThemeColors } from '@/src/theme/tokens';

type CardProps = ViewProps & { elevated?: boolean };

export function Card({ style, children, elevated = true, ...rest }: CardProps) {
  const { colors, elevation } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[styles.card, elevated ? elevation(1) : null, style]} {...rest}>
      {children}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth * 2,
      padding: spacing.md,
    },
  });
