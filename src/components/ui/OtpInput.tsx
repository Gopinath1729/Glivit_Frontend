import React, { useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useKeyboardFocusReporter } from '@/src/components/ui/KeyboardAwareForm';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

type OtpInputProps = {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  /** Fired once the last digit is entered, so the user does not have to reach for the button. */
  onComplete?: (value: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  error?: string;
};

/**
 * Six separate-looking boxes backed by one real input.
 *
 * Six actual TextInputs is the obvious build and the wrong one: focus has to be
 * hand-managed on every keystroke, backspace from an empty box has no natural
 * behaviour, and pasting a code or accepting the keyboard's SMS autofill drops
 * five of the six digits. One transparent input holding the whole string gets
 * paste, autofill, backspace and selection for free; the boxes are decoration
 * drawn from its value.
 */
export function OtpInput({
  value,
  onChange,
  length = 6,
  onComplete,
  autoFocus = false,
  disabled = false,
  error,
}: OtpInputProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const keyboardFocus = useKeyboardFocusReporter();

  const digits = value.split('').slice(0, length);
  const activeIndex = Math.min(digits.length, length - 1);

  const handleChange = (next: string) => {
    // Strip anything that is not a digit so a pasted "Code: 123 456" still works.
    const cleaned = next.replace(/[^0-9]/g, '').slice(0, length);
    onChange(cleaned);
    if (cleaned.length === length) {
      onComplete?.(cleaned);
    }
  };

  return (
    <View style={styles.wrapper}>
      <Pressable
        accessibilityLabel="Verification code"
        accessibilityRole="none"
        disabled={disabled}
        onPress={() => inputRef.current?.focus()}
        style={styles.boxRow}>
        {Array.from({ length }).map((_, index) => {
          const filled = index < digits.length;
          const isActive = focused && index === activeIndex && !disabled;
          return (
            <View
              key={index}
              style={[
                styles.box,
                filled && styles.boxFilled,
                isActive && styles.boxActive,
                error ? styles.boxError : null,
                disabled && styles.boxDisabled,
              ]}>
              <Text style={styles.boxText}>{digits[index] ?? ''}</Text>
            </View>
          );
        })}
      </Pressable>

      <TextInput
        ref={inputRef}
        autoFocus={autoFocus}
        // One-time-code hints let iOS and Android offer the code straight from
        // the notification, which is the difference between typing six digits
        // and tapping once.
        autoComplete={Platform.OS === 'android' ? 'sms-otp' : 'one-time-code'}
        textContentType="oneTimeCode"
        caretHidden
        editable={!disabled}
        keyboardType="number-pad"
        maxLength={length}
        onBlur={() => setFocused(false)}
        onChangeText={handleChange}
        onFocus={(e) => {
          setFocused(true);
          keyboardFocus?.onInputFocused((e.target as unknown as number) ?? null);
        }}
        style={styles.hiddenInput}
        value={value}
      />

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrapper: { width: '100%' },
    boxRow: {
      flexDirection: 'row',
      gap: spacing.xs,
      justifyContent: 'space-between',
      width: '100%',
    },
    box: {
      alignItems: 'center',
      backgroundColor: 'rgba(255,255,255,0.05)',
      borderColor: 'rgba(255,255,255,0.16)',
      borderRadius: radius.md,
      borderWidth: 1.5,
      flex: 1,
      height: 54,
      justifyContent: 'center',
      maxWidth: 56,
    },
    boxFilled: { borderColor: 'rgba(138, 180, 248,0.55)' },
    boxActive: { borderColor: '#8AB4F8' },
    boxError: { borderColor: c.danger },
    boxDisabled: { opacity: 0.5 },
    boxText: {
      color: '#F4FAFE',
      fontSize: 22,
      fontWeight: '800',
    },
    /**
     * Kept in the tree and focusable, but invisible. `display: none` or a zero
     * size would stop the keyboard opening and stop autofill from finding it.
     */
    hiddenInput: {
      height: 54,
      left: 0,
      opacity: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    errorText: {
      color: c.danger,
      fontSize: typography.caption,
      marginTop: spacing.xs,
      textAlign: 'center',
    },
  });
