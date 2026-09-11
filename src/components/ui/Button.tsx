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
import {
  disabledOpacity,
  hexToRgba,
  layout,
  radius,
  spacing,
  stateLayerOpacity,
  typeScale,
  weight,
  type ThemeColors,
} from '@/src/theme/tokens';

/**
 * Material 3 variants. The legacy names are kept as aliases so the twenty-odd
 * screens already calling this component keep working while reading as M3:
 * `primary` is a filled button, `secondary` an outlined one, `ghost` a text
 * button.
 */
type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'filled'
  | 'tonal'
  | 'outlined'
  | 'text';

type ButtonProps = {
  label: string;
  onPress?: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: ButtonVariant;
  color?: string;
  textColor?: string;
  icon?: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  /** Lets a button size to its content instead of filling the row. */
  compact?: boolean;
  style?: ViewStyle;
};

function resolveVariant(variant: ButtonVariant) {
  if (variant === 'primary') return 'filled';
  if (variant === 'secondary') return 'outlined';
  if (variant === 'ghost') return 'text';
  return variant;
}

/**
 * Material 3 button with its own loading state (never a global spinner) so a
 * single action shows progress without disabling unrelated buttons.
 *
 * Press feedback is a translucent state layer over the container rather than a
 * scale transform. The transform version moved the button's own bounds on every
 * tap, which nudges neighbouring layout and reads as jitter; a state layer
 * conveys the same press without anything moving.
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
  compact = false,
  style,
}: ButtonProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const isDisabled = disabled || loading;
  const kind = resolveVariant(variant);

  const accent = color || (kind === 'danger' ? colors.danger : colors.primary);

  const container =
    kind === 'filled'
      ? accent
      : kind === 'danger'
        ? colors.danger
        : kind === 'tonal'
          ? colors.accentSoft
          : 'transparent';

  const content =
    customTextColor ||
    (kind === 'filled' || kind === 'danger'
      ? colors.onPrimary
      : kind === 'tonal'
        ? colors.primaryStrong
        : accent);

  const outlined = kind === 'outlined';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        compact && styles.compact,
        {
          backgroundColor: isDisabled && kind !== 'text' && kind !== 'outlined'
            ? hexToRgba(colors.textPrimary, disabledOpacity.container)
            : container,
          borderColor: outlined ? colors.border : 'transparent',
          borderWidth: outlined ? 1 : 0,
          opacity: isDisabled ? disabledOpacity.content + 0.2 : 1,
        },
        style,
      ]}>
      {({ pressed }: { pressed: boolean }) => (
        <>
          {/* The state layer sits inside the container, so it inherits the
              shape and can never change the button's measured size. */}
          {pressed && !isDisabled ? (
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                styles.stateLayer,
                { backgroundColor: hexToRgba(content, stateLayerOpacity.pressed) },
              ]}
            />
          ) : null}
          {loading ? (
            <ActivityIndicator color={content} />
          ) : (
            <View style={styles.content}>
              {icon ? <MaterialCommunityIcons color={content} name={icon} size={18} /> : null}
              <Text numberOfLines={1} style={[styles.label, { color: content }]}>
                {label}
              </Text>
            </View>
          )}
        </>
      )}
    </Pressable>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    base: {
      alignItems: 'center',
      // M3 buttons are stadium-shaped; this is the single most recognisable
      // signal that the app follows Material rather than a generic card style.
      borderRadius: radius.pill,
      height: layout.buttonHeight,
      justifyContent: 'center',
      overflow: 'hidden',
      paddingHorizontal: spacing.lg,
      width: '100%',
    },
    compact: {
      alignSelf: 'flex-start',
      paddingHorizontal: spacing.md,
      width: undefined,
    },
    stateLayer: { borderRadius: radius.pill },
    content: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
    },
    label: {
      ...typeScale.labelLarge,
      fontWeight: weight.medium,
    },
  });
