import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useEffect } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import type { GeofenceAlert } from '@/src/services/useGeofenceMonitor';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography } from '@/src/theme/tokens';

type Props = {
  alerts: GeofenceAlert[];
  onDismiss: (id: string) => void;
  topOffset?: number;
};

export function GeofenceAlertBanner({ alerts, onDismiss, topOffset = 70 }: Props) {
  const { colors: c } = useTheme();

  if (!Array.isArray(alerts) || alerts.length === 0) return null;

  return (
    <View pointerEvents="box-none" style={[styles.container, { top: topOffset }]}>
      {alerts.map((alert) => (
        <SingleAlertBanner key={alert.id} alert={alert} colors={c} onDismiss={onDismiss} />
      ))}
    </View>
  );
}

function SingleAlertBanner({
  alert,
  colors: c,
  onDismiss,
}: {
  alert: GeofenceAlert;
  colors: any;
  onDismiss: (id: string) => void;
}) {
  const translateY = React.useRef(new Animated.Value(-60)).current;
  const opacity = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: 350,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 350,
        useNativeDriver: true,
      }),
    ]).start();

    // Auto-dismiss after 6 seconds
    const timer = setTimeout(() => {
      handleDismiss();
    }, 6000);

    return () => clearTimeout(timer);
  }, []);

  const handleDismiss = () => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: -40,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onDismiss(alert.id);
    });
  };

  const isEntry = alert.type === 'ENTRY';
  const accentColor = isEntry ? '#16A34A' : '#E11D48';
  const bgColor = isEntry ? 'rgba(22, 163, 74, 0.95)' : 'rgba(225, 29, 72, 0.95)';

  return (
    <Animated.View
      style={[
        styles.card,
        { backgroundColor: bgColor, borderColor: accentColor },
        { transform: [{ translateY }], opacity },
      ]}>
      <View style={styles.iconWrap}>
        <MaterialCommunityIcons
          color="#FFFFFF"
          name={isEntry ? 'shield-check-outline' : 'shield-alert-outline'}
          size={24}
        />
      </View>
      <View style={styles.content}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={styles.titleText}>
            {alert.title}
          </Text>
          <Text style={styles.timeText}>{alert.timestamp}</Text>
        </View>
        <Text numberOfLines={2} style={styles.messageText}>
          {alert.message}
        </Text>
      </View>
      <Pressable hitSlop={8} onPress={handleDismiss} style={styles.closeButton}>
        <MaterialCommunityIcons color="#FFFFFF" name="close" size={18} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    left: spacing.md,
    position: 'absolute',
    right: spacing.md,
    zIndex: 9999,
    gap: spacing.xs,
  },
  card: {
    borderRadius: radius.md,
    borderWidth: 1.5,
    elevation: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
  },
  iconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  content: {
    flex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  titleText: {
    color: '#FFFFFF',
    fontSize: typography.caption,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  timeText: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 10,
    fontWeight: '700',
  },
  messageText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
    lineHeight: 16,
  },
  closeButton: {
    padding: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
});
