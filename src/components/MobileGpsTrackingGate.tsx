import React from 'react';
import { Alert, AppState, Linking, Platform } from 'react-native';

import {
  useBootstrapMobileGpsQuery,
  type MobileGpsSession,
} from '@/src/services/devicesApi';
import {
  clearMobileGpsReadiness,
  setMobileGpsReadiness,
} from '@/src/services/mobileGpsStatus';
import {
  checkTrackingReadiness,
  isTrackingSession,
  requestTrackingPermission,
  startTracking,
  stopTracking,
  type TrackingReadiness,
} from '@/src/services/phoneTracker';

/**
 * Authenticated, UI-less Mobile GPS coordinator.
 *
 * The registration API is the hard gate. When it reports no owned tracker this
 * component does not call hasServicesEnabledAsync, inspect/request permission,
 * or open settings. This keeps ordinary fleet users completely outside the
 * phone-location flow.
 */
export function MobileGpsTrackingGate() {
  const sessionQuery = useBootstrapMobileGpsQuery(undefined, {
    refetchOnMountOrArgChange: true,
  });
  const { data: session, refetch } = sessionQuery;
  const sessionRef = React.useRef<MobileGpsSession | undefined>(session);
  const startingRef = React.useRef(false);
  const permissionRequestedForRef = React.useRef<number | null>(null);
  const shownPromptRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const showPrompt = React.useCallback(
    (readiness: Exclude<TrackingReadiness, { granted: true }>, deviceId: number) => {
      const promptKey = `${deviceId}:${readiness.reason}`;
      if (shownPromptRef.current === promptKey) return;
      shownPromptRef.current = promptKey;

      if (readiness.reason === 'services_disabled') {
        Alert.alert(
          'GPS is turned off',
          'Location is turned off. Please enable GPS to continue tracking.',
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Enable GPS',
              onPress: () => {
                void openLocationSettings();
              },
            },
          ]
        );
        return;
      }

      Alert.alert('Location permission required', readiness.message, [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Open Settings',
          onPress: () => {
            void Linking.openSettings().catch(() => undefined);
          },
        },
      ]);
    },
    []
  );

  const synchronize = React.useCallback(
    async (session: MobileGpsSession | undefined, allowPermissionRequest: boolean) => {
      if (!session) return;

      // This branch intentionally contains no Location API call.
      if (!session.registered || !session.deviceId || !session.ingestToken) {
        permissionRequestedForRef.current = null;
        shownPromptRef.current = null;
        clearMobileGpsReadiness();
        await stopTracking();
        return;
      }
      // Publishing readiness has to happen even when tracking is already
      // running, so switching location off mid-session is reflected on every
      // screen rather than only on the next start attempt.
      const publish = (readiness: TrackingReadiness) =>
        setMobileGpsReadiness({
          deviceId: session.deviceId,
          locationDisabled: !readiness.granted,
        });

      if (startingRef.current) return;
      if (isTrackingSession(session.ingestToken)) {
        publish(await checkTrackingReadiness().catch(() => ({ granted: true }) as TrackingReadiness));
        return;
      }

      startingRef.current = true;
      try {
        let readiness = await checkTrackingReadiness();
        publish(readiness);
        if (
          !readiness.granted &&
          readiness.reason === 'permission_undetermined' &&
          allowPermissionRequest &&
          permissionRequestedForRef.current !== session.deviceId
        ) {
          permissionRequestedForRef.current = session.deviceId;
          readiness = await requestTrackingPermission();
          publish(readiness);
        }

        if (!readiness.granted) {
          showPrompt(readiness, session.deviceId);
          return;
        }

        shownPromptRef.current = null;
        await startTracking({
          accuracy: 'high',
          ingestToken: session.ingestToken,
          onStats: () => undefined,
        });
      } catch {
        // A provider can be switched off between the readiness check and the
        // first fix. Re-read its state and surface the same explicit flow.
        const latest = await checkTrackingReadiness().catch(() => null);
        if (latest) publish(latest);
        if (latest && !latest.granted) showPrompt(latest, session.deviceId);
      } finally {
        startingRef.current = false;
      }
    },
    [showPrompt]
  );

  React.useEffect(() => {
    void synchronize(session, true);
  }, [session, synchronize]);

  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      // Refresh ownership/status first. Once the response arrives the normal
      // effect re-runs; synchronizing the last known session here also makes
      // returning from Android/iOS settings feel immediate.
      void refetch();
      void synchronize(sessionRef.current, true);
    });
    return () => subscription.remove();
  }, [refetch, synchronize]);

  React.useEffect(
    () => () => {
      clearMobileGpsReadiness();
      void stopTracking();
    },
    []
  );

  return null;
}

async function openLocationSettings(): Promise<void> {
  if (Platform.OS === 'android') {
    try {
      await Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS');
      return;
    } catch {
      // Some Android vendors do not expose the standard intent.
    }
  }

  // iOS does not provide an App-Store-safe deep link to the global Location
  // Services page. The app settings screen is the supported equivalent and
  // also lets the user repair a denied app-level location permission.
  await Linking.openSettings().catch(() => undefined);
}
