import React, { useMemo } from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';

import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, type ThemeColors } from '@/src/theme/tokens';

/**
 * Material 3 card.
 *
 * M3 gives a card three jobs, and mixing them is what makes a screen look
 * unsettled: `elevated` floats above the background, `filled` recedes into it
 * as a grouping device, and `outlined` states a boundary without implying
 * height. `elevated` stays the default so existing callers are unchanged.
 */
type CardVariant = 'elevated' | 'filled' | 'outlined';

type CardProps = ViewProps & {
  /** Legacy switch: `false` is the same as variant="outlined". */
  elevated?: boolean;
  variant?: CardVariant;
  /** Elevation level for the elevated variant. M3 cards rest at 1. */
  level?: 1 | 2 | 3 | 4 | 5;
};

export function Card({
  style,
  children,
  elevated = true,
  variant,
  level = 1,
  ...rest
}: CardProps) {
  const { colors, elevation } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const kind: CardVariant = variant ?? (elevated ? 'elevated' : 'outlined');

  return (
    <View
      style={[
        styles.card,
        kind === 'filled' && styles.filled,
        kind === 'outlined' && styles.outlined,
        kind === 'elevated' && [styles.elevated, elevation(level)],
        style,
      ]}
      {...rest}>
      {children}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      borderRadius: radius.md,
      padding: spacing.md,
    },
    elevated: {
      backgroundColor: c.surface,
    },
    filled: {
      backgroundColor: c.surfaceAlt,
    },
    outlined: {
      backgroundColor: c.surface,
      borderColor: c.border,
      // A true hairline, not a doubled one: M3 outlines state a boundary, they
      // do not draw attention to themselves.
      borderWidth: StyleSheet.hairlineWidth,
    },
  });
