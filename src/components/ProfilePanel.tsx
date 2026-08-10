import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as SecureStore from 'expo-secure-store';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Switch, Text, View, Platform } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLogoutMutation } from '@/src/services/authApi';
import { authStorage } from '@/src/services/authStorage';
import { baseApi } from '@/src/services/baseApi';
import { clearSession } from '@/src/store/authSlice';
import { useAppDispatch, useAppSelector } from '@/src/store/hooks';
import { clearActiveTenant } from '@/src/store/tenantSlice';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import { ColorPickerModal } from './ui/ColorPickerModal';
import { useGetProfileImageQuery } from '@/src/services/operationsApi';

const PROFILE_IMG_KEY = 'glivt.profile.imageUri';

interface ProfilePanelProps {
  visible: boolean;
  onClose: () => void;
}

export function ProfilePanel({ visible, onClose }: ProfilePanelProps) {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { colors: c, mode, setMode, colors, setPrimaryColor, autoFollowVehicle, setAutoFollowVehicle } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(c, insets, mode), [c, insets, mode]);
  const user = useAppSelector((s) => s.auth.user);
  
  const [logout] = useLogoutMutation();
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [profileUri, setProfileUri] = useState<string | null>(null);

  // Sync profile photo with database
  const { data: dbProfileImage } = useGetProfileImageQuery(undefined, { skip: !user?.id });

  // Load saved profile image on mount
  useEffect(() => {
    SecureStore.getItemAsync(PROFILE_IMG_KEY).then(uri => {
      if (uri) setProfileUri(uri);
    });
  }, []);

  // Sync db image to state
  useEffect(() => {
    if (dbProfileImage) {
      setProfileUri(dbProfileImage);
      SecureStore.setItemAsync(PROFILE_IMG_KEY, dbProfileImage).catch(() => {});
    }
  }, [dbProfileImage]);



  const onLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          try {
            await logout().unwrap();
          } catch {
            // Best-effort
          }
          dispatch(clearSession());
          dispatch(clearActiveTenant());
          dispatch(baseApi.util.resetApiState());
          await authStorage.clearSession().catch(() => undefined);
          onClose();
          router.replace('/login');
        },
      },
    ]);
  };

  if (!visible) return null;

  const displayName = user?.name ?? user?.username ?? 'Demo Admin';
  const roleLabel = user?.role === 'SUPER_ADMIN' ? 'Super Admin' : 'Member';
  const initials = displayName.substring(0, 2).toUpperCase();

  return (
    <>
      <Animated.View style={styles.backdrop} entering={FadeIn.duration(250)} exiting={FadeOut.duration(250)}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        
        <Animated.View style={styles.panel} entering={SlideInDown.duration(250)} exiting={SlideOutDown.duration(250)}>
          <Pressable style={styles.closeButton} onPress={onClose} hitSlop={8}>
            <MaterialCommunityIcons name="close" size={24} color={c.textSecondary} />
          </Pressable>

          <LinearGradient
            colors={[c.primaryGreen, c.darkGreen]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.header}
          >
            <View style={styles.avatarContainer}>
              {profileUri ? (
                <Image source={{ uri: profileUri }} style={styles.avatar} contentFit="cover" />
              ) : (
                <View style={styles.avatarPlaceholder}>
                  <Text style={styles.avatarInitials}>{initials}</Text>
                </View>
              )}
            </View>
            <Text style={styles.name}>{displayName}</Text>
            <Text style={styles.role}>{roleLabel} • ID: {user?.id ?? 'Unknown'}</Text>
          </LinearGradient>

          <View style={styles.menu}>
            {user?.role === 'SUPER_ADMIN' && (
              <Pressable style={styles.menuItem} onPress={() => { onClose(); router.push('/manage-tenants' as never); }}>
                <MaterialCommunityIcons name="office-building-cog" size={24} color={c.primaryGreen} />
                <Text style={styles.menuItemText}>Switch Tenant</Text>
              </Pressable>
            )}

            <View style={styles.menuItem}>
              <MaterialCommunityIcons name="theme-light-dark" size={24} color={c.primaryGreen} />
              <Text style={styles.menuItemText}>Dark Mode</Text>
              <Switch 
                value={mode === 'dark'} 
                onValueChange={(val) => setMode(val ? 'dark' : 'light')} 
                trackColor={{ true: c.primaryGreen, false: c.borderStrong }} 
                thumbColor={c.white}
              />
            </View>

            <Pressable style={styles.menuItem} onPress={() => { onClose(); router.push('/timeline' as never); }}>
              <MaterialCommunityIcons name="chart-timeline-variant" size={24} color={c.primaryGreen} />
              <Text style={styles.menuItemText}>Your Timeline</Text>
            </Pressable>

            <View style={styles.menuItem}>
              <MaterialCommunityIcons name="navigation-variant-outline" size={24} color={c.primaryGreen} />
              <Text style={styles.menuItemText}>Auto Follow Vehicle</Text>
              <Switch 
                value={autoFollowVehicle} 
                onValueChange={setAutoFollowVehicle} 
                trackColor={{ true: c.primaryGreen, false: c.borderStrong }} 
                thumbColor={c.white}
              />
            </View>

            <View style={styles.divider} />

            <Pressable 
              style={({ pressed }) => [styles.logoutButton, pressed && styles.logoutButtonPressed]} 
              onPress={onLogout}
            >
              <MaterialCommunityIcons name="logout" size={24} color="#DC2626" />
              <Text style={styles.logoutText}>Logout</Text>
            </Pressable>
          </View>
        </Animated.View>
      </Animated.View>

      <ColorPickerModal 
        visible={showColorPicker} 
        onClose={() => setShowColorPicker(false)} 
        color={colors.primary} 
        onColorChange={setPrimaryColor} 
      />

    </>
  );
}

