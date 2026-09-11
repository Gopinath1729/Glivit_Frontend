import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlivtLogo } from '@/src/components/GlivtLogo';
import { KeyboardAwareForm } from '@/src/components/ui/KeyboardAwareForm';
import { radius, spacing } from '@/src/theme/tokens';

/**
 * The palette every signed-out screen is drawn in.
 *
 * <p>Fixed, not theme-derived, and deliberately so. Before signing in there is
 * no user and therefore no stored theme preference, so a themed auth screen
 * flipped between two completely different designs depending on a setting from
 * whoever used the device last - and the dark variant put white text on a navy
 * field that no longer matched anything else in the product. One light identity
 * means the door to the app always looks the same.
 */
const AUTH = {
  accent: '#1267E8',
  accentSoft: '#E8F1FE',
  border: '#DDE6F3',
  card: '#FFFFFF',
  fieldBackground: '#F5F8FD',
  ink: '#0B1F3A',
  inkMuted: '#7286A3',
  inkSoft: '#41597B',
  page: '#F3F7FC',
} as const;

export { AUTH as authPalette };

type AuthScreenShellProps = {
  children: React.ReactNode;
  /** Small caps line above the title. */
  eyebrow?: string;
  /** Rendered under the card, for links and secondary actions. */
  footer?: React.ReactNode;
  /** Shown as a soft red strip above the card. */
  notice?: string | null;
  subtitle: string;
  title: string;
};

/**
 * Shared frame for sign-in, company code, activation and password reset.
 *
 * <p>Depth here is four static layers - a page wash, two soft colour blooms and
 * a white card - none of which animate. The screen mounts while the app is
 * still restoring a session and resolving a tenant, so anything that ticks
 * would be competing with work the user is actually waiting on.
 */
export function AuthScreenShell({
  children,
  eyebrow,
  footer,
  notice,
  subtitle,
  title,
}: AuthScreenShellProps) {
  const { height } = useWindowDimensions();
  const compact = height < 750;
  const styles = React.useMemo(() => makeStyles(compact), [compact]);

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['#EAF2FE', AUTH.page, '#FBFCFE']}
        end={{ x: 1, y: 1 }}
        locations={[0, 0.52, 1]}
        start={{ x: 0, y: 0 }}
        style={StyleSheet.absoluteFillObject}
      />
      <View pointerEvents="none" style={styles.bloomTop} />
      <View pointerEvents="none" style={styles.bloomBottom} />

      <KeyboardAwareForm
        applyBottomInset={false}
        contentContainerStyle={styles.grow}
        style={styles.flex}>
        <SafeAreaView edges={['top', 'bottom']} style={styles.flex}>
          <View style={styles.content}>
            <View style={styles.brand}>
              <GlivtLogo size={compact ? 30 : 36} />
            </View>

            {notice ? (
              <View style={styles.notice}>
                <MaterialCommunityIcons color="#B42318" name="alert-circle-outline" size={17} />
                <Text style={styles.noticeText}>{notice}</Text>
              </View>
            ) : null}

            <View style={styles.card}>
              {/* A hairline of brand colour along the card's top edge: enough to
                  make the surface feel intentional without a coloured band. */}
              <LinearGradient
                colors={['#2B7CF3', '#1267E8', '#0B4FC0']}
                end={{ x: 1, y: 0 }}
                start={{ x: 0, y: 0 }}
                style={styles.cardEdge}
              />
              <View style={styles.cardBody}>
                <View style={styles.heading}>
                  {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
                  <Text style={styles.title}>{title}</Text>
                  <Text style={styles.subtitle}>{subtitle}</Text>
                </View>
                {children}
              </View>
            </View>

            {footer ? <View style={styles.footer}>{footer}</View> : null}
          </View>
        </SafeAreaView>
      </KeyboardAwareForm>
    </View>
  );
}

const makeStyles = (compact: boolean) =>
  StyleSheet.create({
    root: { backgroundColor: AUTH.page, flex: 1 },
    flex: { flex: 1 },
    // Fills the viewport while there is room, and only scrolls once the
    // keyboard takes that room away.
    grow: { flexGrow: 1 },
    bloomTop: {
      backgroundColor: 'rgba(66, 133, 244, 0.15)',
      borderRadius: 260,
      height: 340,
      position: 'absolute',
      right: -110,
      top: -150,
      width: 340,
    },
    bloomBottom: {
      backgroundColor: 'rgba(8, 191, 116, 0.10)',
      borderRadius: 220,
      bottom: -160,
      height: 300,
      left: -120,
      position: 'absolute',
      width: 300,
    },
    content: {
      flex: 1,
      gap: compact ? spacing.md : spacing.lg,
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.lg,
    },
    brand: { alignItems: 'center' },
    notice: {
      alignItems: 'center',
      backgroundColor: '#FEF3F2',
      borderColor: '#FDA29B',
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    noticeText: { color: '#B42318', flex: 1, fontSize: 12.5, lineHeight: 18 },
    card: {
      backgroundColor: AUTH.card,
      borderColor: AUTH.border,
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth * 2,
      elevation: 6,
      overflow: 'hidden',
      shadowColor: '#0B1F3A',
      shadowOffset: { width: 0, height: 14 },
      shadowOpacity: Platform.OS === 'ios' ? 0.1 : 0.16,
      shadowRadius: 26,
    },
    cardEdge: { height: 3, width: '100%' },
    cardBody: { gap: spacing.md, padding: compact ? spacing.md : spacing.lg },
    heading: { gap: 4 },
    eyebrow: {
      color: AUTH.accent,
      fontSize: 10,
      fontWeight: '900',
      letterSpacing: 1.2,
    },
    title: {
      color: AUTH.ink,
      fontSize: compact ? 22 : 25,
      fontWeight: '900',
      letterSpacing: -0.6,
    },
    subtitle: { color: AUTH.inkSoft, fontSize: 13, lineHeight: 19 },
    footer: { alignItems: 'center', gap: spacing.sm },
  });
