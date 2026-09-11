import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  findNodeHandle,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useKeyboardHeight } from '@/src/hooks/useKeyboardInset';
import { apiErrorMessage } from '@/src/services/apiError';
import { PREMIUM_FLEET_MAP_PALETTE } from '@/src/services/mapStyle';
import { formatRouteDistance, formatRouteDuration } from '@/src/services/navigationMetrics';
import {
  type NavigationPlace,
  type NavigationRoute,
} from '@/src/services/navigationApi';
import { searchPlaces } from '@/src/services/placeSearch';
import { RoutePlanningError, planRoute } from '@/src/services/routePlanner';
import { useTheme } from '@/src/theme/ThemeProvider';
import { hexToRgba, radius, type ThemeColors } from '@/src/theme/tokens';

export type DirectionsLocation = NavigationPlace & {
  source: 'device' | 'search';
};

export type DirectionsPanelStatus = 'preview' | 'navigating' | 'arrived';

type DirectionsPanelProps = {
  visible: boolean;
  bottom: number;
  status: DirectionsPanelStatus;
  route: NavigationRoute | null;
  routeOptions: NavigationRoute[];
  selectedRouteIndex: number;
  resetKey: number;
  remainingDistanceMeters?: number | null;
  remainingDurationSeconds?: number | null;
  navigationMessage?: string;
  onClose: () => void;
  onRoutesCalculated: (
    routes: NavigationRoute[],
    from: DirectionsLocation,
    to: DirectionsLocation
  ) => void;
  onSelectRoute: (index: number) => void;
  onRouteCleared: () => void;
  onPlanAnotherRoute: () => void;
};

