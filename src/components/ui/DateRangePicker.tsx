import React, { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';

import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import { Button } from './Button';

export type DateRange = {
  label: string;
  startDate: Date;
  endDate: Date;
};

interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
}

const getPresets = (): DateRange[] => {
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  
  const todayStart = new Date(today);
  todayStart.setHours(0, 0, 0, 0);

  const yesterdayEnd = new Date(todayStart.getTime() - 1);
  const yesterdayStart = new Date(yesterdayEnd);
  yesterdayStart.setHours(0, 0, 0, 0);

  const last7Start = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
  last7Start.setHours(0, 0, 0, 0);

  const last30Start = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000);
  last30Start.setHours(0, 0, 0, 0);

  return [
    { label: 'Today', startDate: todayStart, endDate: today },
    { label: 'Yesterday', startDate: yesterdayStart, endDate: yesterdayEnd },
    { label: 'Last 7 Days', startDate: last7Start, endDate: today },
    { label: 'Last 30 Days', startDate: last30Start, endDate: today },
  ];
};

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const presets = useMemo(getPresets, []);

  const [modalVisible, setModalVisible] = useState(false);
  const [customStart, setCustomStart] = useState(value.startDate);
  const [customEnd, setCustomEnd] = useState(value.endDate);
  
  const [showPickerFor, setShowPickerFor] = useState<'start' | 'end' | null>(null);

  const applyPreset = (preset: DateRange) => {
    onChange(preset);
  };

  const openCustomModal = () => {
    setCustomStart(value.startDate);
    setCustomEnd(value.endDate);
    setModalVisible(true);
  };

  const applyCustom = () => {
    onChange({ label: 'Custom Range', startDate: customStart, endDate: customEnd });
    setModalVisible(false);
  };

  const formatDate = (date: Date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Timeline Range</Text>
      <View style={styles.chipsRow}>
        {presets.map(p => {
          const isActive = value.label === p.label;
          return (
            <Pressable 
              key={p.label} 
              onPress={() => applyPreset(p)}
              style={[styles.chip, isActive && styles.chipActive]}
            >
              <Text style={[styles.chipText, isActive && styles.chipTextActive]}>{p.label}</Text>
            </Pressable>
          );
        })}
        <Pressable 
          onPress={openCustomModal}
          style={[styles.chip, value.label === 'Custom Range' && styles.chipActive]}
        >
          <Text style={[styles.chipText, value.label === 'Custom Range' && styles.chipTextActive]}>Custom Range</Text>
        </Pressable>
      </View>

      <View style={styles.dateDisplay}>
        <Text style={styles.dateDisplayText}>
          {formatDate(value.startDate)} - {formatDate(value.endDate)}
        </Text>
      </View>

      <Modal transparent statusBarTranslucent animationType="fade" visible={modalVisible} onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setModalVisible(false)} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Custom Date Range</Text>
            
            <View style={styles.datePickerRow}>
              <View style={styles.datePickerSection}>
                <Text style={styles.pickerLabel}>Start Date</Text>
                <Pressable onPress={() => setShowPickerFor('start')} style={styles.dateBtn}>
                  <Text style={styles.dateBtnText}>{formatDate(customStart)}</Text>
                </Pressable>
              </View>
              <View style={styles.datePickerSection}>
                <Text style={styles.pickerLabel}>End Date</Text>
                <Pressable onPress={() => setShowPickerFor('end')} style={styles.dateBtn}>
                  <Text style={styles.dateBtnText}>{formatDate(customEnd)}</Text>
                </Pressable>
              </View>
            </View>

            {showPickerFor && (
              <DateTimePicker
                value={showPickerFor === 'start' ? customStart : customEnd}
                mode="date"
                display="default"
                maximumDate={showPickerFor === 'start' ? customEnd : new Date()}
                minimumDate={showPickerFor === 'end' ? customStart : undefined}
                onChange={(event, selectedDate) => {
                  setShowPickerFor(null);
                  if (selectedDate) {
                    if (showPickerFor === 'start') {
                      setCustomStart(selectedDate);
                    } else {
                      selectedDate.setHours(23, 59, 59, 999);
                      setCustomEnd(selectedDate);
                    }
                  }
                }}
              />
            )}

            <View style={styles.actions}>
              <Button label="Cancel" onPress={() => setModalVisible(false)} variant="secondary" style={{ flex: 1 }} />
              <Button label="Apply" onPress={applyCustom} style={styles.applyBtn} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: {
      gap: spacing.sm,
    },
    label: {
      fontSize: typography.body,
      fontWeight: '700',
      color: c.textPrimary,
    },
    chipsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
    },
    chip: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: c.accentSoft,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    chipActive: {
      backgroundColor: c.primaryGreen,
      borderColor: c.primaryGreen,
    },
    chipText: {
      fontSize: typography.caption,
      fontWeight: '600',
      color: c.primaryGreen,
    },
    chipTextActive: {
      color: c.white,
    },
    dateDisplay: {
      marginTop: spacing.xs,
    },
    dateDisplayText: {
      fontSize: typography.caption,
      color: c.textMuted,
      fontWeight: '600',
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: c.overlay,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.lg,
    },
    modalCard: {
      backgroundColor: c.surfaceElevated,
      borderRadius: radius.lg,
      padding: spacing.lg,
      width: '100%',
      maxWidth: 400,
    },
    modalTitle: {
      fontSize: typography.title,
      fontWeight: '800',
      color: c.textPrimary,
      marginBottom: spacing.lg,
    },
    datePickerRow: {
      flexDirection: 'row',
      gap: spacing.md,
      marginBottom: spacing.xl,
    },
    datePickerSection: {
      flex: 1,
      gap: spacing.xs,
    },
    pickerLabel: {
      fontSize: typography.caption,
      fontWeight: '600',
      color: c.textSecondary,
    },
    dateBtn: {
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
    },
    dateBtnText: {
      fontSize: typography.body,
      color: c.textPrimary,
      fontWeight: '600',
    },
    actions: {
      flexDirection: 'row',
      gap: spacing.md,
    },
    cancelBtn: {
      flex: 1,
      backgroundColor: c.surfaceAlt,
    },
    cancelBtnText: {
      color: c.textPrimary,
    },
    applyBtn: {
      flex: 1,
    },
  });
