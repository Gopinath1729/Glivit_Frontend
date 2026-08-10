import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/src/components/ui/Button';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

export function LoadingView({ label = 'Loading…' }: { label?: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary} size="large" />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

export function EmptyView({
  icon = 'inbox-outline',
  title,
  message,
}: {
  icon?: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  title: string;
  message?: string;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.center}>
      <View style={styles.iconHalo}>
        <MaterialCommunityIcons color={colors.textSecondary} name={icon} size={40} />
      </View>
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.muted}>{message}</Text> : null}
    </View>
  );
}

export function ErrorRetryView({ message, onRetry }: { message?: string; onRetry: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.center}>
      <View style={[styles.iconHalo, styles.iconHaloError]}>
        <MaterialCommunityIcons color={colors.danger} name="alert-circle-outline" size={40} />
      </View>
      <Text style={styles.title}>Something went wrong</Text>
      {message ? <Text style={styles.muted}>{message}</Text> : null}
      <View style={styles.retryButton}>
        <Button label="Retry" icon="refresh" onPress={onRetry} />
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    center: {
      alignItems: 'center',
      backgroundColor: c.pageBackground,
      flex: 1,
      justifyContent: 'center',
      padding: spacing.xl,
    },
    iconHalo: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      height: 84,
      justifyContent: 'center',
      marginBottom: spacing.md,
      width: 84,
    },
    iconHaloError: {
      backgroundColor: 'rgba(220,38,38,0.10)',
      borderColor: 'rgba(220,38,38,0.30)',
    },
    title: {
      color: c.textPrimary,
      fontSize: typography.title,
      fontWeight: '800',
      textAlign: 'center',
    },
    muted: {
      color: c.textSecondary,
      fontSize: typography.body,
      marginTop: spacing.sm,
      textAlign: 'center',
    },
    retryButton: {
      marginTop: spacing.lg,
      width: 180,
    },
  });
