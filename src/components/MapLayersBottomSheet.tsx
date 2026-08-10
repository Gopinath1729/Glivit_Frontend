import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, type ThemeColors } from '@/src/theme/tokens';
import {
  saveMapPreferences,
  type MapDetailOptions,
  type MapPreferences,
  type MapTypeOption,
} from '../services/mapPreferencesStorage';

type MapLayersBottomSheetProps = {
  visible: boolean;
  onClose: () => void;
  preferences: MapPreferences;
  onChangePreferences: (prefs: MapPreferences) => void;
};

type CardItemDef = {
  id: 'standard' | 'satellite' | 'terrain' | 'traffic';
  label: string;
  isMapType: boolean;
};

const CARD_ITEMS: CardItemDef[] = [
  { id: 'standard', label: 'Default', isMapType: true },
  { id: 'satellite', label: 'Satellite', isMapType: true },
  { id: 'terrain', label: 'Terrain', isMapType: true },
  { id: 'traffic', label: 'Traffic', isMapType: false },
];

const MAP_PREVIEW_IMAGES: Record<string, any> = {
  standard: require('@/assets/images/map_preview_default.png'),
  satellite: require('@/assets/images/map_preview_satellite.png'),
  terrain: require('@/assets/images/map_preview_terrain.png'),
  traffic: require('@/assets/images/map_preview_traffic.png'),
};

export function MapLayersBottomSheet({
  visible,
  onClose,
  preferences,
  onChangePreferences,
}: MapLayersBottomSheetProps) {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);

  const [loadingType, setLoadingType] = useState<MapTypeOption | null>(null);

  const selectMapType = (type: MapTypeOption) => {
    if (type === preferences.mapType) return;
    setLoadingType(type);

    // Simulate loading delay to allow map to process the layer switch
    // and prevent flickering.
    setTimeout(() => {
      const updated: MapPreferences = {
        ...preferences,
        mapType: type,
      };
      onChangePreferences(updated);
      void saveMapPreferences(updated);
      setLoadingType(null);
      setTimeout(onClose, 250);
    }, 700);
  };

  const toggleDetail = (key: keyof MapDetailOptions) => {
    const updated: MapPreferences = {
      ...preferences,
      details: {
        ...preferences.details,
        [key]: !preferences.details[key],
      },
    };
    onChangePreferences(updated);
    void saveMapPreferences(updated);
    onClose();
  };

  return (
    <Modal
      animationType="slide"
      hardwareAccelerated
      onRequestClose={onClose}
      transparent
      visible={visible}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom + 12, 20) }]}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.headerTitle}>Map type</Text>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.closeButton}>
              <MaterialCommunityIcons color={c.textSecondary} name="close" size={20} />
            </Pressable>
          </View>

          <View style={styles.gridContainer}>
            {CARD_ITEMS.map((item) => {
              const active = item.isMapType
                ? preferences.mapType === item.id
                : Boolean(preferences.details.traffic);
              const isLoading = item.isMapType && loadingType === item.id;
              
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  disabled={loadingType !== null}
                  onPress={() => {
                    if (item.isMapType) {
                      selectMapType(item.id as MapTypeOption);
                    } else {
                      toggleDetail('traffic');
                    }
                  }}
                  style={styles.cardItem}>
                  <View style={[styles.cardPreview, active && styles.cardPreviewActive]}>
                    <Image
                      contentFit="cover"
                      source={MAP_PREVIEW_IMAGES[item.id]}
                      style={styles.previewImage}
                    />
                    {isLoading ? (
                      <View style={styles.checkBadge}>
                        <ActivityIndicator color={c.onPrimary} size="small" style={{ padding: 2 }} />
                      </View>
                    ) : active ? (
                      <View style={styles.checkBadge}>
                        <MaterialCommunityIcons color={c.primaryGreen} name="check-circle" size={18} />
                      </View>
                    ) : null}
                  </View>
                  <Text style={[styles.cardLabel, active && styles.cardLabelActive]}>
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.xs,
    },
    handle: {
      alignSelf: 'center',
      backgroundColor: c.borderStrong,
      borderRadius: 3,
      height: 4,
      marginBottom: spacing.xs,
      marginTop: spacing.xs,
      width: 36,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: spacing.sm,
      paddingVertical: spacing.xs,
    },
    headerTitle: {
      color: c.textPrimary,
      fontSize: 18,
      fontWeight: '700',
    },
    closeButton: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      height: 32,
      justifyContent: 'center',
      width: 32,
    },
    gridContainer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.md,
      justifyContent: 'space-between',
      marginTop: spacing.xs,
    },
    cardItem: {
      width: '47.5%',
    },
    cardPreview: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: 16,
      borderWidth: 2,
      height: 84,
      justifyContent: 'center',
      overflow: 'hidden',
      position: 'relative',
      width: '100%',
    },
    cardPreviewActive: {
      borderColor: c.primaryGreen,
      borderWidth: 2,
    },
    previewImage: {
      ...StyleSheet.absoluteFillObject,
    },
    checkBadge: {
      backgroundColor: c.pageBackground,
      borderRadius: 10,
      position: 'absolute',
      right: 6,
      top: 6,
    },
    cardLabel: {
      color: c.textSecondary,
      fontSize: 13,
      fontWeight: '600',
      marginTop: 6,
      textAlign: 'center',
    },
    cardLabelActive: {
      color: c.primaryGreen,
      fontWeight: '700',
    },
  });
