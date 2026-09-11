import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

type ListPaginationProps = {
  itemLabel?: string;
  onPageChange: (page: number) => void;
  page: number;
  pageSize?: number;
  totalItems: number;
  totalPages: number;
};

/** Hidden for short lists; shown only when another page actually exists. */
export function ListPagination({
  itemLabel = 'items',
  onPageChange,
  page,
  pageSize = 10,
  totalItems,
  totalPages,
}: ListPaginationProps) {
  const { colors } = useTheme();
  const styles = React.useMemo(() => makeStyles(colors), [colors]);

  if (totalItems <= pageSize || totalPages <= 1) return null;

  return (
    <View accessibilityLabel="Pagination" style={styles.root}>
      <Pressable
        accessibilityLabel="Previous page"
        accessibilityRole="button"
        disabled={page <= 0}
        onPress={() => onPageChange(page - 1)}
        style={({ pressed }) => [
          styles.button,
          page <= 0 && styles.disabled,
          pressed && page > 0 && styles.pressed,
        ]}>
        <MaterialCommunityIcons color={colors.textPrimary} name="chevron-left" size={19} />
      </Pressable>
      <View style={styles.copy}>
        <Text style={styles.pageText}>
          {page + 1} <Text style={styles.pageMuted}>of {totalPages}</Text>
        </Text>
        <Text style={styles.countText}>{totalItems} {itemLabel}</Text>
      </View>
      <Pressable
        accessibilityLabel="Next page"
        accessibilityRole="button"
        disabled={page >= totalPages - 1}
        onPress={() => onPageChange(page + 1)}
        style={({ pressed }) => [
          styles.button,
          page >= totalPages - 1 && styles.disabled,
          pressed && page < totalPages - 1 && styles.pressed,
        ]}>
        <MaterialCommunityIcons color={colors.textPrimary} name="chevron-right" size={19} />
      </Pressable>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: {
      alignItems: 'center',
      alignSelf: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      marginVertical: spacing.sm,
      padding: 4,
    },
    button: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      height: 32,
      justifyContent: 'center',
      width: 32,
    },
    copy: { alignItems: 'center', minWidth: 78 },
    pageText: { color: c.textPrimary, fontSize: typography.caption, fontWeight: '800' },
    pageMuted: { color: c.textMuted, fontWeight: '600' },
    countText: { color: c.textMuted, fontSize: 9, marginTop: 1 },
    disabled: { opacity: 0.35 },
    pressed: { opacity: 0.68 },
  });
