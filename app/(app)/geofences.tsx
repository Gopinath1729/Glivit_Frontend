import { zodResolver } from '@hookform/resolvers/zod';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import React from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { z } from 'zod';

import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { TextField } from '@/src/components/ui/TextField';
import { apiErrorMessage } from '@/src/services/apiError';
import { GeofencePickerMap } from '@/src/components/maps/GeofencePickerMap';
import { KeyboardAwareForm } from '@/src/components/ui/KeyboardAwareForm';
import { useGetAllDevicesQuery } from '@/src/services/devicesApi';
import { getMapStyleInfo } from '@/src/services/mapStyle';
import {
  useCreateGeofenceMutation,
  useDeleteGeofenceMutation,
  useGetGeofencesQuery,
  useUpdateGeofenceMutation,
} from '@/src/services/operationsApi';
import {
  useGetGeofenceSuggestionsQuery,
  useApproveGeofenceSuggestionMutation,
  useDismissGeofenceSuggestionMutation,
} from '@/src/services/aiApi';
import { useTheme } from '@/src/theme/ThemeProvider';
import type { DeviceSummary, GeofenceDto } from '@/src/types/api';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Name is required')
    .max(100, 'Name must be 100 characters or fewer'),
  latitude: z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/, 'Invalid latitude')
    .refine((value) => Math.abs(Number(value)) <= 90, 'Latitude must be between -90 and 90'),
  longitude: z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/, 'Invalid longitude')
    .refine((value) => Math.abs(Number(value)) <= 180, 'Longitude must be between -180 and 180'),
  radiusMeters: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'Invalid radius')
    .refine((value) => Number(value) > 0 && Number(value) <= 100, 'Radius must be between 0.001 and 100 km'),
  assignedDeviceIds: z.array(z.number()),
});

type FormValues = z.infer<typeof schema>;

const DEFAULT_FORM: FormValues = {
  name: '',
  latitude: '12.9718',
  longitude: '77.5946',
  radiusMeters: '0.25',
  assignedDeviceIds: [],
};

const RADIUS_PRESETS = [0.1, 0.25, 0.5, 1, 5] as const;
const SEARCH_PLACES = [
  { name: 'Bengaluru Palace', latitude: 12.9985, longitude: 77.5921 },
  { name: 'MG Road, Bengaluru', latitude: 12.9756, longitude: 77.6068 },
  { name: 'Koramangala, Bengaluru', latitude: 12.9352, longitude: 77.6245 },
  { name: 'Indiranagar, Bengaluru', latitude: 12.9784, longitude: 77.6408 },
  { name: 'Whitefield Tech Park, Bengaluru', latitude: 12.9698, longitude: 77.7499 },
  { name: 'Electronic City, Bengaluru', latitude: 12.8452, longitude: 77.6602 },
  { name: 'Manyata Tech Park, Bengaluru', latitude: 13.0500, longitude: 77.6200 },
  { name: 'Kempegowda International Airport', latitude: 13.1986, longitude: 77.7066 },
  { name: 'HSR Layout, Bengaluru', latitude: 12.9081, longitude: 77.6476 },
  { name: 'Malleshwaram, Bengaluru', latitude: 12.9986, longitude: 77.5966 },
  { name: 'T Nagar, Chennai', latitude: 13.0418, longitude: 80.2341 },
  { name: 'Guindy Industrial Estate, Chennai', latitude: 13.0067, longitude: 80.2020 },
  { name: 'BKC, Mumbai', latitude: 19.0657, longitude: 72.8686 },
  { name: 'Cyber City, Gurugram', latitude: 28.4950, longitude: 77.0895 },
  { name: 'HITEC City, Hyderabad', latitude: 17.4435, longitude: 78.3772 },
] as const;

type Coordinate = {
  latitude: number;
  longitude: number;
};

/**
 * Geofences.
 *
 * A list screen first: every existing zone is shown with its location, radius,
 * assignment counts, status and row actions. The create/edit form is a sheet
 * that only opens from the "+ Add Geofence" action, so the list is not buried
 * under a form the way it used to be. AI suggestions, colours, validation rules,
 * permissions and the underlying API calls are unchanged.
 */
