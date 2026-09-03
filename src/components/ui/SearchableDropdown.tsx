import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardLift } from '@/src/components/ui/KeyboardAwareForm';
import { TextField } from '@/src/components/ui/TextField';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

export type DropdownOption = {
  id: number;
  label: string;
  subLabel?: string;
  phone?: string;
  dotColor?: string;
  searchTags?: string[];
};

export type SearchableDropdownProps = {
  label?: string;
  placeholder?: string;
  emptyText?: string;
  options: DropdownOption[];
  selectedId?: number;
  onSelect: (option: DropdownOption | undefined) => void;
  loading?: boolean;
  error?: string;
};

export function SearchableDropdown({
  label,
  placeholder = 'Select option...',
  emptyText = 'No items found',
  options,
  selectedId,
  onSelect,
  loading = false,
  error,
}: SearchableDropdownProps) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);

  const [modalVisible, setModalVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  /**
   * The sheet fits its content and stops at the usable-screen ceiling.
   *
   * `maxHeight: '80%'` was 80% of the RAW window, which on a device with a tall
   * status bar and a gesture bar is more than 80% of what anyone can see, and it
   * paid no attention to where the bottom navigation actually sits. Measuring
   * against the window minus the insets is what makes the ceiling mean the same
   * thing on both platforms.
   */
  const sheetMaxHeight = Math.max(240, (windowHeight - insets.top - insets.bottom) * 0.8);

  /**
   * The gap above the bottom navigation.
   *
   * This was a hardcoded `spacing.xl`, which on a device with no gesture bar is
   * simply a block of empty surface under the last row - the white space in the
   * report. It is now exactly the system inset plus one small gutter, so the
   * sheet ends where the navigation begins and nowhere further up.
   */
  const sheetPaddingBottom = insets.bottom + spacing.sm;
  const [searchQuery, setSearchQuery] = useState('');

  const selectedOption = useMemo(
    () => options.find((opt) => opt.id === selectedId),
    [options, selectedId]
  );

  const filteredOptions = useMemo(() => {
    if (!searchQuery.trim()) return options;
    const query = searchQuery.toLowerCase().trim();
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(query) ||
        (opt.subLabel && opt.subLabel.toLowerCase().includes(query)) ||
        (opt.phone && opt.phone.toLowerCase().includes(query)) ||
        (opt.searchTags && opt.searchTags.some(tag => tag.toLowerCase().includes(query)))
    );
  }, [options, searchQuery]);

  const handleOpen = () => {
    setSearchQuery('');
    setModalVisible(true);
  };

  const handleSelect = (option: DropdownOption) => {
    onSelect(option);
    setModalVisible(false);
  };

  const handleClear = () => {
    onSelect(undefined);
  };

  return (
    <View style={styles.container}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}

      <TouchableOpacity
        accessibilityRole="button"
        activeOpacity={0.7}
        onPress={handleOpen}
        style={[styles.trigger, Boolean(error) && styles.triggerError]}>
        <View style={[styles.triggerContent, { flexDirection: 'row', alignItems: 'center', gap: spacing.sm }]}>
          {selectedOption?.dotColor ? (
            <View style={[styles.dot, { backgroundColor: selectedOption.dotColor }]} />
          ) : null}
          <View style={{ flex: 1 }}>
            <Text
              numberOfLines={1}
              style={[
                styles.triggerText,
                !selectedOption && styles.triggerPlaceholder,
              ]}>
              {selectedOption ? selectedOption.label : placeholder}
            </Text>
            {selectedOption?.subLabel || selectedOption?.phone ? (
              <Text numberOfLines={1} style={styles.triggerSubText}>
                {selectedOption.subLabel ? selectedOption.subLabel : ''}
                {selectedOption.subLabel && selectedOption.phone ? ' • ' : ''}
                {selectedOption.phone ? selectedOption.phone : ''}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.triggerActions}>
          {selectedOption ? (
            <Pressable
              accessibilityLabel="Clear selection"
              accessibilityRole="button"
              hitSlop={8}
              onPress={handleClear}
              style={styles.clearButton}>
              <MaterialCommunityIcons color={c.textMuted} name="close-circle" size={18} />
            </Pressable>
          ) : null}
          <MaterialCommunityIcons color={c.textSecondary} name="chevron-down" size={20} />
        </View>
      </TouchableOpacity>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <Modal
        animationType="slide"
        onRequestClose={() => setModalVisible(false)}
        statusBarTranslucent
        transparent
        visible={modalVisible}>
        <View style={styles.modalBackdrop}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => setModalVisible(false)}
            style={StyleSheet.absoluteFill}
          />

          {/* The card is pinned to the bottom of the screen, which is exactly
              where the keyboard lands -- and the search field autofocuses, so
              without this the sheet opens already hidden behind the IME. */}
          <KeyboardLift useSafeArea={false}>
          <View
            style={[
              styles.modalCard,
              { maxHeight: sheetMaxHeight, paddingBottom: sheetPaddingBottom },
            ]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{label || 'Select'}</Text>
              <Pressable
                accessibilityLabel="Close"
                hitSlop={8}
                onPress={() => setModalVisible(false)}
                style={styles.closeIcon}>
                <MaterialCommunityIcons color={c.textSecondary} name="close" size={22} />
              </Pressable>
            </View>

            <View style={styles.searchContainer}>
              <TextField
                autoFocus
                label=""
                onChangeText={setSearchQuery}
                placeholder="Search..."
                value={searchQuery}
              />
            </View>

            <FlatList
              // No flex and no fixed height: the list is as tall as its rows
              // until it reaches the card's ceiling, at which point it scrolls.
              // Two vehicles therefore give a short sheet and twenty give a
              // scrollable one, with nothing to configure between them.
              bounces={false}
              contentContainerStyle={styles.listContent}
              data={filteredOptions}
              keyExtractor={(item) => String(item.id)}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyText}>
                    {loading ? 'Loading...' : emptyText}
                  </Text>
                </View>
              }
              renderItem={({ item }) => {
                const isSelected = item.id === selectedId;
                return (
                  <TouchableOpacity
                    accessibilityRole="button"
                    activeOpacity={0.7}
                    onPress={() => handleSelect(item)}
                    style={[styles.optionRow, isSelected && styles.optionRowSelected]}>
                    <View style={[styles.optionTextContainer, { flexDirection: 'row', alignItems: 'center', gap: spacing.sm }]}>
                      {item.dotColor ? (
                        <View style={[styles.dot, { backgroundColor: item.dotColor }]} />
                      ) : null}
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.optionLabel, isSelected && styles.optionLabelSelected]}>
                          {item.label}
                        </Text>
                        {item.subLabel || item.phone ? (
                          <Text style={styles.optionSubLabel}>
                            {item.subLabel ? `${item.subLabel}` : ''}
                            {item.subLabel && item.phone ? ' • ' : ''}
                            {item.phone ? item.phone : ''}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                    {isSelected ? (
                      <MaterialCommunityIcons color={c.primary} name="check" size={20} />
                    ) : null}
                  </TouchableOpacity>
                );
              }}
            />
          </View>
          </KeyboardLift>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: {
      gap: spacing.xs,
    },
    fieldLabel: {
      color: c.textSecondary,
      fontSize: typography.label,
      fontWeight: '600',
    },
    trigger: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 48,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    triggerError: {
      borderColor: c.danger,
    },
    triggerContent: {
      flex: 1,
      marginRight: spacing.sm,
    },
    triggerText: {
      color: c.textPrimary,
      fontSize: typography.body,
      fontWeight: '600',
    },
    triggerPlaceholder: {
      color: c.textMuted,
      fontWeight: '400',
    },
    triggerSubText: {
      color: c.textSecondary,
      fontSize: typography.caption,
      marginTop: 2,
    },
    triggerActions: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.xs,
    },
    clearButton: {
      padding: 2,
    },
    errorText: {
      color: c.danger,
      fontSize: typography.caption,
      marginTop: 2,
    },
    modalBackdrop: {
      backgroundColor: 'rgba(0,0,0,0.5)',
      flex: 1,
      justifyContent: 'flex-end',
    },
    modalCard: {
      backgroundColor: c.surface,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      // maxHeight and paddingBottom are applied at render from the safe-area
      // insets and the window size; a static value here cannot know either.
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
    },
    modalHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: spacing.md,
    },
    modalTitle: {
      color: c.textPrimary,
      fontSize: typography.title,
      fontWeight: '800',
    },
    closeIcon: {
      padding: spacing.xs,
    },
    searchContainer: {
      marginBottom: spacing.sm,
    },
    listContent: {
      paddingVertical: spacing.xs,
    },
    optionRow: {
      alignItems: 'center',
      borderRadius: radius.md,
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    optionRowSelected: {
      backgroundColor: c.accentSoft,
    },
    optionTextContainer: {
      flex: 1,
      marginRight: spacing.sm,
    },
    optionLabel: {
      color: c.textPrimary,
      fontSize: typography.body,
      fontWeight: '600',
    },
    optionLabelSelected: {
      color: c.primary,
      fontWeight: '700',
    },
    optionSubLabel: {
      color: c.textSecondary,
      fontSize: typography.caption,
      marginTop: 2,
    },
    emptyContainer: {
      alignItems: 'center',
      paddingVertical: spacing.xl,
    },
    emptyText: {
      color: c.textMuted,
      fontSize: typography.body,
    },
    dot: {
      height: 10,
      width: 10,
      borderRadius: 5,
    },
  });
