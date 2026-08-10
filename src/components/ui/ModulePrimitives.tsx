import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

function useStyles() {
  const { colors } = useTheme();
  return { c: colors, styles: useMemo(() => makeStyles(colors), [colors]) };
}

export function Screen({ children }: { children: React.ReactNode }) {
  const { styles } = useStyles();
  return <View style={styles.screen}>{children}</View>;
}

export function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  const { styles } = useStyles();
  return (
    <View style={styles.sectionTitle}>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function Chip({
  label,
  active,
  onPress,
  style,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  style?: ViewStyle;
}) {
  const { styles } = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        active ? styles.chipActive : null,
        pressed && { opacity: 0.85 },
        style,
      ]}>
      <Text style={[styles.chipText, active ? styles.chipTextActive : null]}>{label}</Text>
    </Pressable>
  );
}

export function RowCard({
  icon,
  title,
  meta,
  right,
  onPress,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  title: string;
  meta?: string;
  right?: React.ReactNode;
  onPress?: () => void;
}) {
  const { c, styles } = useStyles();
  const Wrapper = onPress ? Pressable : View;
  return (
    <Wrapper accessibilityRole={onPress ? 'button' : undefined} onPress={onPress} style={styles.rowCard}>
      <View style={styles.rowIcon}>
        <MaterialCommunityIcons color={c.primary} name={icon} size={22} />
      </View>
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {title}
        </Text>
        {meta ? (
          <Text numberOfLines={2} style={styles.rowMeta}>
            {meta}
          </Text>
        ) : null}
      </View>
      {right}
    </Wrapper>
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  const { styles } = useStyles();
  return <Text style={styles.fieldLabel}>{children}</Text>;
}

export function EmptyLine({ text }: { text: string }) {
  const { styles } = useStyles();
  return <Text style={styles.empty}>{text}</Text>;
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    sectionTitle: { gap: 2, paddingBottom: spacing.sm },
    title: { color: c.textPrimary, fontSize: typography.title, fontWeight: '800' },
    subtitle: { color: c.textSecondary, fontSize: typography.caption, lineHeight: 17 },
    chip: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: 'transparent',
      height: 38,
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
    },
    chipActive: {
      backgroundColor: c.primaryGreen,
      borderColor: c.primaryGreen,
    },
    chipText: { color: c.primaryGreen, fontSize: typography.caption, fontWeight: '700' },
    chipTextActive: { color: c.white },
    rowCard: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.md,
      minHeight: 70,
      padding: spacing.md,
    },
    rowIcon: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderRadius: radius.sm,
      height: 42,
      justifyContent: 'center',
      width: 42,
    },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { color: c.textPrimary, fontSize: typography.body, fontWeight: '800' },
    rowMeta: { color: c.textSecondary, fontSize: typography.caption, lineHeight: 17, marginTop: 2 },
    fieldLabel: { color: c.textSecondary, fontSize: typography.caption, fontWeight: '700' },
    empty: { color: c.textSecondary, fontSize: typography.body, padding: spacing.md, textAlign: 'center' },
  });
