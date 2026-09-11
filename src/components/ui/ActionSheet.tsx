import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, type ThemeColors } from '@/src/theme/tokens';

export type ActionSheetItem = {
  destructive?: boolean;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  onPress: () => void;
};

type ActionSheetProps = {
  items: ActionSheetItem[];
  onClose: () => void;
  subtitle?: string;
  title: string;
  visible: boolean;
};

/**
 * A short menu of actions for one row.
 *
 * <p>The alternative was `Alert.alert` with a button array, which the platform
 * draws in its own chrome - so tapping "Manage" produced a grey system sheet
 * that then handed off to this app's branded confirmation, and the two looked
 * like they came from different products. A menu is also not a confirmation:
 * it has no destructive default and no "are you sure", so it should not borrow
 * the dialog's rings and centred icon.
 */
export function ActionSheet({ items, onClose, subtitle, title, visible }: ActionSheetProps) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => makeStyles(c), [c]);

  return (
    <Modal
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={visible}>
      <Animated.View
        entering={FadeIn.duration(140)}
        exiting={FadeOut.duration(140)}
        style={styles.backdrop}>
        <Pressable accessibilityLabel="Close menu" onPress={onClose} style={StyleSheet.absoluteFill} />
        <Animated.View
          entering={FadeInDown.duration(190).springify().damping(19).stiffness(210)}
          exiting={FadeOut.duration(120)}
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text numberOfLines={1} style={styles.title}>
              {title}
            </Text>
            {subtitle ? (
              <Text numberOfLines={1} style={styles.subtitle}>
                {subtitle}
              </Text>
            ) : null}
          </View>

          {items.map((item) => (
            <Pressable
              accessibilityRole="button"
              key={item.label}
              onPress={() => {
                // Close first: leaving the sheet up behind a confirmation
                // stacks two modals and the dialog cannot be dismissed.
                onClose();
                item.onPress();
              }}
              style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}>
              <MaterialCommunityIcons
                color={item.destructive ? c.danger : c.textPrimary}
                name={item.icon}
                size={19}
              />
              <Text style={[styles.itemText, item.destructive && styles.itemTextDanger]}>
                {item.label}
              </Text>
            </Pressable>
          ))}

          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.cancel, pressed && styles.itemPressed]}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    backdrop: { backgroundColor: 'rgba(8, 18, 36, 0.46)', flex: 1, justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
    },
    handle: {
      alignSelf: 'center',
      backgroundColor: c.border,
      borderRadius: 3,
      height: 4,
      marginBottom: spacing.sm,
      width: 40,
    },
    header: {
      borderBottomColor: c.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      paddingBottom: spacing.sm,
      paddingHorizontal: spacing.xs,
    },
    title: { color: c.textPrimary, fontSize: 15, fontWeight: '900' },
    subtitle: { color: c.textMuted, fontSize: 12, marginTop: 2 },
    item: {
      alignItems: 'center',
      borderRadius: radius.md,
      flexDirection: 'row',
      gap: spacing.sm + 2,
      marginTop: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm + 3,
    },
    itemPressed: { backgroundColor: c.surfaceAlt },
    itemText: { color: c.textPrimary, fontSize: 14.5, fontWeight: '700' },
    itemTextDanger: { color: c.danger },
    cancel: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      marginTop: spacing.sm,
      paddingVertical: spacing.sm + 3,
    },
    cancelText: { color: c.textSecondary, fontSize: 14.5, fontWeight: '800' },
  });
