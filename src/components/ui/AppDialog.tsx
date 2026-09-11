import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

type DialogTone = 'success' | 'danger' | 'info';

type AppDialogProps = {
  busy?: boolean;
  cancelLabel?: string;
  confirmLabel?: string;
  message: string;
  onCancel?: () => void;
  onConfirm: () => void;
  title: string;
  tone?: DialogTone;
  visible: boolean;
};

const toneDetails: Record<DialogTone, { color: string; icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'] }> = {
  success: { color: '#08BF74', icon: 'check' },
  danger: { color: '#DC2626', icon: 'trash-can-outline' },
  info: { color: '#1267E8', icon: 'information-outline' },
};

/** Branded confirmation/result dialog inspired by the application's card language. */
export function AppDialog({
  busy = false,
  cancelLabel,
  confirmLabel = 'OK',
  message,
  onCancel,
  onConfirm,
  title,
  tone = 'info',
  visible,
}: AppDialogProps) {
  const { colors } = useTheme();
  const styles = React.useMemo(() => makeStyles(colors), [colors]);
  const detail = toneDetails[tone];

  return (
    <Modal
      animationType="fade"
      onRequestClose={onCancel ?? onConfirm}
      statusBarTranslucent
      transparent
      visible={visible}>
      <View style={styles.backdrop}>
        <Pressable
          accessibilityLabel="Close dialog"
          disabled={!onCancel || busy}
          onPress={onCancel}
          style={StyleSheet.absoluteFill}
        />
        <View accessibilityViewIsModal style={styles.card}>
          <View style={[styles.outerRing, { backgroundColor: `${detail.color}12` }]}>
            <View style={[styles.middleRing, { backgroundColor: `${detail.color}1F` }]}>
              <View style={[styles.iconCircle, { backgroundColor: detail.color }]}>
                <MaterialCommunityIcons color="#FFFFFF" name={detail.icon} size={29} />
              </View>
            </View>
          </View>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <View style={styles.actions}>
            {cancelLabel && onCancel ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={onCancel}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
                <Text style={styles.secondaryText}>{cancelLabel}</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onConfirm}
              style={({ pressed }) => [
                styles.primaryButton,
                tone === 'danger' && styles.dangerButton,
                busy && styles.disabled,
                pressed && !busy && styles.pressed,
              ]}>
              <Text style={styles.primaryText}>{busy ? 'Please wait…' : confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    backdrop: {
      alignItems: 'center',
      backgroundColor: 'rgba(10, 23, 43, 0.50)',
      flex: 1,
      justifyContent: 'center',
      padding: spacing.xl,
    },
    card: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: 28,
      borderWidth: StyleSheet.hairlineWidth,
      maxWidth: 430,
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.xl,
      shadowColor: '#07152A',
      shadowOffset: { width: 0, height: 18 },
      shadowOpacity: 0.24,
      shadowRadius: 34,
      width: '100%',
      elevation: 18,
    },
    outerRing: {
      alignItems: 'center',
      borderRadius: 999,
      height: 92,
      justifyContent: 'center',
      marginBottom: spacing.md,
      width: 92,
    },
    middleRing: {
      alignItems: 'center',
      borderRadius: 999,
      height: 68,
      justifyContent: 'center',
      width: 68,
    },
    iconCircle: {
      alignItems: 'center',
      borderRadius: 999,
      height: 48,
      justifyContent: 'center',
      shadowColor: '#07152A',
      shadowOffset: { width: 0, height: 7 },
      shadowOpacity: 0.16,
      shadowRadius: 12,
      width: 48,
      elevation: 5,
    },
    title: {
      color: c.textPrimary,
      fontSize: typography.h2,
      fontWeight: '900',
      textAlign: 'center',
    },
    message: {
      color: c.textSecondary,
      fontSize: typography.body,
      lineHeight: 22,
      marginTop: spacing.sm,
      maxWidth: 340,
      textAlign: 'center',
    },
    actions: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.xl,
      width: '100%',
    },
    primaryButton: {
      alignItems: 'center',
      backgroundColor: '#1267E8',
      borderRadius: radius.md,
      flex: 1,
      height: 48,
      justifyContent: 'center',
      shadowColor: '#1267E8',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.22,
      shadowRadius: 14,
      elevation: 4,
    },
    dangerButton: { backgroundColor: '#DC2626', shadowColor: '#DC2626' },
    secondaryButton: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flex: 1,
      height: 48,
      justifyContent: 'center',
    },
    primaryText: { color: '#FFFFFF', fontSize: typography.body, fontWeight: '900' },
    secondaryText: { color: c.textPrimary, fontSize: typography.body, fontWeight: '800' },
    disabled: { opacity: 0.55 },
    pressed: { opacity: 0.78 },
  });