export function DirectionsPanel({
  visible,
  bottom,
  status,
  route,
  routeOptions,
  selectedRouteIndex,
  resetKey,
  remainingDistanceMeters,
  remainingDurationSeconds,
  navigationMessage,
  onClose,
  onRoutesCalculated,
  onSelectRoute,
  onRouteCleared,
  onPlanAnotherRoute,
}: DirectionsPanelProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const keyboardHeight = useKeyboardHeight();
  const [from, setFrom] = useState<DirectionsLocation | null>(null);
  const [to, setTo] = useState<DirectionsLocation | null>(null);
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const [panelError, setPanelError] = useState('');
  const [locating, setLocating] = useState(false);
  const [planning, setPlanning] = useState(false);
  const routeGenerationRef = useRef(0);
  const locatedForResetKeyRef = useRef<number | null>(null);
  const manualFromRef = useRef<TextInput>(null);
  const toInputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const restingWindowHeightRef = useRef(windowHeight);

  // adjustResize may consume the whole IME height, but Android edge-to-edge
  // devices can consume only part of it. Lift by the unresolved portion so the
  // sheet clears either layout without ever jumping by two keyboard heights.
  useEffect(() => {
    if (keyboardHeight <= 0) restingWindowHeightRef.current = windowHeight;
  }, [keyboardHeight, windowHeight]);
  const restingWindowHeight = keyboardHeight <= 0 ? windowHeight : restingWindowHeightRef.current;
  const resizedByIme = Math.max(0, restingWindowHeight - windowHeight);
  const unresolvedKeyboardHeight = Math.max(0, keyboardHeight - resizedByIme);
  const androidKeyboardLift =
    Platform.OS === 'android'
      ? Math.max(0, unresolvedKeyboardHeight - insets.bottom)
      : 0;
  const keyboardVisible = keyboardHeight > 0;
  // The navigation action card is below this panel at rest. It is hidden by the
  // IME while typing, so reclaim that space, then restore the supplied offset
  // as soon as the keyboard closes.
  const activeBottom = keyboardVisible ? 10 : bottom;
  const availableSheetHeight = Math.max(
    140,
    windowHeight -
      insets.top -
      activeBottom -
      (Platform.OS === 'ios' ? keyboardHeight : unresolvedKeyboardHeight) -
      10
  );

  const scrollFocusedInputIntoView = useCallback((node: number | null) => {
    if (node == null) return;
    const reveal = () => {
      scrollRef.current
        ?.getScrollResponder?.()
        ?.scrollResponderScrollNativeHandleToKeyboard?.(node, 22, true);
    };
    requestAnimationFrame(reveal);
    // Some Android IMEs publish their final frame after the focus event.
    setTimeout(reveal, Platform.OS === 'ios' ? 80 : 260);
  }, []);

  useEffect(() => {
    if (!keyboardVisible) return;
    const focused = TextInput.State.currentlyFocusedInput();
    scrollFocusedInputIntoView(focused ? findNodeHandle(focused as never) : null);
  }, [keyboardHeight, keyboardVisible, scrollFocusedInputIntoView]);

  useEffect(() => {
    routeGenerationRef.current += 1;
    setFrom(null);
    setFromText('');
    setTo(null);
    setToText('');
    setPanelError('');
    locatedForResetKeyRef.current = null;
  }, [resetKey]);

  /**
   * Plan the route here, on the device, with no routing service behind it.
   *
   * The road network is read out of the same keyless vector tiles the map is
   * already drawing and searched with A* — see `routePlanner`. There is no API
   * key, and nothing about the operator's destination leaves the phone except
   * as ordinary map tile requests.
   */
  useEffect(() => {
    if (!from || !to) return;
    const generation = (routeGenerationRef.current += 1);
    const controller = new AbortController();
    setPanelError('');
    setPlanning(true);
    planRoute({ from, to, signal: controller.signal })
      .then((route) => {
        if (routeGenerationRef.current !== generation) return;
        setPlanning(false);
        onRoutesCalculated(
          [
            {
              distanceMeters: route.distanceMeters,
              durationSeconds: route.durationSeconds,
              coordinates: route.coordinates,
            },
          ],
          from,
          to
        );
      })
      .catch((error) => {
        if (routeGenerationRef.current !== generation) return;
        if ((error as { name?: string })?.name === 'AbortError') return;
        setPlanning(false);
        onRouteCleared();
        setPanelError(
          error instanceof RoutePlanningError
            ? error.message
            : apiErrorMessage(error, 'A drivable route could not be calculated.')
        );
      });
    return () => controller.abort();
  }, [from, onRouteCleared, onRoutesCalculated, to]);

  const clearRoute = useCallback(() => {
    routeGenerationRef.current += 1;
    setPanelError('');
    onRouteCleared();
  }, [onRouteCleared]);

  const chooseFrom = useCallback(
    (next: DirectionsLocation | null, text: string) => {
      setFrom(next);
      setFromText(text);
      clearRoute();
    },
    [clearRoute]
  );
  const chooseTo = useCallback(
    (next: DirectionsLocation | null, text: string) => {
      setTo(next);
      setToText(text);
      clearRoute();
    },
    [clearRoute]
  );

  const selectDeviceLocation = useCallback(async () => {
    if (locating) return;
    try {
      setLocating(true);
      setPanelError('');
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== Location.PermissionStatus.GRANTED) {
        setPanelError('Location permission is needed to use My current location.');
        return;
      }
      const fix = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.BestForNavigation,
      });
      const { latitude, longitude } = fix.coords;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        setPanelError('The device did not return a valid current location.');
        return;
      }
      const next: DirectionsLocation = {
        id: `device-${fix.timestamp}`,
        name: 'My current location',
        formatted: 'My current location',
        resultType: 'device',
        city: '',
        state: '',
        country: '',
        latitude,
        longitude,
        source: 'device',
      };
      chooseFrom(next, next.formatted);
    } catch {
      setPanelError('The device location is unavailable. Check location services and try again.');
    } finally {
      setLocating(false);
    }
  }, [chooseFrom, locating]);

  // Directions always opens from the phone's current location. This is used
  // only to request the road plan; live progress still comes from the existing
  // validated backend/SSE mobile-GPS stream after navigation starts.
  useEffect(() => {
    if (
      !visible ||
      from ||
      locating ||
      locatedForResetKeyRef.current === resetKey
    ) {
      return;
    }
    locatedForResetKeyRef.current = resetKey;
    void selectDeviceLocation();
  }, [from, locating, resetKey, selectDeviceLocation, visible]);

  const swap = useCallback(() => {
    const nextFrom = to;
    const nextFromText = toText;
    setTo(from);
    setToText(fromText);
    setFrom(nextFrom);
    setFromText(nextFromText);
    clearRoute();
  }, [clearRoute, from, fromText, to, toText]);

  const planAnotherRoute = useCallback(() => {
    routeGenerationRef.current += 1;
    locatedForResetKeyRef.current = null;
    setFrom(null);
    setFromText('');
    setTo(null);
    setToText('');
    setPanelError('');
    onPlanAnotherRoute();
  }, [onPlanAnotherRoute]);

  if (!visible) return null;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
      pointerEvents="box-none"
      style={styles.keyboardLayer}>
      <View
        pointerEvents="box-none"
        style={[styles.sheetAnchor, { paddingBottom: activeBottom + androidKeyboardLift }]}>
        <View style={[styles.panel, { maxHeight: availableSheetHeight }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View style={styles.titleIcon}>
                <MaterialCommunityIcons color={PREMIUM_FLEET_MAP_PALETTE.selectedRoute} name="navigation-variant" size={20} />
              </View>
              <View style={styles.titleCopy}>
                <Text style={styles.title}>Directions</Text>
                <Text numberOfLines={1} style={styles.subtitle}>Find the best route to your destination</Text>
              </View>
            </View>
            <Pressable
              accessibilityLabel="Close directions"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => {
                Keyboard.dismiss();
                onClose();
              }}
              style={styles.closeButton}>
              <MaterialCommunityIcons color={colors.textSecondary} name="close" size={19} />
            </Pressable>
          </View>

          <ScrollView
            ref={scrollRef}
            automaticallyAdjustKeyboardInsets={false}
            contentContainerStyle={styles.panelContent}
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            keyboardShouldPersistTaps="always"
            nestedScrollEnabled
            overScrollMode="never"
            showsVerticalScrollIndicator={keyboardVisible}
            style={styles.panelScroll}>
            {status === 'arrived' ? (
              <View style={styles.arrivedBanner}>
                <MaterialCommunityIcons color={PREMIUM_FLEET_MAP_PALETTE.selectedRoute} name="check-circle" size={18} />
                <Text style={styles.arrivedText}>Destination reached</Text>
              </View>
            ) : null}

            <LocationAutocomplete
              accessibilityLabel="From location"
              bias={from}
              editable
              inputRef={manualFromRef}
              label="FROM"
              onChange={chooseFrom}
              onInputFocus={scrollFocusedInputIntoView}
              onSuggestionSelected={() => requestAnimationFrame(() => toInputRef.current?.focus())}
              placeholder="Area, road, landmark or address"
              selected={from}
              text={fromText}
            />

            <View style={styles.fromOptions}>
              <OptionButton
                disabled={locating}
                icon="crosshairs-gps"
                label={locating ? 'Locating…' : 'My location'}
                onPress={selectDeviceLocation}
              />
              <OptionButton
                icon="magnify"
                label="Search"
                onPress={() => manualFromRef.current?.focus()}
              />
            </View>

            <View style={styles.toRow}>
              <View style={styles.toInput}>
                <LocationAutocomplete
                  accessibilityLabel="To destination"
                  bias={from}
                  editable
                  inputRef={toInputRef}
                  label="TO"
                  onChange={chooseTo}
                  onInputFocus={scrollFocusedInputIntoView}
                  onSuggestionSelected={Keyboard.dismiss}
                  placeholder="Search destination"
                  selected={to}
                  text={toText}
                />
              </View>
              <Pressable
                accessibilityLabel="Swap From and To"
                accessibilityRole="button"
                disabled={!from && !to}
                onPress={swap}
                style={({ pressed }) => [
                  styles.swapButton,
                  (!from && !to) && styles.disabled,
                  pressed && styles.pressed,
                ]}>
                <MaterialCommunityIcons color={colors.textPrimary} name="swap-vertical" size={20} />
              </Pressable>
            </View>

            {planning ? (
              <View style={styles.messageRow}>
                <ActivityIndicator color={colors.textPrimary} size="small" />
                <Text style={styles.messageText}>Finding the best road route…</Text>
              </View>
            ) : panelError ? (
              <Text style={styles.errorText}>{panelError}</Text>
            ) : route ? (
              <View style={styles.routeOptionsBlock}>
                <View style={styles.routeOptionsHeader}>
                  <Text style={styles.routeOptionsTitle}>Route Options</Text>
                  <Text style={styles.routeOptionsHint}>
                    {routeOptions.length} {routeOptions.length === 1 ? 'route' : 'routes'} found
                  </Text>
                </View>
                <View style={styles.routeOptions}>
                  {routeOptions.map((option, index) => {
                    const selectedOption = index === selectedRouteIndex;
                    const accent = selectedOption
                      ? PREMIUM_FLEET_MAP_PALETTE.selectedRoute
                      : routeAccent(index, selectedRouteIndex);
                    const optionDistance =
                      selectedOption && status === 'navigating' && remainingDistanceMeters != null
                        ? remainingDistanceMeters
                        : option.distanceMeters;
                    const optionDuration =
                      selectedOption && status === 'navigating' && remainingDurationSeconds != null
                        ? remainingDurationSeconds
                        : option.durationSeconds;
                    return (
                      <Pressable
                        accessibilityLabel={`Select route ${index + 1}`}
                        accessibilityRole="button"
                        key={`${index}-${option.distanceMeters}-${option.durationSeconds}`}
                        onPress={() => onSelectRoute(index)}
                        style={({ pressed }) => [
                          styles.routeOption,
                          selectedOption && {
                            backgroundColor: hexToRgba(PREMIUM_FLEET_MAP_PALETTE.selectedRoute, 0.08),
                            borderColor: PREMIUM_FLEET_MAP_PALETTE.selectedRoute,
                            borderWidth: 1.5,
                          },
                          pressed && styles.pressed,
                        ]}>
                        <Text style={styles.routeOptionTime}>{formatRouteDuration(optionDuration)}</Text>
                        <Text style={styles.routeOptionDistance}>{formatRouteDistance(optionDistance)}</Text>
                        <View style={styles.routeOptionLabelRow}>
                          <View style={[styles.routeDot, { backgroundColor: accent }]} />
                          <Text
                            numberOfLines={1}
                            style={[
                              styles.routeOptionLabel,
                              selectedOption && { color: PREMIUM_FLEET_MAP_PALETTE.selectedRoute },
                            ]}>
                            {index === 0 ? 'Recommended' : `Alternative ${index}`}
                          </Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
                <View style={styles.liveBadgeRow}>
                  <View style={styles.liveDot} />
                  <Text style={styles.liveText}>Live Navigation</Text>
                </View>
              </View>
            ) : (
              <Text style={styles.hint}>Select valid FROM and TO suggestions to build a road route.</Text>
            )}

            {navigationMessage ? <Text style={styles.navigationMessage}>{navigationMessage}</Text> : null}

            {status === 'arrived' ? (
              <Pressable
                accessibilityRole="button"
                onPress={planAnotherRoute}
                style={({ pressed }) => [styles.anotherButton, pressed && styles.pressed]}>
                <MaterialCommunityIcons color={colors.textPrimary} name="directions" size={17} />
                <Text style={styles.anotherText}>Plan another route</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

type LocationAutocompleteProps = {
  accessibilityLabel: string;
  bias: { latitude: number; longitude: number } | null;
  editable: boolean;
  inputRef?: React.RefObject<TextInput | null>;
  label: string;
  onChange: (place: DirectionsLocation | null, text: string) => void;
  onInputFocus: (node: number | null) => void;
  onSuggestionSelected?: () => void;
  placeholder: string;
  selected: DirectionsLocation | null;
  text: string;
};

function LocationAutocomplete({
  accessibilityLabel,
  bias,
  editable,
  inputRef,
  label,
  onChange,
  onInputFocus,
  onSuggestionSelected,
  placeholder,
  selected,
  text,
}: LocationAutocompleteProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [suggestions, setSuggestions] = useState<NavigationPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [focused, setFocused] = useState(false);
  const searchGenerationRef = useRef(0);

  useEffect(() => {
    if (!editable || selected || text.trim().length < 2) {
      searchGenerationRef.current += 1;
      setSuggestions([]);
      setSearching(false);
      return;
    }
    const generation = (searchGenerationRef.current += 1);
    // One request in flight per field. A superseded keystroke aborts its own,
    // so a slow answer to an old query cannot overwrite a fast answer to this
    // one - and the generation check covers the abort arriving late.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      searchPlaces(text.trim(), bias ?? null, controller.signal)
        .then((places) => {
          if (searchGenerationRef.current !== generation) return;
          setSuggestions(places);
          setSearching(false);
        })
        .catch(() => {
          if (searchGenerationRef.current !== generation) return;
          setSuggestions([]);
          setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [bias, editable, selected, text]);

  return (
    <View style={[styles.fieldBlock, focused && styles.fieldBlockFocused]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.inputRow, focused && styles.inputFocused]}>
        <MaterialCommunityIcons
          color={colors.textMuted}
          name={label === 'FROM' ? 'circle-outline' : 'map-marker-outline'}
          size={17}
        />
        <TextInput
          ref={inputRef}
          accessibilityLabel={accessibilityLabel}
          autoCapitalize="words"
          autoCorrect={false}
          editable={editable}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onChangeText={(value) => onChange(null, value)}
          onFocus={(event) => {
            setFocused(true);
            onInputFocus(event.target as unknown as number);
            // A selected suggestion carries coordinates. Entering edit mode
            // invalidates that selection immediately so changed text can never
            // keep routing with the old hidden latitude/longitude.
            if (selected) onChange(null, text);
          }}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          returnKeyType="search"
          style={styles.input}
          value={text}
        />
        {searching ? <ActivityIndicator color={colors.textPrimary} size="small" /> : null}
        {editable && text.length > 0 && !searching ? (
          <Pressable
            accessibilityLabel={`Clear ${label.toLowerCase()}`}
            hitSlop={6}
            onPress={() => onChange(null, '')}>
            <MaterialCommunityIcons color={colors.textMuted} name="close-circle" size={17} />
          </Pressable>
        ) : null}
      </View>
      {focused && suggestions.length > 0 ? (
        <ScrollView
          keyboardShouldPersistTaps="always"
          nestedScrollEnabled
          showsVerticalScrollIndicator
          style={styles.suggestions}>
          {suggestions.map((place, index) => (
            <Pressable
              key={`${place.id}-${index}`}
              onPress={() => {
                setSuggestions([]);
                onChange({ ...place, source: 'search' }, place.formatted);
                onSuggestionSelected?.();
              }}
              style={({ pressed }) => [
                styles.suggestion,
                index > 0 && styles.suggestionDivider,
                pressed && styles.pressed,
              ]}>
              <MaterialCommunityIcons color={colors.textSecondary} name="map-marker" size={16} />
              <View style={styles.suggestionText}>
                <Text numberOfLines={1} style={styles.suggestionName}>{place.name}</Text>
                <Text numberOfLines={1} style={styles.suggestionAddress}>{place.formatted}</Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

function OptionButton({
  disabled = false,
  icon,
  label,
  onPress,
}: {
  disabled?: boolean;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.option, disabled && styles.disabled, pressed && styles.pressed]}>
      <MaterialCommunityIcons color={colors.textSecondary} name={icon} size={14} />
      <Text numberOfLines={1} style={styles.optionText}>{label}</Text>
    </Pressable>
  );
}

function routeAccent(index: number, selectedIndex: number): string {
  const alternativeIndex = index < selectedIndex ? index : index - 1;
  return [
    PREMIUM_FLEET_MAP_PALETTE.alternativeRouteGray,
    PREMIUM_FLEET_MAP_PALETTE.alternativeRouteBlue,
    PREMIUM_FLEET_MAP_PALETTE.alternativeRouteSlate,
  ][alternativeIndex] ?? PREMIUM_FLEET_MAP_PALETTE.alternativeRouteGray;
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    keyboardLayer: {
      ...StyleSheet.absoluteFillObject,
      elevation: 40,
      zIndex: 90,
    },
    sheetAnchor: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    panel: {
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 40,
      marginHorizontal: 12,
      paddingTop: 8,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.22,
      shadowRadius: 16,
      zIndex: 100,
    },
    handle: {
      alignSelf: 'center',
      backgroundColor: c.textMuted,
      borderRadius: radius.pill,
      height: 4,
      marginBottom: 6,
      opacity: 0.7,
      width: 42,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      zIndex: 102,
    },
    titleRow: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 7, minWidth: 0 },
    titleCopy: { flex: 1, minWidth: 0 },
    titleIcon: {
      alignItems: 'center',
      backgroundColor: hexToRgba(PREMIUM_FLEET_MAP_PALETTE.selectedRoute, 0.12),
      borderRadius: radius.pill,
      height: 38,
      justifyContent: 'center',
      width: 38,
    },
    title: { color: c.textPrimary, fontSize: 16, fontWeight: '900' },
    subtitle: { color: c.textSecondary, fontSize: 9.5, marginTop: 1 },
    closeButton: {
      alignItems: 'center',
      borderRadius: radius.pill,
      height: 30,
      justifyContent: 'center',
      width: 30,
    },
    panelScroll: { flexShrink: 1, minHeight: 0 },
    panelContent: { paddingBottom: 12, paddingHorizontal: 12 },
    arrivedBanner: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 7,
      marginTop: 8,
      padding: 9,
    },
    arrivedText: { color: c.textPrimary, fontSize: 13, fontWeight: '800' },
    fieldBlock: { marginTop: 9, position: 'relative', zIndex: 5 },
    fieldBlockFocused: { elevation: 22, zIndex: 120 },
    fieldLabel: {
      color: c.textSecondary,
      fontSize: 9,
      fontWeight: '900',
      letterSpacing: 1.1,
      marginBottom: 3,
    },
    inputRow: {
      alignItems: 'center',
      backgroundColor: c.surfaceAlt,
      borderColor: c.border,
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 7,
      height: 42,
      paddingHorizontal: 10,
    },
    inputFocused: { borderColor: c.borderStrong },
    input: { color: c.textPrimary, flex: 1, fontSize: 12.5, height: '100%', paddingVertical: 0 },
    fromOptions: { flexDirection: 'row', gap: 5, marginTop: 6 },
    option: {
      alignItems: 'center',
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flex: 1,
      flexDirection: 'row',
      gap: 4,
      justifyContent: 'center',
      minHeight: 28,
      paddingHorizontal: 5,
    },
    optionText: { color: c.textSecondary, fontSize: 9.5, fontWeight: '700' },
    toRow: { alignItems: 'flex-end', flexDirection: 'row', gap: 7, zIndex: 4 },
    toInput: { flex: 1 },
    swapButton: {
      alignItems: 'center',
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      height: 42,
      justifyContent: 'center',
      width: 42,
    },
    suggestions: {
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      elevation: 12,
      marginTop: 5,
      maxHeight: 196,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.2,
      shadowRadius: 10,
      zIndex: 130,
    },
    suggestion: { alignItems: 'center', flexDirection: 'row', gap: 7, minHeight: 48, padding: 8 },
    suggestionDivider: { borderTopColor: c.divider, borderTopWidth: StyleSheet.hairlineWidth },
    suggestionText: { flex: 1, minWidth: 0 },
    suggestionName: { color: c.textPrimary, fontSize: 11, fontWeight: '800' },
    suggestionAddress: { color: c.textSecondary, fontSize: 9.5, marginTop: 2 },
    messageRow: { alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 10 },
    messageText: { color: c.textSecondary, fontSize: 11 },
    errorText: { color: c.textSecondary, fontSize: 10.5, lineHeight: 14, marginTop: 8 },
    hint: { color: c.textMuted, fontSize: 10.5, lineHeight: 14, marginTop: 8 },
    routeOptionsBlock: { marginTop: 10 },
    routeOptionsHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 6,
    },
    routeOptionsTitle: { color: c.textPrimary, fontSize: 12, fontWeight: '900' },
    routeOptionsHint: { color: c.textMuted, fontSize: 9.5, fontWeight: '700' },
    routeOptions: { flexDirection: 'row', gap: 6 },
    routeOption: {
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      flex: 1,
      minWidth: 0,
      paddingHorizontal: 8,
      paddingVertical: 7,
    },
    routeOptionTime: {
      color: c.textPrimary,
      fontSize: 12.5,
      fontVariant: ['tabular-nums'],
      fontWeight: '900',
    },
    routeOptionDistance: { color: c.textSecondary, fontSize: 9.5, marginTop: 1 },
    routeOptionLabelRow: { alignItems: 'center', flexDirection: 'row', gap: 4, marginTop: 5 },
    routeDot: { borderRadius: 4, height: 7, width: 7 },
    routeOptionLabel: { color: c.textSecondary, flex: 1, fontSize: 8.5, fontWeight: '800' },
    liveBadgeRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 4,
      justifyContent: 'flex-end',
      marginTop: 5,
    },
    liveDot: {
      backgroundColor: PREMIUM_FLEET_MAP_PALETTE.selectedRoute,
      borderRadius: 4,
      height: 7,
      width: 7,
    },
    liveText: { color: c.textSecondary, fontSize: 9, fontWeight: '800' },
    anotherButton: {
      alignItems: 'center',
      backgroundColor: c.cardBackground,
      borderColor: c.border,
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 7,
      height: 40,
      justifyContent: 'center',
      marginTop: 10,
    },
    anotherText: { color: c.textPrimary, fontSize: 11.5, fontWeight: '800' },
    navigationMessage: { color: c.textSecondary, fontSize: 9.5, marginTop: 6, textAlign: 'center' },
    disabled: { opacity: 0.4 },
    pressed: { backgroundColor: c.surfaceAlt },
  });
