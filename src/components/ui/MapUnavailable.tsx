import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/src/components/ui/Button';
import { useTheme } from '@/src/theme/ThemeProvider';
import { spacing, typography, type ThemeColors } from '@/src/theme/tokens';

/** Shown when the native map module cannot be rendered in the current binary. */
export function MapUnavailable({ onAction, actionLabel }: { onAction?: () => void; actionLabel?: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.container}>
      <MaterialCommunityIcons color={colors.primary} name="map-marker-radius-outline" size={64} />
      <Text style={styles.title}>Map unavailable</Text>
      <Text style={styles.message}>
        Native maps are not available in this runtime. Run the app on Android or iOS to view the map.
      </Text>
      {onAction ? (
        <View style={styles.action}>
          <Button label={actionLabel ?? 'Go back'} onPress={onAction} variant="secondary" />
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: {
      alignItems: 'center',
      backgroundColor: c.pageBackground,
      flex: 1,
      justifyContent: 'center',
      padding: spacing.xl,
    },
    title: {
      color: c.textPrimary,
      fontSize: typography.title,
      fontWeight: '800',
      marginTop: spacing.md,
      textAlign: 'center',
    },
    message: {
      color: c.textSecondary,
      fontSize: typography.body,
      lineHeight: 22,
      marginTop: spacing.sm,
      textAlign: 'center',
    },
    action: { marginTop: spacing.lg, width: 200 },
  });
