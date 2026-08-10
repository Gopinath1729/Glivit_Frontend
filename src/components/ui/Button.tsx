import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@/src/theme/ThemeProvider';
import { layout, radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

type ButtonProps = {
  label: string;
  onPress?: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  color?: string;
  textColor?: string;
  icon?: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  style?: ViewStyle;
};

/**
 * Full-width button with its own loading state (never a global spinner) so a
 * single action shows progress without disabling unrelated buttons.
 */
export function Button({
  label,
  onPress,
  loading = false,
  disabled = false,
  variant = 'primary',
  color,
  textColor: customTextColor,
  icon,
  style,
}: ButtonProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const isDisabled = disabled || loading;

  const background =
    variant === 'primary'
      ? color || colors.primary
      : variant === 'danger'
        ? colors.danger
        : variant === 'secondary'
          ? colors.surfaceAlt
          : 'transparent';
  const textColor =
    customTextColor ||
    (variant === 'primary'
      ? colors.onPrimary
      : variant === 'danger'
        ? colors.white
        : colors.textPrimary);
  const bordered = variant === 'secondary' || variant === 'ghost';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: background,
          borderColor: bordered ? colors.borderStrong : 'transparent',
          borderWidth: bordered ? StyleSheet.hairlineWidth * 2 : 0,
          opacity: isDisabled ? 0.5 : pressed ? 0.88 : 1,
          transform: [{ scale: pressed && !isDisabled ? 0.99 : 1 }],
        },
        variant === 'ghost' && styles.ghost,
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <View style={styles.content}>
          {icon ? <MaterialCommunityIcons color={textColor} name={icon} size={18} /> : null}
          <Text style={[styles.label, { color: textColor }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    base: {
      alignItems: 'center',
      borderRadius: radius.md,
      height: layout.buttonHeight,
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
      width: '100%',
    },
    ghost: {
      height: undefined,
      paddingVertical: spacing.sm,
      width: undefined,
    },
    content: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
    },
    label: {
      fontSize: typography.body,
      fontWeight: '700',
      letterSpacing: 0.2,
    },
  });