const makeStyles = (c: ThemeColors, insets: any, mode: string) =>
  StyleSheet.create({
    backdrop: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
      justifyContent: 'flex-end',
      zIndex: 9999,
    },
    closeButton: {
      position: 'absolute',
      top: spacing.md,
      right: spacing.md,
      zIndex: 10,
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    panel: {
      backgroundColor: mode === 'dark' ? c.surfaceElevated : '#F8FAFC',
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      paddingBottom: Math.max(insets.bottom, spacing.lg),
      elevation: 8,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.15,
      shadowRadius: 12,
      overflow: 'hidden',
    },
    header: {
      alignItems: 'center',
      paddingVertical: spacing.xl,
      borderBottomLeftRadius: radius.xl,
      borderBottomRightRadius: radius.xl,
      marginBottom: spacing.lg,
    },
    avatarContainer: {
      marginBottom: spacing.sm,
      position: 'relative',
    },
    avatar: {
      width: 80,
      height: 80,
      borderRadius: 40,
      borderWidth: 3,
      borderColor: c.white,
    },
    avatarPlaceholder: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: 'rgba(255, 255, 255, 0.2)',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: c.white,
    },
    avatarInitials: {
      color: c.white,
      fontSize: 28,
      fontWeight: '800',
    },

    name: {
      fontSize: typography.h2,
      fontWeight: '800',
      color: c.white,
    },
    role: {
      fontSize: typography.caption,
      color: 'rgba(255, 255, 255, 0.9)',
      marginTop: 2,
    },
    menu: {
      paddingHorizontal: spacing.lg,
    },
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      backgroundColor: c.surface,
      borderRadius: radius.md,
      marginBottom: spacing.sm,
      gap: spacing.md,
      elevation: 1,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 2,
    },
    menuItemText: {
      flex: 1,
      fontSize: typography.body,
      fontWeight: '700',
      color: c.textPrimary,
    },
    divider: {
      height: 0,
      marginVertical: spacing.xs,
    },
    logoutButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: spacing.md,
      borderRadius: radius.md,
      borderWidth: 2,
      borderColor: '#DC2626',
      backgroundColor: '#FFFFFF',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    logoutButtonPressed: {
      backgroundColor: '#FEF2F2',
    },
    logoutText: {
      fontSize: typography.body,
      fontWeight: '800',
      color: '#DC2626',
    },
    colorPreview: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
  });
