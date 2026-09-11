import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated';

import { KeyboardBottomSheet } from '@/src/components/ui/KeyboardAwareForm';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

export function ManagementCreateButton({
  accessibilityLabel,
  disabled = false,
  onPress,
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.createButton,
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
      ]}>
      <MaterialCommunityIcons color={c.primary} name="plus" size={24} />
    </Pressable>
  );
}

export function ManagementSectionHeader({
  title,
  subtitle,
  onCreate,
  createLabel,
}: {
  title: string;
  subtitle: string;
  onCreate?: () => void;
  createLabel?: string;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionHeaderText}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionSubtitle}>{subtitle}</Text>
      </View>
      <View style={styles.sectionHeaderActions}>
        {onCreate ? (
          <ManagementCreateButton
            accessibilityLabel={createLabel ?? `Create ${title.toLowerCase()}`}
            onPress={onCreate}
          />
        ) : null}
      </View>
    </View>
  );
}

export function ManagementCard({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return <View style={[styles.card, style]}>{children}</View>;
}

export function ManagementActionButton({
  accessibilityLabel,
  label,
  icon,
  onPress,
  destructive = false,
}: {
  accessibilityLabel?: string;
  label: string;
  icon: IconName;
  onPress: () => void;
  destructive?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const color = destructive ? c.danger : c.textPrimary;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.cardAction,
        destructive && styles.cardActionDanger,
        pressed && styles.pressed,
      ]}>
      <MaterialCommunityIcons color={color} name={icon} size={15} />
      <Text style={[styles.cardActionText, { color }]}>{label}</Text>
    </Pressable>
  );
}

export function ManagementModal({
  children,
  eyebrow = 'MANAGEMENT',
  onClose,
  title,
  visible,
  maxHeightRatio = 0.9,
}: {
  children: React.ReactNode;
  /** Section this form belongs to, above the title. */
  eyebrow?: string;
  onClose: () => void;
  title: string;
  visible: boolean;
  maxHeightRatio?: number;
}) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}>
      <View style={styles.modalOverlay}>
        <Pressable
          accessibilityLabel="Close modal"
          accessibilityRole="button"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View
          entering={FadeInDown.springify().damping(18).stiffness(190)}
          exiting={FadeOut.duration(150)}
          style={styles.modalFrame}>
          <KeyboardBottomSheet
            maxHeightRatio={maxHeightRatio}
            style={[styles.modalCard, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
            <View style={styles.modalHeader}>
              <View style={styles.modalTitleWrap}>
                <Text style={styles.modalEyebrow}>{eyebrow}</Text>
                <Text numberOfLines={1} style={styles.modalTitle}>
                  {title}
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Close"
                accessibilityRole="button"
                hitSlop={6}
                onPress={onClose}
                style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
                <MaterialCommunityIcons color={c.textSecondary} name="close" size={22} />
              </Pressable>
            </View>
            <View style={styles.modalContent}>{children}</View>
          </KeyboardBottomSheet>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** @deprecated Prefer the centered ManagementModal name. */
export const ManagementBottomSheet = ManagementModal;

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    pressed: { opacity: 0.72 },
    disabled: { opacity: 0.4 },
    createButton: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderColor: c.primary,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    sectionHeader: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderTopColor: c.divider,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 72,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
    },
    sectionHeaderText: { flex: 1, minWidth: 0 },
    sectionHeaderActions: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
    sectionTitle: { color: c.textPrimary, fontSize: typography.h2, fontWeight: '800' },
    sectionSubtitle: { color: c.textMuted, fontSize: typography.caption, marginTop: 2 },
    card: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      gap: spacing.sm,
      padding: spacing.md,
    },
    cardAction: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.sm,
      flexDirection: 'row',
      gap: 5,
      minHeight: 34,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 2,
    },
    cardActionDanger: { backgroundColor: 'rgba(239, 68, 68, 0.10)' },
    cardActionText: { fontSize: typography.caption, fontWeight: '700' },
    modalOverlay: {
      alignItems: 'center',
      backgroundColor: c.overlay,
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xl,
    },
    modalFrame: { maxWidth: 760, width: '100%' },
    modalCard: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.xl,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 18,
      minHeight: 0,
      overflow: 'hidden',
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 14 },
      shadowOpacity: 0.26,
      shadowRadius: 30,
      width: '100%',
    },
    modalContent: { flexShrink: 1, minHeight: 0 },
    modalHeader: {
      alignItems: 'center',
      borderBottomColor: c.divider,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 66,
      paddingLeft: spacing.md + 4,
      paddingRight: spacing.sm,
    },
    modalTitleWrap: { flex: 1, minWidth: 0 },
    modalEyebrow: {
      color: c.primary,
      fontSize: 9,
      fontWeight: '900',
      letterSpacing: 1.1,
      marginBottom: 2,
    },
    modalTitle: {
      color: c.textPrimary,
      fontSize: typography.title,
      fontWeight: '900',
    },
    closeButton: {
      alignItems: 'center',
      borderRadius: radius.pill,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
  });
