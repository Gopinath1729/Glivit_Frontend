import React, { useMemo } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, ScrollView } from 'react-native';
import ColorPicker, {
  Panel2,
  HueSlider,
  SaturationSlider,
  BrightnessSlider,
  RedSlider,
  GreenSlider,
  BlueSlider,
  InputWidget,
  Preview,
} from 'reanimated-color-picker';

import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import { Button } from './Button';

interface ColorPickerModalProps {
  visible: boolean;
  onClose: () => void;
  color: string;
  onColorChange: (color: string) => void;
}

export function ColorPickerModal({ visible, onClose, color, onColorChange }: ColorPickerModalProps) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [tempColor, setTempColor] = React.useState(color || '#0F9D58');

  // Reset temp color when opened
  React.useEffect(() => {
    if (visible) {
      setTempColor(color || '#0F9D58');
    }
  }, [visible, color]);

  const handleSelect = (result: { hex: string }) => {
    setTempColor(result.hex);
  };

  const handleSave = () => {
    onColorChange(tempColor);
    onClose();
  };

  const handleReset = () => {
    onColorChange(''); // empty string clears override
    onClose();
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={visible}>
      <View style={styles.backdrop}>
        <Pressable onPress={onClose} style={StyleSheet.absoluteFill} />
        <View style={styles.card}>
          <Text style={styles.title}>Customize Accent Color</Text>
          <Text style={styles.subtitle}>Select any custom accent color for your interface</Text>
          
          <ScrollView showsVerticalScrollIndicator={false} style={styles.scroll}>
            <ColorPicker
              style={styles.pickerContainer}
              value={tempColor}
              onComplete={handleSelect}
            >
              {/* Color Wheel */}
              <View style={styles.wheelContainer}>
                <Panel2 style={styles.wheel} />
              </View>

              {/* Live Preview & Hex Input */}
              <View style={styles.previewRow}>
                <Preview style={styles.preview} hideText />
                <View style={styles.hexInputContainer}>
                  <InputWidget inputStyle={styles.hexInput} />
                </View>
              </View>

              {/* HSV Sliders */}
              <Text style={styles.sectionTitle}>HSV Customization</Text>
              <View style={styles.sliderGroup}>
                <Text style={styles.sliderLabel}>Hue</Text>
                <HueSlider style={styles.slider} />
                <Text style={styles.sliderLabel}>Saturation</Text>
                <SaturationSlider style={styles.slider} />
                <Text style={styles.sliderLabel}>Brightness</Text>
                <BrightnessSlider style={styles.slider} />
              </View>

              {/* RGB Sliders */}
              <Text style={styles.sectionTitle}>RGB Customization</Text>
              <View style={styles.sliderGroup}>
                <Text style={styles.sliderLabel}>Red</Text>
                <RedSlider style={styles.slider} />
                <Text style={styles.sliderLabel}>Green</Text>
                <GreenSlider style={styles.slider} />
                <Text style={styles.sliderLabel}>Blue</Text>
                <BlueSlider style={styles.slider} />
              </View>
            </ColorPicker>
          </ScrollView>

          <View style={styles.actions}>
            <Button
              label="Reset"
              onPress={handleReset}
              style={StyleSheet.flatten([styles.button, styles.resetButton])}
              textColor={c.textPrimary}
            />
            <Button
              label="Apply"
              onPress={handleSave}
              style={styles.button}
            />
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
      backgroundColor: c.overlay,
      flex: 1,
      justifyContent: 'center',
      padding: spacing.md,
    },
    card: {
      backgroundColor: c.surfaceElevated,
      borderRadius: radius.xl,
      elevation: 6,
      padding: spacing.lg,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 12,
      width: '100%',
      maxWidth: 400,
      maxHeight: SCREEN_HEIGHT * 0.85,
    },
    title: {
      color: c.textPrimary,
      fontSize: typography.title,
      fontWeight: '800',
      marginBottom: spacing.xs,
    },
    subtitle: {
      color: c.textSecondary,
      fontSize: typography.caption,
      marginBottom: spacing.md,
    },
    scroll: {
      flexGrow: 0,
      marginBottom: spacing.md,
    },
    pickerContainer: {
      width: '100%',
      gap: spacing.sm,
    },
    wheelContainer: {
      height: 180,
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      marginVertical: spacing.xs,
    },
    wheel: {
      width: 170,
      height: 170,
    },
    previewRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      marginVertical: spacing.xs,
      paddingHorizontal: spacing.xs,
    },
    preview: {
      width: 50,
      height: 36,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
    },
    hexInputContainer: {
      flex: 1,
      height: 36,
    },
    hexInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: radius.sm,
      color: c.textPrimary,
      paddingHorizontal: spacing.sm,
      fontSize: 14,
      fontWeight: '700',
      backgroundColor: c.surface,
      textAlign: 'center',
    },
    sectionTitle: {
      color: c.textPrimary,
      fontSize: 13,
      fontWeight: '800',
      marginTop: spacing.md,
      marginBottom: spacing.xs,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    sliderGroup: {
      gap: spacing.xs,
      backgroundColor: c.surfaceAlt,
      padding: spacing.md,
      borderRadius: radius.md,
    },
    sliderLabel: {
      color: c.textSecondary,
      fontSize: 11,
      fontWeight: '700',
    },
    slider: {
      height: 18,
      borderRadius: 9,
      marginBottom: spacing.xs,
    },
    actions: {
      flexDirection: 'row',
      gap: spacing.md,
      marginTop: spacing.md,
    },
    button: {
      flex: 1,
    },
    resetButton: {
      backgroundColor: c.surfaceAlt,
    },
    resetButtonText: {
      color: c.textPrimary,
    },
  });

import { Dimensions } from 'react-native';
const { height: SCREEN_HEIGHT } = Dimensions.get('window');