export default function GeofencesScreen() {
  const { colors: c, isDark } = useTheme();
  // Same style source as the live map, so the picker matches the app theme.
  const pickerStyleUrl = React.useMemo(
    () => getMapStyleInfo(isDark ? 'dark' : 'street').webStyleUrl,
    [isDark]
  );
  // Drawer navigator already applies the top safe-area inset to the header, so
  // only the bottom inset (Android nav/gesture bar, iPhone home indicator) needs
  // handling here — adding a top inset too would double-pad the screen.
  const insets = useSafeAreaInsets();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { data, isLoading, isFetching, isError, error, refetch } = useGetGeofencesQuery({ size: 50 });
  const { data: devicesData } = useGetAllDevicesQuery();
  const allDevices = React.useMemo(() => (Array.isArray(devicesData) ? devicesData : []), [devicesData]);
  const devicesMap = React.useMemo(() => new Map(allDevices.map((d) => [d.id, d])), [allDevices]);
  const {
    data: aiSuggestions,
    isLoading: aiLoading,
    isFetching: aiFetching,
    isError: isAiError,
    error: aiError,
    refetch: refetchAi,
  } = useGetGeofenceSuggestionsQuery();
  const [approveSuggestion] = useApproveGeofenceSuggestionMutation();
  const [dismissSuggestion] = useDismissGeofenceSuggestionMutation();
  const [createGeofence, { isLoading: isCreating }] = useCreateGeofenceMutation();
  const [updateGeofence, { isLoading: isUpdating }] = useUpdateGeofenceMutation();
  const [deleteGeofence] = useDeleteGeofenceMutation();
  const [approvingId, setApprovingId] = React.useState<number | null>(null);
  const [dismissingId, setDismissingId] = React.useState<number | null>(null);
  const [deletingId, setDeletingId] = React.useState<number | null>(null);
  /** `null` = closed, `'new'` = create, otherwise the geofence being edited. */
  const [editorTarget, setEditorTarget] = React.useState<'new' | GeofenceDto | null>(null);
  const [locationLoading, setLocationLoading] = React.useState(false);
  const [searchText, setSearchText] = React.useState('');
  const [selectedPlace, setSelectedPlace] = React.useState<{ name: string; latitude: number; longitude: number } | null>(null);
  const [onlineSuggestions, setOnlineSuggestions] = React.useState<{ name: string; latitude: number; longitude: number }[]>([]);
  const [isSearchingOnline, setIsSearchingOnline] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = React.useState(false);
  const reverseGeocodeRequestRef = React.useRef(0);
  const geofences = React.useMemo(() => (Array.isArray(data?.content) ? data.content : []), [data]);

  const {
    clearErrors,
    control,
    handleSubmit,
    reset,
    setError,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: DEFAULT_FORM,
  });
  const watchedLatitude = watch('latitude');
  const watchedLongitude = watch('longitude');
  const watchedRadius = watch('radiusMeters');
  const pickedCoordinate = React.useMemo<Coordinate>(() => {
    const latitude = Number(watchedLatitude);
    const longitude = Number(watchedLongitude);
    return {
      latitude: Number.isFinite(latitude) ? latitude : Number(DEFAULT_FORM.latitude),
      longitude: Number.isFinite(longitude) ? longitude : Number(DEFAULT_FORM.longitude),
    };
  }, [watchedLatitude, watchedLongitude]);
  const previewRadius = React.useMemo(() => {
    const value = Number(watchedRadius);
    return Number.isFinite(value) && value > 0 ? Math.min(value * 1000, 100_000) : Number(DEFAULT_FORM.radiusMeters) * 1000;
  }, [watchedRadius]);

  const reverseGeocodeCoordinate = React.useCallback(async (coordinate: Coordinate, requestId: number) => {
    let name = '';

    if (Platform.OS !== 'web') {
      try {
        const addresses = await Location.reverseGeocodeAsync(coordinate);
        name = formatExpoAddress(addresses[0]);
      } catch {
        // Native geocoding can be unavailable on some devices. Nominatim below
        // is the network fallback and uses the exact same coordinate.
      }
    }

    if (!name) {
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${coordinate.latitude}&lon=${coordinate.longitude}`,
          { headers: { 'User-Agent': 'GlivtTrackerApp/1.0' } }
        );
        const payload = response.ok ? await response.json() : null;
        name = formatNominatimAddress(payload);
      } catch {
        // Coordinates remain authoritative even if an address provider is down.
      }
    }

    if (requestId !== reverseGeocodeRequestRef.current) return;
    const resolvedName =
      name || `Current GPS (${coordinate.latitude.toFixed(5)}, ${coordinate.longitude.toFixed(5)})`;
    setSearchText(resolvedName);
    setSelectedPlace({
      name: resolvedName,
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
    });
  }, []);

  const setPickedCoordinate = React.useCallback(
    async (coordinate: Coordinate, animate = true, updateAddress = true) => {
      if (!isValidCoordinate(coordinate)) {
        throw new Error('The device returned an invalid GPS coordinate. Please try again.');
      }

      setValue('latitude', coordinate.latitude.toFixed(6), { shouldDirty: true, shouldValidate: true });
      setValue('longitude', coordinate.longitude.toFixed(6), { shouldDirty: true, shouldValidate: true });
      clearErrors(['latitude', 'longitude']);
      // No imperative camera move: GeofencePickerMap follows the coordinate it
      // is given, so writing the fields above is what recentres it.
      void animate;
      if (updateAddress) {
        const requestId = ++reverseGeocodeRequestRef.current;
        await reverseGeocodeCoordinate(coordinate, requestId);
      } else {
        // Invalidate an older GPS/address request so it cannot overwrite a
        // newly searched or manually selected point.
        reverseGeocodeRequestRef.current += 1;
      }
    },
    [clearErrors, reverseGeocodeCoordinate, setValue]
  );

  const openCreate = React.useCallback(() => {
    reset(DEFAULT_FORM);
    setSearchText('');
    setSelectedPlace(null);
    setSaveSuccess(false);
    setEditorTarget('new');
  }, [reset]);

  const openEdit = React.useCallback(
    (geofence: GeofenceDto) => {
      const [longitude, latitude] = geofence.coordinates?.[0] ?? [];
      const latVal = Number.isFinite(latitude) ? latitude as number : Number(DEFAULT_FORM.latitude);
      const lngVal = Number.isFinite(longitude) ? longitude as number : Number(DEFAULT_FORM.longitude);
      reset({
        name: geofence.name,
        latitude: String(latVal),
        longitude: String(lngVal),
        radiusMeters: Number.isFinite(geofence.radiusMeters)
          ? String(Number((geofence.radiusMeters as number) / 1000))
          : DEFAULT_FORM.radiusMeters,
        assignedDeviceIds: Array.isArray(geofence.assignedDeviceIds) ? geofence.assignedDeviceIds : [],
      });
      setSearchText(geofence.name);
      setSelectedPlace({ name: geofence.name, latitude: latVal, longitude: lngVal });
      setSaveSuccess(false);
      setEditorTarget(geofence);
    },
    [reset]
  );

  const closeEditor = React.useCallback(() => {
    reverseGeocodeRequestRef.current += 1;
    setEditorTarget(null);
    setLocationLoading(false);
    setSearchText('');
    setOnlineSuggestions([]);
    setIsSearchingOnline(false);
    setSearchError(null);
    setSaveSuccess(false);
  }, []);

  React.useEffect(() => {
    const query = searchText.trim();
    if (query.length < 3 || (selectedPlace && selectedPlace.name === query)) {
      setOnlineSuggestions([]);
      setIsSearchingOnline(false);
      setSearchError(null);
      return;
    }
    let active = true;
    const timer = setTimeout(async () => {
      setIsSearchingOnline(true);
      setSearchError(null);
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`,
          { headers: { 'User-Agent': 'GlivtTrackerApp/1.0' } }
        );
        if (!res.ok) throw new Error('Network response not ok');
        const data = await res.json();
        if (active && Array.isArray(data)) {
          const parsed = data
            .map((item: { display_name?: string; lat?: string; lon?: string }) => ({
              name: item.display_name ? item.display_name.split(',').slice(0, 3).join(',') : query,
              latitude: parseFloat(item.lat ?? '0'),
              longitude: parseFloat(item.lon ?? '0'),
            }))
            .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
          setOnlineSuggestions(parsed);
        }
      } catch {
        if (active) {
          setSearchError('Network unavailable — showing offline places');
        }
      } finally {
        if (active) setIsSearchingOnline(false);
      }
    }, 400);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [searchText, selectedPlace]);

  const locationSuggestions = React.useMemo(() => {
    const query = searchText.trim().toLowerCase();
    if (!query) return [];
    const existing = geofences.flatMap((geofence) => {
      const [longitude, latitude] = geofence.coordinates?.[0] ?? [];
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
      return [{ name: geofence.name, latitude: latitude as number, longitude: longitude as number }];
    });
    const localMatches = [...existing, ...SEARCH_PLACES].filter((place) =>
      place.name.toLowerCase().includes(query)
    );
    const combined = [...localMatches, ...onlineSuggestions];
    const seen = new Set<string>();
    return combined.filter((place) => {
      const key = `${place.name.toLowerCase()}:${place.latitude.toFixed(3)}:${place.longitude.toFixed(3)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 6);
  }, [geofences, onlineSuggestions, searchText]);

  const handlePerformSearch = React.useCallback(async () => {
    const query = searchText.trim();
    if (!query) return;

    clearErrors(['latitude', 'longitude']);

    if (locationSuggestions.length > 0) {
      const topMatch = locationSuggestions[0];
      setSearchText(topMatch.name);
      await setPickedCoordinate({ latitude: topMatch.latitude, longitude: topMatch.longitude }, true);
      return;
    }

    setIsSearchingOnline(true);
    setSearchError(null);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
        { headers: { 'User-Agent': 'GlivtTrackerApp/1.0' } }
      );
      if (!res.ok) throw new Error('Network error');
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const item = data[0];
        const lat = parseFloat(item.lat);
        const lng = parseFloat(item.lon);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const placeName = item.display_name ? item.display_name.split(',').slice(0, 3).join(',') : query;
          setSearchText(placeName);
          await setPickedCoordinate({ latitude: lat, longitude: lng }, true);
          return;
        }
      }
      setError('latitude', { message: `No location results found for "${query}"` });
    } catch {
      setError('latitude', { message: 'Network error performing location search.' });
    } finally {
      setIsSearchingOnline(false);
    }
  }, [clearErrors, locationSuggestions, setError, setPickedCoordinate, searchText]);

  const handleCurrentLocation = React.useCallback(async () => {
    setLocationLoading(true);
    clearErrors(['latitude', 'longitude']);
    reverseGeocodeRequestRef.current += 1;
    setSelectedPlace(null);
    setSearchText('');
    setSearchError(null);

    try {
      let coords: Coordinate;
      if (Platform.OS === 'web') {
        const geo = getGeolocation();
        if (!geo) {
          throw new Error('Geolocation is not supported by your browser.');
        }
        coords = await new Promise<Coordinate>((resolve, reject) => {
          geo.getCurrentPosition(
            (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
          );
        });
      } else {
        // 1. Ask for foreground permission on every explicit user request. The
        // OS resolves immediately when it has already been granted.
        const permissionResult = await Location.requestForegroundPermissionsAsync();
        if (permissionResult.status !== 'granted') {
          if (permissionResult.canAskAgain === false) {
            Alert.alert(
              'Location Permission Required',
              'Location permission is permanently denied. Please grant location access in your device settings.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Open Settings', onPress: () => Linking.openSettings().catch(() => undefined) },
              ]
            );
          } else {
            Alert.alert(
              'Permission Denied',
              'Location access was denied. Please allow location access to fill current GPS coordinates.'
            );
          }
          setError('latitude', {
            message: 'Location permission was denied. Please grant location access.',
          });
          return;
        }

        if (Platform.OS === 'android' && permissionResult.android?.accuracy === 'coarse') {
          const message = 'Precise location is disabled. Enable precise location for Glivt in device settings.';
          setError('latitude', { message });
          Alert.alert('Precise Location Required', message, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings().catch(() => undefined) },
          ]);
          return;
        }

        // 2. Check whether a GPS/location provider is enabled.
        let servicesEnabled = false;
        try {
          servicesEnabled = await Location.hasServicesEnabledAsync();
        } catch {
          servicesEnabled = true;
        }

        if (!servicesEnabled) {
          if (Platform.OS === 'android') {
            try {
              await Location.enableNetworkProviderAsync();
              servicesEnabled = await Location.hasServicesEnabledAsync();
            } catch {
              // User cancelled or provider request failed
            }
          }
          if (!servicesEnabled) {
            Alert.alert(
              'GPS Disabled',
              'Location services (GPS) are turned off. Please turn on location services in device settings to use your current location.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Open Settings', onPress: () => Linking.openSettings().catch(() => undefined) },
              ]
            );
            setError('latitude', {
              message: 'GPS location services are disabled. Please turn on location services in device settings.',
            });
            return;
          }
        }

        // 3. Force a new navigation-grade fix. This intentionally does not use
        // getLastKnownPositionAsync, so a cached/search coordinate can never be
        // mistaken for the device's current position.
        coords = await new Promise<Coordinate>((resolve, reject) => {
          let finished = false;
          const timer = setTimeout(() => {
            if (!finished) {
              finished = true;
              reject(new Error('Location request timed out. Please check your GPS signal and try again.'));
            }
          }, 15000);

          Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.BestForNavigation,
            mayShowUserSettingsDialog: true,
          })
            .then((pos) => {
              if (!finished) {
                finished = true;
                clearTimeout(timer);
                resolve({
                  latitude: pos.coords.latitude,
                  longitude: pos.coords.longitude,
                });
              }
            })
            .catch((err) => {
              if (!finished) {
                finished = true;
                clearTimeout(timer);
                reject(err);
              }
            });
        });
      }

      await setPickedCoordinate(coords, true, true);
    } catch (err: unknown) {
      const msg = describeLocationError(err);
      setError('latitude', { message: msg });
      Alert.alert('GPS Location Error', msg);
    } finally {
      setLocationLoading(false);
    }
  }, [clearErrors, setError, setPickedCoordinate]);

  const onDismissSuggestion = async (id: number) => {
    if (dismissingId != null || !Number.isSafeInteger(id) || id <= 0) return;
    setDismissingId(id);
    try {
      await dismissSuggestion(id).unwrap();
      await refetchAi();
    } catch (err) {
      Alert.alert(
        'Suggestion not dismissed',
        apiErrorMessage(err, 'Failed to dismiss this geofence suggestion.')
      );
    } finally {
      setDismissingId(null);
    }
  };

  const onApproveSuggestion = async (id: number) => {
    if (approvingId != null || !Number.isSafeInteger(id) || id <= 0) return;
    setApprovingId(id);
    try {
      const created = await approveSuggestion({ id }).unwrap();
      await Promise.allSettled([refetch(), refetchAi()]);
      const name = created?.name || 'Suggested geofence';
      Alert.alert('Geofence created', `"${name}" has been approved and added to your active geofences.`);
    } catch (err) {
      Alert.alert('Geofence not created', apiErrorMessage(err, 'Failed to approve geofence suggestion.'));
    } finally {
      setApprovingId(null);
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    const target = editorTarget;
    if (!target) return;
    // Same payload shape as before; editing reuses the record's existing
    // assignments and alert flags so nothing is silently dropped on save.
    const existing = target === 'new' ? null : target;
    const normalizedName = values.name.trim().toLowerCase();
    const duplicate = geofences.some(
      (geofence) =>
        geofence.id !== existing?.id &&
        geofence.name.trim().toLowerCase() === normalizedName
    );
    if (duplicate) {
      setError('name', { message: 'A geofence with this name already exists.' });
      return;
    }
    const body = {
      name: values.name,
      color: existing?.color || '#0F9D58',
      type: 'CIRCLE' as const,
      coordinates: [[Number(values.longitude), Number(values.latitude)]],
      radiusMeters: Number(values.radiusMeters) * 1000,
      assignedDeviceIds: values.assignedDeviceIds ?? [],
      assignedGroupIds: existing?.assignedGroupIds ?? [],
      enterAlert: existing?.enterAlert ?? true,
      exitAlert: existing?.exitAlert ?? true,
      active: existing?.active ?? true,
      ...(existing?.description ? { description: existing.description } : {}),
    };

    try {
      if (existing) {
        await updateGeofence({ id: existing.id, body }).unwrap();
      } else {
        await createGeofence(body).unwrap();
      }
      setSaveSuccess(true);
      setTimeout(() => {
        setEditorTarget(null);
        setSaveSuccess(false);
        reset(DEFAULT_FORM);
      }, 450);
    } catch (err) {
      Alert.alert('Geofence not saved', apiErrorMessage(err));
    }
  });

  const confirmDelete = React.useCallback(
    (geofence: GeofenceDto) => {
      Alert.alert(
        'Delete geofence',
        `"${geofence.name}" will stop generating enter and exit alerts.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              setDeletingId(geofence.id);
              try {
                await deleteGeofence(geofence.id).unwrap();
              } catch (err) {
                Alert.alert('Geofence not deleted', apiErrorMessage(err));
              } finally {
                setDeletingId(null);
              }
            },
          },
        ]
      );
    },
    [deleteGeofence]
  );

  if (isLoading) return <LoadingView label="Loading geofences..." />;
  if (isError || !data) return <ErrorRetryView message={apiErrorMessage(error)} onRetry={refetch} />;

  const suggestions = Array.isArray(aiSuggestions)
    ? aiSuggestions.filter((suggestion) => suggestion?.status === 'PENDING')
    : [];
  const onRefresh = () => {
    void Promise.allSettled([refetch(), refetchAi()]);
  };

  return (
    <View style={styles.screen}>
      <FlatList
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 96 }]}
        data={geofences}
        keyExtractor={(item) => String(item.id)}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isFetching || aiFetching}
            onRefresh={onRefresh}
            tintColor={c.primary}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: spacing.md }}>
            <Card style={styles.suggestionsPanel}>
              <View style={styles.suggestionsHeader}>
                <MaterialCommunityIcons name="brain" size={24} color={c.accent} />
                <Text style={styles.title}>AI Suggestions</Text>
              </View>
              <Text style={styles.subtitle}>Based on historical stop and idling patterns.</Text>
              {aiLoading ? (
                <View style={styles.aiState}>
                  <ActivityIndicator color={c.primary} size="small" />
                  <Text style={styles.subtitle}>Loading suggestions…</Text>
                </View>
              ) : isAiError ? (
                <View style={styles.aiState}>
                  <Text style={styles.aiError}>{apiErrorMessage(aiError)}</Text>
                  <Button label="Retry suggestions" onPress={refetchAi} variant="secondary" />
                </View>
              ) : suggestions.length === 0 ? (
                <View style={styles.aiState}>
                  <MaterialCommunityIcons name="check-circle-outline" size={22} color={c.primary} />
                  <Text style={styles.subtitle}>No pending suggestions.</Text>
                </View>
              ) : (
                suggestions.map((suggestion) => {
                  const latitude = finiteNumber(suggestion.centerLatitude);
                  const longitude = finiteNumber(suggestion.centerLongitude);
                  const suggestedRadius = finiteNumber(suggestion.suggestedRadiusMeters);
                  const confidence = finiteNumber(suggestion.confidence);
                  const loading = approvingId === suggestion.id;
                  return (
                    <View key={suggestion.id} style={styles.suggestionCard}>
                      <View style={styles.body}>
                        <Text style={styles.name}>
                          {safeText(suggestion.suggestedName, `Suggestion #${suggestion.id}`)}
                        </Text>
                        <Text style={styles.meta}>
                          Center: {formatCoordinate(latitude)}, {formatCoordinate(longitude)}
                        </Text>
                        <Text style={styles.meta}>
                          Radius: {suggestedRadius == null ? 'Unavailable' : `${Math.round(suggestedRadius)} m`} |{' '}
                          {Math.max(0, Math.round(finiteNumber(suggestion.visitCount) ?? finiteNumber(suggestion.clusterPointCount) ?? 0))} visits |{' '}
                          {confidence == null
                            ? 'Confidence unavailable'
                            : `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}% confidence`}
                        </Text>
                        {suggestion.averageStopMinutes > 0 ? (
                          <Text style={styles.meta}>
                            Average stop: {Math.round(suggestion.averageStopMinutes)} min
                            {suggestion.lastVisitAt
                              ? ` | last visit ${new Date(suggestion.lastVisitAt).toLocaleDateString()}`
                              : ''}
                          </Text>
                        ) : null}
                        {suggestion.reasoning ? (
                          <Text numberOfLines={3} style={styles.meta}>
                            {suggestion.reasoning}
                          </Text>
                        ) : null}
                      </View>
                      <View style={styles.suggestionActions}>
                        <Button
                          disabled={approvingId != null || dismissingId != null}
                          label="Approve & create"
                          loading={loading}
                          onPress={() => void onApproveSuggestion(suggestion.id)}
                          style={styles.approveButton}
                        />
                        <Button
                          disabled={approvingId != null || dismissingId != null}
                          label="Dismiss"
                          loading={dismissingId === suggestion.id}
                          onPress={() => void onDismissSuggestion(suggestion.id)}
                          style={styles.approveButton}
                          variant="secondary"
                        />
                      </View>
                    </View>
                  );
                })
              )}
            </Card>

            <View style={styles.listHeaderRow}>
              <Text style={styles.title}>Geofences</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                <Text style={styles.countBadge}>
                  {geofences.length} {geofences.length === 1 ? 'zone' : 'zones'}
                </Text>
                <Pressable
                  accessibilityLabel="Add geofence"
                  accessibilityRole="button"
                  onPress={openCreate}
                  style={({ pressed }) => [
                    { padding: 4 },
                    pressed && { opacity: 0.7 },
                  ]}>
                  <MaterialCommunityIcons color={c.primary} name="plus-circle" size={24} />
                </Pressable>
              </View>
            </View>
          </View>
        }
        ListEmptyComponent={
          <EmptyView
            icon="vector-circle"
            title="No geofences"
            message="Tap Add Geofence to create your first alert zone."
          />
        }
        renderItem={({ item }) => (
          <GeofenceRow
            busy={deletingId === item.id}
            colors={c}
            devicesMap={devicesMap}
            geofence={item}
            onDelete={() => confirmDelete(item)}
            onEdit={() => openEdit(item)}
            styles={styles}
          />
        )}
      />

      <Modal
        animationType="slide"
        onRequestClose={closeEditor}
        transparent
        visible={editorTarget != null}>
        <Pressable
          accessibilityLabel="Close geofence form"
          accessibilityRole="button"
          onPress={closeEditor}
          style={styles.editorBackdrop}
        />
        <View style={styles.editorWrap}>
          <View style={[styles.editorSheet, { paddingBottom: insets.bottom + spacing.md }]}>
            <View style={styles.editorHandle} />
            {/* The sheet already carries the bottom inset, so the scroller must
                not add it a second time. */}
            <KeyboardAwareForm
              applyBottomInset={false}
              contentContainerStyle={styles.editorContent}
              dismissOnTapOutside={false}>
              <Text style={styles.title}>
                {editorTarget && editorTarget !== 'new' ? 'Edit Geofence' : 'Create Circle Geofence'}
              </Text>
              <Text style={styles.subtitle}>
                Pick a centre point, then tune the radius for the alert zone.
              </Text>
              <Controller
                control={control}
                name="name"
                render={({ field: { onChange, value } }) => (
                  <TextField
                    autoCapitalize="words"
                    error={errors.name?.message}
                    label="Name"
                    onChangeText={(next) => {
                      clearErrors('name');
                      onChange(next);
                    }}
                    placeholder="Depot, office, customer site..."
                    value={value}
                  />
                )}
              />
              <View style={styles.pickerPanel}>
                <TextField
                  autoCapitalize="words"
                  label="Search location"
                  leftIcon="magnify"
                   onChangeText={(text) => {
                     reverseGeocodeRequestRef.current += 1;
                     setSearchText(text);
                    setSelectedPlace(null);
                    clearErrors(['latitude', 'longitude']);
                  }}
                  onLeftIconPress={handlePerformSearch}
                  onSubmitEditing={handlePerformSearch}
                  placeholder="Search saved zones or places..."
                  returnKeyType="search"
                  value={searchText}
                />
                {selectedPlace &&
                Math.abs(selectedPlace.latitude - pickedCoordinate.latitude) < 0.0001 &&
                Math.abs(selectedPlace.longitude - pickedCoordinate.longitude) < 0.0001 ? (
                  <View style={styles.suggestionList}>
                    <Pressable
                      accessibilityLabel={`Selected location: ${selectedPlace.name}`}
                      accessibilityRole="button"
                      style={styles.locationSuggestion}>
                      <MaterialCommunityIcons color={c.primary} name="map-marker" size={17} />
                      <View style={styles.locationSuggestionText}>
                        <Text numberOfLines={1} style={styles.locationSuggestionName}>
                          {selectedPlace.name}
                        </Text>
                        <Text style={styles.locationSuggestionMeta}>
                          {selectedPlace.latitude.toFixed(4)}, {selectedPlace.longitude.toFixed(4)}
                        </Text>
                      </View>
                      <MaterialCommunityIcons color={c.primary} name="check" size={16} />
                    </Pressable>
                  </View>
                ) : searchText.trim().length > 0 ? (
                  <View style={styles.suggestionList}>
                    {isSearchingOnline ? (
                      <View style={styles.searchStatusRow}>
                        <ActivityIndicator color={c.primary} size="small" />
                        <Text style={styles.searchStatusText}>Searching online places...</Text>
                      </View>
                    ) : null}
                    {locationSuggestions.length > 0 ? (
                      locationSuggestions.map((place) => (
                        <Pressable
                          accessibilityLabel={`Use ${place.name}`}
                          accessibilityRole="button"
                          key={`${place.name}-${place.latitude}-${place.longitude}`}
                          onPress={() => {
                            setSearchText(place.name);
                            clearErrors(['latitude', 'longitude']);
                            void setPickedCoordinate({ latitude: place.latitude, longitude: place.longitude }, true, false);
                            setSelectedPlace(place);
                          }}
                          style={styles.locationSuggestion}>
                          <MaterialCommunityIcons color={c.primary} name="map-marker-outline" size={17} />
                          <View style={styles.locationSuggestionText}>
                            <Text numberOfLines={1} style={styles.locationSuggestionName}>
                              {place.name}
                            </Text>
                            <Text style={styles.locationSuggestionMeta}>
                              {place.latitude.toFixed(4)}, {place.longitude.toFixed(4)}
                            </Text>
                          </View>
                          <MaterialCommunityIcons color={c.textMuted} name="chevron-right" size={16} />
                        </Pressable>
                      ))
                    ) : !isSearchingOnline && searchText.trim().length >= 2 ? (
                      <View style={styles.noResultsBox}>
                        <MaterialCommunityIcons color={c.textMuted} name="map-marker-off-outline" size={18} />
                        <Text style={styles.noResultsText}>No places found for &quot;{searchText}&quot;</Text>
                      </View>
                    ) : null}
                    {searchError ? (
                      <View style={styles.searchErrorBox}>
                        <MaterialCommunityIcons color={c.textMuted} name="cloud-off-outline" size={14} />
                        <Text style={styles.searchErrorText}>{searchError}</Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}
                <Pressable
                  accessibilityLabel="Use current location"
                  accessibilityRole="button"
                  disabled={locationLoading}
                  onPress={() => void handleCurrentLocation()}
                  style={({ pressed }) => [
                    styles.currentLocationButton,
                    pressed && styles.currentLocationPressed,
                    locationLoading && styles.currentLocationDisabled,
                  ]}>
                  {locationLoading ? (
                    <ActivityIndicator color={c.primary} size="small" />
                  ) : (
                    <MaterialCommunityIcons color={c.primary} name="crosshairs-gps" size={19} />
                  )}
                  <Text style={styles.currentLocationText}>
                    {locationLoading ? 'Reading GPS...' : 'Use Current Location'}
                  </Text>
                </Pressable>
                <GeofencePickerMap
                  coordinate={pickedCoordinate}
                  onChange={(next) => void setPickedCoordinate(next, false)}
                  radiusMeters={previewRadius}
                  style={styles.pickerMap}
                  styleUrl={pickerStyleUrl}
                />
                <Text style={styles.mapHint}>
                  Tap the map or drag the pin. The circle updates as radius changes.
                </Text>
              </View>
              <View style={styles.row}>
                <View style={styles.half}>
                  <Controller
                    control={control}
                    name="latitude"
                    render={({ field: { onChange, value } }) => (
                      <TextField
                        error={errors.latitude?.message}
                        keyboardType="decimal-pad"
                        label="Latitude"
                        onChangeText={onChange}
                        value={value}
                      />
                    )}
                  />
                </View>
                <View style={styles.half}>
                  <Controller
                    control={control}
                    name="longitude"
                    render={({ field: { onChange, value } }) => (
                      <TextField
                        error={errors.longitude?.message}
                        keyboardType="decimal-pad"
                        label="Longitude"
                        onChangeText={onChange}
                        value={value}
                      />
                    )}
                  />
                </View>
              </View>
              <Controller
                control={control}
                name="radiusMeters"
                render={({ field: { onChange, value } }) => (
                  <TextField
                    error={errors.radiusMeters?.message}
                    keyboardType="numeric"
                    label="Radius (km)"
                    onChangeText={onChange}
                    value={value}
                  />
                )}
              />
              <View style={styles.radiusPresetRow}>
                {RADIUS_PRESETS.map((preset) => {
                  const active = Number(watchedRadius) === preset;
                  const label = `${preset} km`;
                  return (
                    <Pressable
                      accessibilityLabel={`Set radius ${label}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      key={preset}
                      onPress={() => setValue('radiusMeters', String(preset), { shouldDirty: true, shouldValidate: true })}
                      style={[styles.radiusPreset, active && styles.radiusPresetActive]}>
                      <Text style={[styles.radiusPresetText, active && styles.radiusPresetTextActive]}>
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Controller
                control={control}
                name="assignedDeviceIds"
                render={({ field: { onChange, value } }) => (
                  <VehicleMultiSelect
                    colors={c}
                    devices={allDevices}
                    onChange={onChange}
                    selectedIds={Array.isArray(value) ? value : []}
                    styles={styles}
                  />
                )}
              />
              {saveSuccess ? (
                <View style={styles.successState}>
                  <MaterialCommunityIcons color={c.primary} name="check-circle-outline" size={18} />
                  <Text style={styles.successText}>Geofence saved successfully.</Text>
                </View>
              ) : null}
              <Button
                disabled={saveSuccess}
                label={
                  saveSuccess
                    ? 'Saved'
                    : editorTarget && editorTarget !== 'new'
                      ? 'Save changes'
                      : 'Save geofence'
                }
                loading={isCreating || isUpdating}
                onPress={onSubmit}
              />
              <Button label="Cancel" onPress={closeEditor} variant="ghost" />
            </KeyboardAwareForm>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function getVehicleIcon(category?: string | null): React.ComponentProps<typeof MaterialCommunityIcons>['name'] {
  const cat = (category ?? '').toLowerCase();
  if (cat.includes('truck') || cat.includes('heavy')) return 'truck';
  if (cat.includes('bus')) return 'bus';
  if (cat.includes('van')) return 'van-utility';
  if (cat.includes('bike') || cat.includes('motorcycle')) return 'motorbike';
  return 'car';
}

function VehicleMultiSelect({
  colors: c,
  devices,
  onChange,
  selectedIds,
  styles,
}: {
  colors: ThemeColors;
  devices: DeviceSummary[];
  onChange: (ids: number[]) => void;
  selectedIds: number[];
  styles: ReturnType<typeof makeStyles>;
}) {
  const [filterText, setFilterText] = React.useState('');
  const [expanded, setExpanded] = React.useState(false);

  const selectedSet = React.useMemo(() => new Set(selectedIds), [selectedIds]);

  const filteredDevices = React.useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter(
      (d) =>
        d.name?.toLowerCase().includes(q) ||
        d.imei?.toLowerCase().includes(q) ||
        d.category?.toLowerCase().includes(q)
    );
  }, [devices, filterText]);

  const selectedDevices = React.useMemo(
    () => devices.filter((d) => selectedSet.has(d.id)),
    [devices, selectedSet]
  );

  const toggleSelect = (id: number) => {
    const next = new Set(selectedSet);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange(Array.from(next));
  };

  const selectAll = () => {
    onChange(devices.map((d) => d.id));
  };

  const deselectAll = () => {
    onChange([]);
  };

  return (
    <View style={styles.vehicleSelectContainer}>
      <View style={styles.vehicleSelectHeader}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <MaterialCommunityIcons name="car-multiple" size={18} color={c.primary} />
          <Text style={styles.vehicleSelectLabel}>Assign Vehicle(s)</Text>
        </View>
        <View style={styles.vehicleCountBadge}>
          <Text style={styles.vehicleCountText}>
            {selectedIds.length} of {devices.length} selected
          </Text>
        </View>
      </View>

      <View style={styles.vehicleActionRow}>
        <Pressable
          accessibilityLabel="Toggle vehicle list"
          accessibilityRole="button"
          onPress={() => setExpanded((v) => !v)}
          style={[styles.vehicleActionPill, expanded && styles.vehicleActionPillActive]}>
          <MaterialCommunityIcons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={expanded ? c.primary : c.textSecondary}
          />
          <Text style={[styles.vehicleActionText, expanded && { color: c.primary }]}>
            {expanded ? 'Hide Vehicle List' : 'Select Vehicles'}
          </Text>
        </Pressable>

        <Pressable
          accessibilityLabel="Select all vehicles"
          accessibilityRole="button"
          onPress={selectAll}
          style={styles.vehicleActionPill}>
          <MaterialCommunityIcons name="check-all" size={14} color={c.primary} />
          <Text style={[styles.vehicleActionText, { color: c.primary }]}>Select All</Text>
        </Pressable>

        {selectedIds.length > 0 ? (
          <Pressable
            accessibilityLabel="Clear selected vehicles"
            accessibilityRole="button"
            onPress={deselectAll}
            style={styles.vehicleActionPill}>
            <MaterialCommunityIcons name="close-circle-outline" size={14} color={c.danger} />
            <Text style={[styles.vehicleActionText, { color: c.danger }]}>Clear All</Text>
          </Pressable>
        ) : null}
      </View>

      {selectedDevices.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.selectedChipsContainer}>
          {selectedDevices.map((d) => (
            <View key={d.id} style={styles.selectedVehicleChip}>
              <MaterialCommunityIcons
                name={getVehicleIcon(d.category)}
                size={13}
                color={c.primary}
              />
              <Text numberOfLines={1} style={styles.selectedVehicleChipText}>
                {d.name}
              </Text>
              <Pressable
                accessibilityLabel={`Remove ${d.name}`}
                accessibilityRole="button"
                hitSlop={6}
                onPress={() => toggleSelect(d.id)}>
                <MaterialCommunityIcons name="close-circle" size={14} color={c.textMuted} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : (
        <View style={styles.noVehiclesSelectedHint}>
          <Text style={styles.noVehiclesSelectedText}>
            No vehicles assigned yet. Tap &quot;Select Vehicles&quot; to choose.
          </Text>
        </View>
      )}

      {expanded ? (
        <View style={styles.vehicleDropdownPanel}>
          <View style={styles.vehicleSearchBox}>
            <MaterialCommunityIcons name="magnify" size={16} color={c.textMuted} />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setFilterText}
              placeholder="Search vehicle name or IMEI…"
              placeholderTextColor={c.textMuted}
              style={styles.vehicleSearchInput}
              value={filterText}
            />
            {filterText ? (
              <Pressable onPress={() => setFilterText('')}>
                <MaterialCommunityIcons name="close-circle" size={16} color={c.textMuted} />
              </Pressable>
            ) : null}
          </View>

          <ScrollView style={styles.vehicleListScroll} nestedScrollEnabled showsVerticalScrollIndicator>
            {filteredDevices.length === 0 ? (
              <Text style={styles.emptyVehicleSearchText}>No vehicles match &quot;{filterText}&quot;</Text>
            ) : (
              filteredDevices.map((d) => {
                const selected = selectedSet.has(d.id);
                return (
                  <Pressable
                    key={d.id}
                    onPress={() => toggleSelect(d.id)}
                    style={({ pressed }) => [
                      styles.vehicleListItem,
                      selected && styles.vehicleListItemSelected,
                      pressed && { opacity: 0.8 },
                    ]}>
                    <MaterialCommunityIcons
                      name={selected ? 'checkbox-marked-circle' : 'checkbox-blank-circle-outline'}
                      size={20}
                      color={selected ? c.primary : c.textMuted}
                    />
                    <MaterialCommunityIcons
                      name={getVehicleIcon(d.category)}
                      size={17}
                      color={selected ? c.primary : c.textSecondary}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        numberOfLines={1}
                        style={[styles.vehicleItemName, selected && { color: c.primary, fontWeight: '800' }]}>
                        {d.name}
                      </Text>
                      <Text numberOfLines={1} style={styles.vehicleItemMeta}>
                        IMEI {d.imei} · {d.category || 'Vehicle'}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.vehicleStateDot,
                        { backgroundColor: d.state === 'MOVING' || d.state === 'RUNNING' ? c.success : c.textMuted },
                      ]}
                    />
                  </Pressable>
                );
              })
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function GeofenceRow({
  busy,
  colors: c,
  devicesMap,
  geofence,
  onDelete,
  onEdit,
  styles,
}: {
  busy: boolean;
  colors: ThemeColors;
  devicesMap: Map<number, DeviceSummary>;
  geofence: GeofenceDto;
  onDelete: () => void;
  onEdit: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  const [longitude, latitude] = geofence.coordinates?.[0] ?? [];
  const deviceCount = Array.isArray(geofence.assignedDeviceIds)
    ? geofence.assignedDeviceIds.length
    : 0;

  const assignedVehicles = React.useMemo(() => {
    if (!Array.isArray(geofence.assignedDeviceIds) || geofence.assignedDeviceIds.length === 0) {
      return [];
    }
    return geofence.assignedDeviceIds
      .map((id) => devicesMap.get(id))
      .filter((d): d is DeviceSummary => d != null);
  }, [geofence.assignedDeviceIds, devicesMap]);

  return (
    <View style={styles.geofenceCard}>
      <View style={[styles.marker, { backgroundColor: geofence.color || c.primary }]}>
        <MaterialCommunityIcons color="#FFFFFF" name="map-marker-radius-outline" size={22} />
      </View>
      <View style={styles.body}>
        <View style={styles.nameRow}>
          <Text numberOfLines={1} style={styles.name}>
            {geofence.name}
          </Text>
          <View
            style={[
              styles.statusChip,
              geofence.active ? styles.statusChipActive : styles.statusChipInactive,
            ]}>
            <Text
              style={[
                styles.statusChipText,
                geofence.active ? styles.statusChipTextActive : styles.statusChipTextInactive,
              ]}>
              {geofence.active ? 'Active' : 'Inactive'}
            </Text>
          </View>
        </View>
        <Text numberOfLines={1} style={styles.meta}>
          <MaterialCommunityIcons name="crosshairs-gps" size={11} />{' '}
          {formatCoordinate(finiteNumber(latitude))}, {formatCoordinate(finiteNumber(longitude))}
        </Text>
        <Text numberOfLines={1} style={styles.meta}>
          {geofence.type} ·{' '}
          {geofence.radiusMeters ? `${Number((geofence.radiusMeters / 1000).toFixed(3))} km radius` : 'custom shape'}
        </Text>

        <View style={styles.assignedVehiclesRow}>
          {assignedVehicles.length === 0 ? (
            <Text numberOfLines={1} style={styles.noAssignedText}>
              <MaterialCommunityIcons name="car-off" size={12} /> No vehicles assigned
            </Text>
          ) : (
            <View style={styles.assignedBadgesWrap}>
              <MaterialCommunityIcons name="car-multiple" size={13} color={c.primary} style={{ marginTop: 2 }} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 5 }}>
                {assignedVehicles.slice(0, 5).map((dev) => (
                  <View key={dev.id} style={styles.assignedBadge}>
                    <MaterialCommunityIcons name={getVehicleIcon(dev.category)} size={11} color={c.primary} />
                    <Text numberOfLines={1} style={styles.assignedBadgeText}>{dev.name}</Text>
                  </View>
                ))}
                {deviceCount > 5 ? (
                  <View style={styles.assignedBadgeMore}>
                    <Text style={styles.assignedBadgeMoreText}>+{deviceCount - 5} more</Text>
                  </View>
                ) : null}
              </ScrollView>
            </View>
          )}
        </View>
      </View>
      <View style={styles.rowActions}>
        <Pressable
          accessibilityLabel={`Edit ${geofence.name}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onEdit}
          style={styles.rowActionButton}>
          <MaterialCommunityIcons color={c.textSecondary} name="pencil-outline" size={18} />
        </Pressable>
        <Pressable
          accessibilityLabel={`Delete ${geofence.name}`}
          accessibilityRole="button"
          disabled={busy}
          hitSlop={8}
          onPress={onDelete}
          style={styles.rowActionButton}>
          {busy ? (
            <ActivityIndicator color={c.danger} size="small" />
          ) : (
            <MaterialCommunityIcons color={c.danger} name="trash-can-outline" size={18} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isValidCoordinate(coordinate: Coordinate): boolean {
  return (
    Number.isFinite(coordinate.latitude) &&
    Number.isFinite(coordinate.longitude) &&
    Math.abs(coordinate.latitude) <= 90 &&
    Math.abs(coordinate.longitude) <= 180
  );
}

function uniqueAddressParts(parts: (string | null | undefined)[]): string {
  const seen = new Set<string>();
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => {
      if (!part) return false;
      const key = part.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(', ');
}

function formatExpoAddress(address?: Location.LocationGeocodedAddress): string {
  if (!address) return '';
  return uniqueAddressParts([
    uniqueAddressParts([address.streetNumber, address.street]),
    address.name,
    address.district,
    address.subregion,
    address.city,
    address.region,
    address.postalCode,
    address.country,
  ]);
}

function formatNominatimAddress(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as {
    display_name?: unknown;
    address?: Record<string, unknown>;
  };
  if (typeof record.display_name === 'string' && record.display_name.trim()) {
    return record.display_name.split(',').slice(0, 5).join(',').trim();
  }
  const address = record.address ?? {};
  const read = (key: string) => (typeof address[key] === 'string' ? address[key] as string : undefined);
  return uniqueAddressParts([
    read('road'),
    read('suburb') ?? read('neighbourhood'),
    read('city') ?? read('town') ?? read('village'),
    read('state'),
    read('postcode'),
    read('country'),
  ]);
}

function describeLocationError(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = Number((error as { code?: unknown }).code);
    if (code === 1) return 'Location permission was denied. Please grant location access.';
    if (code === 2) return 'GPS position is unavailable. Move to an open area and try again.';
    if (code === 3) return 'Location request timed out. Please check your GPS signal and try again.';
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Could not retrieve current GPS position. Please check your location settings.';
}

function formatCoordinate(value: number | null) {
  return value == null ? 'Unavailable' : value.toFixed(4);
}

function safeText(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

type GeolocationLike = {
  getCurrentPosition: (
    success: (position: { coords: { latitude: number; longitude: number } }) => void,
    error?: (error: unknown) => void,
    options?: { enableHighAccuracy?: boolean; maximumAge?: number; timeout?: number }
  ) => void;
};

function getGeolocation(): GeolocationLike | null {
  const candidate = (globalThis as { navigator?: { geolocation?: GeolocationLike } }).navigator
    ?.geolocation;
  return candidate && typeof candidate.getCurrentPosition === 'function' ? candidate : null;
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    list: { gap: spacing.sm, padding: spacing.md },
    suggestionsPanel: { gap: spacing.md },
    suggestionsHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
    aiState: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      gap: spacing.sm,
      justifyContent: 'center',
      minHeight: 84,
      padding: spacing.md,
    },
    aiError: { color: c.danger, fontSize: typography.caption, textAlign: 'center' },
    title: { color: c.textPrimary, fontSize: typography.title, fontWeight: '900' },
    subtitle: { color: c.textSecondary, fontSize: typography.caption, lineHeight: 17 },
    listHeaderRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingTop: spacing.xs,
    },
    countBadge: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.pill,
      color: c.textSecondary,
      fontSize: typography.caption,
      fontWeight: '800',
      overflow: 'hidden',
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
    },
    row: { flexDirection: 'row', gap: spacing.sm },
    half: { flex: 1, minWidth: 0 },
    pickerPanel: {
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      gap: spacing.sm,
      padding: spacing.sm,
    },
    suggestionList: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: 'hidden',
    },
    locationSuggestion: {
      alignItems: 'center',
      borderBottomColor: c.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.sm,
      minHeight: 48,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
    },
    locationSuggestionText: { flex: 1, minWidth: 0 },
    locationSuggestionName: { color: c.textPrimary, fontSize: typography.caption, fontWeight: '800' },
    locationSuggestionMeta: { color: c.textMuted, fontSize: 11, marginTop: 1 },
    searchStatusRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs + 2,
    },
    searchStatusText: { color: c.textSecondary, fontSize: typography.caption },
    noResultsBox: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    noResultsText: { color: c.textMuted, fontSize: typography.caption },
    searchErrorBox: {
      alignItems: 'center',
      borderTopColor: c.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
    },
    searchErrorText: { color: c.textMuted, fontSize: 11 },
    currentLocationButton: {
      alignItems: 'center',
      alignSelf: 'flex-start',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.xs,
      minHeight: 40,
      paddingHorizontal: spacing.md,
    },
    currentLocationPressed: { opacity: 0.82, transform: [{ scale: 0.99 }] },
    currentLocationDisabled: { opacity: 0.72 },
    currentLocationText: { color: c.primary, fontSize: typography.caption, fontWeight: '900' },
    pickerMap: {
      height: 230,
      width: '100%',
    },
    mapHint: { color: c.textMuted, fontSize: 11, lineHeight: 15 },
    radiusPresetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: -spacing.xs },
    radiusPreset: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      minHeight: 36,
      minWidth: 74,
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
    },
    radiusPresetActive: { backgroundColor: c.accentSoft, borderColor: c.primary },
    radiusPresetText: { color: c.textSecondary, fontSize: typography.caption, fontWeight: '900' },
    radiusPresetTextActive: { color: c.primary },
    successState: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderRadius: radius.sm,
      flexDirection: 'row',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: 8,
    },
    successText: { color: c.primary, fontSize: typography.caption, fontWeight: '800' },
    geofenceCard: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.md,
      padding: spacing.md,
    },
    marker: { alignItems: 'center', borderRadius: radius.sm, height: 44, justifyContent: 'center', width: 44 },
    body: { flex: 1, minWidth: 0 },
    nameRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
    name: { color: c.textPrimary, flexShrink: 1, fontSize: typography.body, fontWeight: '800' },
    meta: { color: c.textSecondary, fontSize: typography.caption, marginTop: 2 },
    statusChip: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
    statusChipActive: { backgroundColor: c.accentSoft },
    statusChipInactive: { backgroundColor: c.surfaceAlt },
    statusChipText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },
    statusChipTextActive: { color: c.primary },
    statusChipTextInactive: { color: c.textMuted },
    rowActions: { flexDirection: 'row', gap: spacing.xs },
    rowActionButton: {
      alignItems: 'center',
      borderRadius: radius.sm,
      height: 34,
      justifyContent: 'center',
      width: 34,
    },
    suggestionCard: {
      backgroundColor: c.accentSoft,
      padding: spacing.md,
      borderRadius: radius.md,
      gap: spacing.md,
      borderColor: c.accent,
      borderWidth: StyleSheet.hairlineWidth * 2,
    },
    approveButton: { alignSelf: 'flex-start', height: 40, width: 156 },
    suggestionActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    fab: {
      alignItems: 'center',
      backgroundColor: c.primary,
      borderRadius: radius.pill,
      elevation: 6,
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      position: 'absolute',
      right: spacing.md,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.28,
      shadowRadius: 14,
    },
    fabPressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
    fabLabel: { color: c.onPrimary, fontSize: typography.label, fontWeight: '900' },
    editorBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: c.overlay },
    editorWrap: { flex: 1, justifyContent: 'flex-end' },
    editorSheet: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      borderWidth: StyleSheet.hairlineWidth * 2,
      maxHeight: '88%',
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
    },
    editorHandle: {
      alignSelf: 'center',
      backgroundColor: c.borderStrong,
      borderRadius: 2,
      height: 4,
      marginBottom: spacing.md,
      width: 44,
    },
    editorContent: { gap: spacing.md, paddingBottom: spacing.md },
    vehicleSelectContainer: {
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: 1,
      gap: spacing.xs,
      padding: spacing.md,
    },
    vehicleSelectHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    vehicleSelectLabel: {
      color: c.textPrimary,
      fontSize: typography.label,
      fontWeight: '800',
    },
    vehicleCountBadge: {
      backgroundColor: c.accentSoft,
      borderRadius: radius.pill,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    vehicleCountText: {
      color: c.primary,
      fontSize: 11,
      fontWeight: '800',
    },
    vehicleActionRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      marginTop: 2,
    },
    vehicleActionPill: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    vehicleActionPillActive: {
      backgroundColor: c.accentSoft,
      borderColor: c.primary,
    },
    vehicleActionText: {
      color: c.textSecondary,
      fontSize: 11,
      fontWeight: '700',
    },
    selectedChipsContainer: {
      flexDirection: 'row',
      gap: 6,
      paddingVertical: 4,
    },
    selectedVehicleChip: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.borderStrong,
      borderRadius: radius.pill,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    selectedVehicleChipText: {
      color: c.textPrimary,
      fontSize: 12,
      fontWeight: '700',
      maxWidth: 120,
    },
    noVehiclesSelectedHint: {
      paddingVertical: 4,
    },
    noVehiclesSelectedText: {
      color: c.textMuted,
      fontSize: typography.caption,
      fontStyle: 'italic',
    },
    vehicleDropdownPanel: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: 1,
      gap: spacing.xs,
      marginTop: 6,
      maxHeight: 220,
      padding: spacing.sm,
    },
    vehicleSearchBox: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.sm,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    vehicleSearchInput: {
      color: c.textPrimary,
      flex: 1,
      fontSize: typography.caption,
      height: 32,
      padding: 0,
    },
    vehicleListScroll: {
      maxHeight: 160,
    },
    emptyVehicleSearchText: {
      color: c.textMuted,
      fontSize: typography.caption,
      padding: spacing.sm,
      textAlign: 'center',
    },
    vehicleListItem: {
      alignItems: 'center',
      borderRadius: radius.sm,
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 8,
      paddingVertical: 7,
    },
    vehicleListItemSelected: {
      backgroundColor: c.accentSoft,
    },
    vehicleItemName: {
      color: c.textPrimary,
      fontSize: 13,
      fontWeight: '600',
    },
    vehicleItemMeta: {
      color: c.textMuted,
      fontSize: 10,
    },
    vehicleStateDot: {
      borderRadius: 4,
      height: 7,
      width: 7,
    },
    assignedVehiclesRow: {
      gap: 4,
      marginTop: 4,
    },
    assignedVehiclesLabel: {
      color: c.textSecondary,
      fontSize: 11,
      fontWeight: '700',
    },
    assignedBadgesWrap: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 6,
      marginTop: 2,
    },
    assignedBadge: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    assignedBadgeText: {
      color: c.textPrimary,
      fontSize: 11,
      fontWeight: '700',
      maxWidth: 110,
    },
    assignedBadgeMore: {
      alignItems: 'center',
      backgroundColor: c.accentSoft,
      borderRadius: radius.pill,
      justifyContent: 'center',
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    assignedBadgeMoreText: {
      color: c.primary,
      fontSize: 11,
      fontWeight: '800',
    },
    noAssignedText: {
      color: c.textMuted,
      fontSize: 11,
      fontStyle: 'italic',
      marginTop: 2,
    },
  });
