import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

type CompactSearchBarProps = Omit<TextInputProps, 'style'> & {
  loading?: boolean;
};

/** A dense search field shared by list screens. */
export function CompactSearchBar({
  loading = false,
  onChangeText,
  value,
  ...props
}: CompactSearchBarProps) {
  const { colors } = useTheme();
  const styles = React.useMemo(() => makeStyles(colors), [colors]);

  return (
    <View style={styles.shell}>
      <MaterialCommunityIcons color={colors.textMuted} name="magnify" size={18} />
      <TextInput
        accessibilityRole="search"
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="never"
        onChangeText={onChangeText}
        placeholderTextColor={colors.textMuted}
        returnKeyType="search"
        style={styles.input}
        value={value}
        {...props}
      />
      {loading ? <ActivityIndicator color={colors.primary} size="small" /> : null}
      {!loading && value ? (
        <Pressable
          accessibilityLabel="Clear search"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => onChangeText?.('')}
          style={({ pressed }) => [styles.clear, pressed && styles.pressed]}>
          <MaterialCommunityIcons color={colors.textMuted} name="close-circle" size={17} />
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    shell: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.xs,
      height: 38,
      paddingHorizontal: spacing.sm + 2,
    },
    input: {
      color: c.textPrimary,
      flex: 1,
      fontSize: typography.caption,
      height: '100%',
      paddingVertical: 0,
    },
    clear: {
      alignItems: 'center',
      borderRadius: radius.pill,
      justifyContent: 'center',
    },
    pressed: { opacity: 0.65 },
  });
