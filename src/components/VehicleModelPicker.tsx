import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  type CarVariant,
  getVehicleModel,
  VEHICLE_MODELS,
  type VehicleModelCategory,
  getModelCategory,
} from './Vehicle3DMarker';

type Props = {
  value: CarVariant;
  onChange: (value: CarVariant) => void;
  compact?: boolean;
  errorMessage?: string | null;
  loading?: boolean;
  category?: string | null;
};

const CATEGORY_ICONS: Record<
  VehicleModelCategory,
  React.ComponentProps<typeof MaterialCommunityIcons>['name']
> = {
  car: 'car-sports',
  bike: 'motorbike',
  truck: 'truck',
};

export function VehicleModelPicker({
  value,
  onChange,
  compact = false,
  errorMessage,
  loading = false,
  category,
}: Props) {
  const selected = getVehicleModel(value);
  const cardWidth = compact ? COMPACT_CARD_WIDTH : CARD_WIDTH;

  const filterCategory = category ? getModelCategory(category) : null;
  const filteredModels = filterCategory
    ? VEHICLE_MODELS.filter((model) => model.category === filterCategory)
    : VEHICLE_MODELS;
  return (
    <View style={styles.root}>
      <View style={styles.labelRow}>
        <Text style={styles.eyebrow}>VEHICLE MODEL</Text>
        <View
          accessibilityLiveRegion="polite"
          style={styles.modelStatus}>
          {loading ? <ActivityIndicator color="#5DE2F4" size="small" /> : null}
          {errorMessage ? (
            <MaterialCommunityIcons color="#FF8B78" name="alert-circle-outline" size={13} />
          ) : null}
          {/* The label keeps naming the SELECTED model even when the 3D
              renderer is unavailable — the previous "2D fallback" text replaced
              the name entirely, so the picker looked like it had lost the
              user's choice. The renderer state is a suffix, not a replacement. */}
          <Text
            numberOfLines={1}
            style={[styles.selectedLabel, errorMessage && styles.selectedLabelError]}>
            {loading ? `Loading ${selected.label}` : selected.label}
            {errorMessage && !loading ? ' · 2D' : ''}
          </Text>
        </View>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        decelerationRate="fast"
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToAlignment="start"
        snapToInterval={cardWidth + CARD_GAP}>
        {filteredModels.map((model) => {
          const active = model.id === value;
          return (
            <Pressable
              accessibilityLabel={`Use ${model.label}`}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              key={model.id}
              onPress={() => onChange(model.id)}
              style={[
                styles.choice,
                { width: cardWidth },
                compact && styles.choiceCompact,
                active && styles.choiceActive,
              ]}>
              <View style={[styles.swatch, { backgroundColor: model.paintColor }]}>
                <MaterialCommunityIcons
                  color={isLightColor(model.paintColor) ? '#18212B' : '#FFFFFF'}
                  name={CATEGORY_ICONS[model.category]}
                  size={compact ? 14 : 16}
                />
              </View>
              {/* Two lines so long names ("Lamborghini Gallardo") are shown in
                  full rather than truncated inside a fixed-width card. */}
              <Text numberOfLines={2} style={[styles.choiceText, active && styles.choiceTextActive]}>
                {model.label}
              </Text>
              {active ? (
                <MaterialCommunityIcons color="#28D995" name="check-circle" size={13} />
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function isLightColor(color: string) {
  const hex = color.replace('#', '');
  if (hex.length !== 6) return false;
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 175;
}

// Cards are a fixed width so every label has a predictable amount of room and
// the row snaps card-to-card instead of stopping with one clipped in half.
const CARD_WIDTH = 148;
const COMPACT_CARD_WIDTH = 132;
const CARD_GAP = 8;

const styles = StyleSheet.create({
  root: { gap: 7, minWidth: 0 },
  labelRow: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 2 },
  eyebrow: { color: '#5DE2F4', fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  modelStatus: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 5,
    justifyContent: 'flex-end',
    minWidth: 0,
  },
  selectedLabel: { color: '#B9C9D7', flexShrink: 1, fontSize: 11, fontWeight: '700', textAlign: 'right' },
  selectedLabelError: { color: '#FFAA9D' },
  // The trailing pad lets the last card scroll clear of the container edge.
  content: { gap: CARD_GAP, paddingLeft: 2, paddingRight: 14 },
  choice: {
    alignItems: 'center',
    backgroundColor: 'rgba(11, 18, 28, 0.88)',
    borderColor: 'rgba(255,255,255,0.13)',
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    minHeight: 46,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  choiceCompact: { minHeight: 42, paddingHorizontal: 8, paddingVertical: 6 },
  choiceActive: {
    backgroundColor: 'rgba(25, 208, 134, 0.14)',
    borderColor: '#28D995',
  },
  swatch: {
    alignItems: 'center',
    borderColor: 'rgba(255,255,255,0.28)',
    borderRadius: 8,
    borderWidth: 1,
    height: 25,
    justifyContent: 'center',
    width: 29,
  },
  choiceText: {
    color: '#AAB9C7',
    flex: 1,
    fontSize: 11,
    fontWeight: '800',
    lineHeight: 14,
    minWidth: 0,
  },
  choiceTextActive: { color: '#F3FBF8' },
});
