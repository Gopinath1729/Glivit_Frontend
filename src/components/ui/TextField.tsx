import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';

import { useTheme } from '@/src/theme/ThemeProvider';
import { layout, radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

type TextFieldProps = TextInputProps & {
  label?: string;
  error?: string;
  secure?: boolean;
  leftIcon?: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  onLeftIconPress?: () => void;
};

/** Labelled input with a validation error slot and optional password toggle or leading icon. */
export function TextField({
  label,
  error,
  secure = false,
  leftIcon,
  onLeftIconPress,
  style,
  onFocus,
  onBlur,
  ...rest
}: TextFieldProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [hidden, setHidden] = useState(secure);
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.wrapper}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View
        style={[
          styles.inputRow,
          focused ? styles.inputFocused : null,
          error ? styles.inputError : null,
        ]}>
        {leftIcon ? (
          <Pressable
            accessibilityLabel="Search icon"
            accessibilityRole="button"
            disabled={!onLeftIconPress}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={onLeftIconPress}>
            <MaterialCommunityIcons
              color={focused ? colors.primary : colors.textSecondary}
              name={leftIcon}
              size={20}
              style={{ marginRight: spacing.xs }}
            />
          </Pressable>
        ) : null}
        <TextInput
          placeholderTextColor={colors.textMuted}
          secureTextEntry={hidden}
          style={[styles.input, style]}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          {...rest}
        />
        {secure ? (
          <MaterialCommunityIcons
            accessibilityLabel={hidden ? 'Show password' : 'Hide password'}
            color={colors.textSecondary}
            name={hidden ? 'eye-off-outline' : 'eye-outline'}
            onPress={() => setHidden((v) => !v)}
            size={22}
            style={styles.toggle}
          />
        ) : null}
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrapper: {
      width: '100%',
    },
    label: {
      color: c.textSecondary,
      fontSize: typography.label,
      fontWeight: '600',
      marginBottom: spacing.xs,
    },
    inputRow: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      height: layout.inputHeight,
      paddingHorizontal: spacing.md,
    },
    inputFocused: {
      borderColor: c.primary,
    },
    inputError: {
      borderColor: c.danger,
    },
    input: {
      color: c.textPrimary,
      flex: 1,
      fontSize: typography.body,
      height: '100%',
    },
    toggle: {
      paddingLeft: spacing.sm,
    },
    errorText: {
      color: c.danger,
      fontSize: typography.caption,
      marginTop: spacing.xs,
    },
  });
