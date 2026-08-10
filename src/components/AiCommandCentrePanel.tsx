import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EventAiConversation } from '@/src/components/EventAiConversation';
import { Card } from '@/src/components/ui/Card';
import { Chip } from '@/src/components/ui/ModulePrimitives';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { apiErrorMessage } from '@/src/services/apiError';
import { useGetAllDevicesQuery } from '@/src/services/devicesApi';
import {
  useAcknowledgeAiEventMutation,
  useGetAiEventsQuery,
  useGetAiDashboardSummaryQuery,
  useGetFleetMaintenanceQuery,
  useGetDriverScoresQuery,
  useSubmitAiFeedbackMutation,
  type AiEventDto,
  type EventChatContextDto,
} from '@/src/services/aiApi';
import { useAiEventStream } from '@/src/services/aiEventStream';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

const SEVERITIES = ['ALL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

/**
 * AI Command Centre, rendered inside the notification center (it no longer has
 * its own page). Shows fleet-health, AI metrics and the AI events feed, and
 * opens the per-event AI conversation inline instead of navigating to a route.
 */
export function AiCommandCentrePanel({ onClose }: { onClose?: () => void }) {
  const { colors: c, stateColors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>('ALL');
  const [activeContext, setActiveContext] = useState<EventChatContextDto | null>(null);
  const [activeMetric, setActiveMetric] = useState<string | null>(null);

  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1900,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const summary = useGetAiDashboardSummaryQuery();
  const events = useGetAiEventsQuery(severity === 'ALL' ? { size: 50 } : { severity, size: 50 });

  const devicesQuery = useGetAllDevicesQuery(undefined, { skip: activeMetric !== 'Active' });
  const maintenanceQuery = useGetFleetMaintenanceQuery(undefined, { skip: activeMetric !== 'Maint. risk' });
  // Every driver in the tenant, not a hard-coded driver id 1 — that showed one
  // arbitrary (often non-existent) driver to every company.
  const driverQuery = useGetDriverScoresQuery(undefined, {
    skip: activeMetric !== 'Risky drivers',
  });

  // Live AI incidents. The hook shares ONE SSE connection per session and
  // invalidates the events/dashboard cache as new incidents arrive.
  const stream = useAiEventStream();

  if (activeContext) {
    return <EventAiConversation context={activeContext} onBack={() => setActiveContext(null)} />;
  }

  if (activeMetric) {
    return (
      <MetricDetailView
        metric={activeMetric}
        onBack={() => setActiveMetric(null)}
        devicesQuery={devicesQuery}
        maintenanceQuery={maintenanceQuery}
        driverQuery={driverQuery}
        eventsQuery={events}
        onAsk={setActiveContext}
        onClose={onClose}
      />
    );
  }

  if (summary.isLoading) return <LoadingView label="Loading AI command centre…" />;
  if (summary.isError || !summary.data) {
    return <ErrorRetryView message={apiErrorMessage(summary.error)} onRetry={summary.refetch} />;
  }

  const s = summary.data;
  const rawHealth = Number(s.fleetHealthScore);
  const health = Number.isFinite(rawHealth) ? Math.max(0, Math.min(100, rawHealth)) : 0;
  const healthColor = health >= 90 ? stateColors.RUNNING : health >= 70 ? stateColors.IDLE : stateColors.STOPPED;

  const metrics = [
    { icon: 'car-multiple', label: 'Active', value: s.totalActiveVehicles, tint: c.primary },
    { icon: 'bell-alert', label: 'Open alerts', value: s.unacknowledgedAiAlerts, tint: c.danger },
    { icon: 'alert-decagram', label: 'Critical 24h', value: s.criticalRiskVehicles, tint: c.danger },
    { icon: 'wrench-clock', label: 'Maint. risk', value: s.highRiskMaintenanceCount, tint: c.warningOrange },
    { icon: 'steering', label: 'Risky drivers', value: s.riskyDriversCount, tint: c.warningOrange },
    { icon: 'map-marker-path', label: 'Deviations', value: s.activeRouteDeviationsCount, tint: c.info },
  ] as const;

  return (
    <FlatList
      style={styles.screen}
      data={events.data?.content ?? []}
      keyExtractor={(item) => String(item.id)}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={summary.isFetching || events.isFetching}
          onRefresh={() => {
            summary.refetch();
            events.refetch();
          }}
          tintColor={c.primary}
        />
      }
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.lg }]}
      ListHeaderComponent={
        <View style={{ gap: spacing.md }}>
          <Card style={styles.heroCard}>
            <View style={styles.heroLeft}>
              <Text style={styles.heroLabel}>Fleet Health</Text>
              <View style={styles.gaugeWrap}>
                <Animated.View
                  style={[
                    styles.pulse,
                    {
                      borderColor: healthColor,
                      opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
                      transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.7] }) }],
                    },
                  ]}
                />
                <Text style={[styles.heroScore, { color: healthColor }]}>{health.toFixed(0)}</Text>
              </View>
              <Text style={styles.heroOutOf}>/ 100</Text>
            </View>
            <View style={styles.heroDivider} />
            <Text style={styles.heroSummary}>{s.executiveAiSummary}</Text>
          </Card>

          <View style={styles.grid}>
            {metrics.map((m) => (
              <Pressable
                key={m.label}
                accessibilityRole="button"
                accessibilityLabel={`View details for ${m.label}`}
                onPress={() => setActiveMetric(m.label)}
                style={styles.metric}>
                <MaterialCommunityIcons name={m.icon as never} color={m.tint} size={20} />
                <Text style={[styles.metricValue, { color: Number(m.value) > 0 ? m.tint : c.textPrimary }]}>
                  {m.value}
                </Text>
                <Text style={styles.metricLabel}>{m.label}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>AI Events</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                stream.unreadCount > 0
                  ? `${stream.unreadCount} unread live alerts, tap to mark read`
                  : 'Live AI alert stream status'
              }
              onPress={stream.markAllRead}
              style={styles.liveBadge}>
              <View
                style={[
                  styles.liveDot,
                  { backgroundColor: stream.connected ? stateColors.RUNNING : c.textMuted },
                ]}
              />
              <Text style={styles.liveText}>
                {stream.connected ? 'Live' : 'Reconnecting'}
              </Text>
              {stream.unreadCount > 0 && (
                <View style={styles.unreadPill}>
                  <Text style={styles.unreadPillText}>{stream.unreadCount}</Text>
                </View>
              )}
            </Pressable>
          </View>
          <View style={styles.filters}>
            {SEVERITIES.map((sv) => (
              <Chip key={sv} active={sv === severity} label={sv} onPress={() => setSeverity(sv)} />
            ))}
          </View>
        </View>
      }
      ListEmptyComponent={
        events.isLoading ? (
          <View style={styles.pad}>
            <LoadingView label="Loading events…" />
          </View>
        ) : (
          <EmptyView icon="shield-check-outline" title="No AI events" message="No anomalies for this filter." />
        )
      }
      renderItem={({ item }) => (
        <EventRow
          styles={styles}
          colors={c}
          severityColor={severityColor(item.severity, c)}
          event={item}
          onAsk={() => setActiveContext(aiEventContext(item))}
          onLocate={() => {
            if (item.latitude == null || item.longitude == null) return;
            onClose?.();
            router.push({
              pathname: '/(app)/map',
              params: {
                focusLat: String(item.latitude),
                focusLng: String(item.longitude),
                ...(item.deviceId != null ? { deviceId: String(item.deviceId) } : {}),
                ...(item.vehicleName ? { name: item.vehicleName } : {}),
              },
            });
          }}
        />
      )}
    />
  );
}

function EventRow({
  styles,
  colors: c,
  severityColor,
  event,
  onAsk,
  onLocate,
}: {
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
  severityColor: string;
  event: AiEventDto;
  onAsk: () => void;
  onLocate?: () => void;
}) {
  const [acknowledge, ackState] = useAcknowledgeAiEventMutation();
  const [submitFeedback, feedbackState] = useSubmitAiFeedbackMutation();
  const [feedbackGiven, setFeedbackGiven] = useState<boolean | null>(null);

  const hasPosition = event.latitude != null && event.longitude != null;

  const onAcknowledge = async () => {
    try {
      await acknowledge(event.id).unwrap();
    } catch (err) {
      Alert.alert('Not acknowledged', apiErrorMessage(err, 'Could not acknowledge this alert.'));
    }
  };

  // Feedback feeds evaluation reports only; it never retrains a model or moves
  // a production threshold on its own.
  const onFeedback = async (isCorrect: boolean) => {
    setFeedbackGiven(isCorrect);
    try {
      await submitFeedback({
        aiEventId: event.id,
        featureType: 'AI_EVENT',
        isCorrect,
      }).unwrap();
    } catch (err) {
      setFeedbackGiven(null);
      Alert.alert('Feedback not saved', apiErrorMessage(err, 'Could not record your feedback.'));
    }
  };

  return (
    <View style={styles.eventCard}>
      <View style={[styles.eventBar, { backgroundColor: severityColor }]} />
      <View style={styles.eventBody}>
        <View style={styles.eventTop}>
          <Text numberOfLines={1} style={styles.eventType}>
            {formatType(event.eventType)}
          </Text>
          <View style={[styles.badge, { backgroundColor: `${severityColor}22`, borderColor: `${severityColor}55` }]}>
            <Text style={[styles.badgeText, { color: severityColor }]}>{event.severity}</Text>
          </View>
        </View>
        <Text numberOfLines={2} style={styles.eventText}>
          {event.explanation ?? 'AI-detected anomaly'}
        </Text>
        <Text style={styles.eventMeta}>
          {event.vehicleName ?? `Vehicle #${event.vehicleId ?? '—'}`}
          {event.driverName ? ` · ${event.driverName}` : ''} · score {safeScore(event.score)}
          {event.occurrenceCount > 1 ? ` · seen ${event.occurrenceCount}x` : ''} ·{' '}
          {formatTime(event.lastObservedAt ?? event.createdAt)}
        </Text>
        {event.speedLimitSource ? (
          <Text style={styles.eventMeta}>
            Limit {event.speedLimitKph ?? '—'} km/h from {event.speedLimitSource}
          </Text>
        ) : null}

        <View style={styles.eventActions}>
          <Pressable
            accessibilityLabel={`Ask AI about event ${event.id}`}
            accessibilityRole="button"
            onPress={onAsk}
            style={styles.askBtn}>
            <Text style={styles.askText}>Ask</Text>
          </Pressable>

          {hasPosition && onLocate ? (
            <Pressable
              accessibilityLabel={`Show event ${event.id} on the map`}
              accessibilityRole="button"
              onPress={onLocate}
              style={styles.iconBtn}>
              <MaterialCommunityIcons name="map-marker-radius" size={16} color={c.primary} />
            </Pressable>
          ) : null}

          {!event.acknowledged ? (
            <Pressable
              accessibilityLabel={`Acknowledge event ${event.id}`}
              accessibilityRole="button"
              disabled={ackState.isLoading}
              onPress={onAcknowledge}
              style={styles.iconBtn}>
              {ackState.isLoading ? (
                <ActivityIndicator size="small" color={c.primary} />
              ) : (
                <MaterialCommunityIcons name="check" size={16} color={c.primary} />
              )}
            </Pressable>
          ) : (
            <View style={styles.ackedPill}>
              <Text style={styles.ackedText}>{event.status}</Text>
            </View>
          )}

          <Pressable
            accessibilityLabel="Mark this alert as correct"
            accessibilityRole="button"
            disabled={feedbackState.isLoading}
            onPress={() => onFeedback(true)}
            style={styles.iconBtn}>
            <MaterialCommunityIcons
              name={feedbackGiven === true ? 'thumb-up' : 'thumb-up-outline'}
              size={15}
              color={feedbackGiven === true ? c.primary : c.textMuted}
            />
          </Pressable>
          <Pressable
            accessibilityLabel="Mark this alert as a false positive"
            accessibilityRole="button"
            disabled={feedbackState.isLoading}
            onPress={() => onFeedback(false)}
            style={styles.iconBtn}>
            <MaterialCommunityIcons
              name={feedbackGiven === false ? 'thumb-down' : 'thumb-down-outline'}
              size={15}
              color={feedbackGiven === false ? c.warningOrange : c.textMuted}
            />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/**
 * Human-readable provenance for an AI result. Users are told plainly whether a
 * number came from the model, the rule engine, or demo data — a rule result is
 * never presented as a trained-model prediction.
 */
function sourceLabel(source: string | null | undefined) {
  switch (source) {
    case 'MODEL':
      return 'Trained model';
    case 'OLLAMA':
      return 'AI model';
    case 'RULE+ML':
      return 'Rule engine + ML';
    case 'RULE':
    case 'DETERMINISTIC':
      return 'Rule engine';
    case 'DEMO':
    case 'NONE':
      return 'Demo data — not a real prediction';
    default:
      return 'Source unknown';
  }
}

function severityColor(severity: string, c: ThemeColors) {
  switch (severity) {
    case 'CRITICAL':
      return c.danger;
    case 'HIGH':
      return '#EF4444';
    case 'MEDIUM':
      return c.warningOrange;
    default:
      return c.info;
  }
}

function formatType(value: unknown) {
  const text = typeof value === 'string' && value.trim() ? value.trim() : 'Unknown event';
  return text.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatTime(iso: unknown) {
  if (typeof iso !== 'string' || !iso.trim()) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function safeScore(value: unknown) {
  const score = Number(value);
  return Number.isFinite(score) ? score.toFixed(2) : '—';
}

function aiEventContext(event: AiEventDto): EventChatContextDto {
  const latitude = Number(event.latitude);
  const longitude = Number(event.longitude);
  const location =
    Number.isFinite(latitude) && Number.isFinite(longitude)
      ? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
      : 'Location unavailable';

  return {
    source: 'AI',
    eventId: event.id,
    type: formatType(event.eventType || 'Unknown event'),
    vehicle:
      event.vehicleName?.trim() ||
      (event.vehicleId != null ? `Vehicle #${event.vehicleId}` : 'Unassigned'),
    deviceId: event.deviceId != null ? String(event.deviceId) : 'Unavailable',
    time: formatTime(event.createdAt),
    severity: event.severity?.trim().toUpperCase() || 'INFO',
    location,
    description:
      event.explanation?.trim() || event.evidenceJson?.trim() || formatType(event.eventType),
  };
}

interface MetricDetailViewProps {
  metric: string;
  onBack: () => void;
  devicesQuery: any;
  maintenanceQuery: any;
  driverQuery: any;
  eventsQuery: any;
  onAsk: (context: EventChatContextDto) => void;
  onClose?: () => void;
}

function MetricDetailView({
  metric,
  onBack,
  devicesQuery,
  maintenanceQuery,
  driverQuery,
  eventsQuery,
  onAsk,
  onClose,
}: MetricDetailViewProps) {
  const { colors: c, stateColors } = useTheme();
  const styles = makeStyles(c);
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'RUNNING' | 'IDLE' | 'OFFLINE'>('ALL');

  let data: any[] = [];
  let isLoading = false;
  let isError = false;
  let errorMsg = '';
  let title = '';

  if (metric === 'Active') {
    title = 'Active Vehicles';
    isLoading = devicesQuery.isLoading;
    isError = devicesQuery.isError;
    errorMsg = apiErrorMessage(devicesQuery.error);
    data = devicesQuery.data ?? [];
  } else if (metric === 'Open alerts') {
    title = 'Open Alerts';
    isLoading = eventsQuery.isLoading;
    isError = eventsQuery.isError;
    errorMsg = apiErrorMessage(eventsQuery.error);
    data = (eventsQuery.data?.content ?? []).filter((e: any) => !e.acknowledged);
  } else if (metric === 'Critical 24h') {
    title = 'Critical Alerts (24h)';
    isLoading = eventsQuery.isLoading;
    isError = eventsQuery.isError;
    errorMsg = apiErrorMessage(eventsQuery.error);
    data = (eventsQuery.data?.content ?? []).filter((e: any) => e.severity === 'CRITICAL');
  } else if (metric === 'Maint. risk') {
    title = 'Maintenance Risks';
    isLoading = maintenanceQuery.isLoading;
    isError = maintenanceQuery.isError;
    errorMsg = apiErrorMessage(maintenanceQuery.error);
    data = maintenanceQuery.data ?? [];
  } else if (metric === 'Risky drivers') {
    title = 'Risky Drivers';
    isLoading = driverQuery.isLoading;
    isError = driverQuery.isError;
    errorMsg = apiErrorMessage(driverQuery.error);
    // Worst scores first; drivers never scored are shown as such rather than
    // being silently rendered as a perfect 100.
    data = [...(driverQuery.data ?? [])].sort(
      (a: any, b: any) => Number(a.overallScore) - Number(b.overallScore)
    );
  } else if (metric === 'Deviations') {
    title = 'Route Deviations';
    isLoading = eventsQuery.isLoading;
    isError = eventsQuery.isError;
    errorMsg = apiErrorMessage(eventsQuery.error);
    data = (eventsQuery.data?.content ?? []).filter((e: any) => e.eventType === 'ROUTE_DEVIATION');
  }

  // Filter Active Vehicles
  let filteredData = data;
  if (metric === 'Active') {
    filteredData = data.filter((d: any) => {
      const matchesSearch =
        d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (d.vehicleName || '').toLowerCase().includes(searchQuery.toLowerCase());

      const matchesStatus =
        statusFilter === 'ALL' ||
        (statusFilter === 'RUNNING' && (d.state === 'RUNNING' || d.state === 'MOVING')) ||
        (statusFilter === 'IDLE' && d.state === 'IDLE') ||
        (statusFilter === 'OFFLINE' && (d.state === 'NO_DATA' || d.state === 'OFFLINE' || d.state === 'INACTIVE' || d.state === 'EXPIRED'));

      return matchesSearch && matchesStatus;
    });
  }

  function getStatusColor(state: string) {
    switch (state) {
      case 'RUNNING':
      case 'MOVING':
        return '#10B981';
      case 'IDLE':
        return '#F59E0B';
      default:
        return '#9CA3AF';
    }
  }

  if (isLoading) return <LoadingView label={`Loading ${title.toLowerCase()}…`} />;
  if (isError) return <ErrorRetryView message={errorMsg} onRetry={onBack} />;

  return (
    <View style={styles.screen}>
      <View style={[styles.detailHeader, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable
          accessibilityLabel="Back to AI Command Centre"
          accessibilityRole="button"
          onPress={onBack}
          style={styles.backBtnWrapper}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={c.textPrimary} />
        </Pressable>
        <Text style={styles.detailHeaderTitle}>{title}</Text>
        <View style={{ width: 40 }} />
      </View>

      {metric === 'Active' && (
        <>
          <View style={styles.searchContainer}>
            <MaterialCommunityIcons name="magnify" size={20} color={c.textMuted} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search by name or registration..."
              placeholderTextColor={c.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
          </View>
          <View style={styles.filterContainer}>
            {(['ALL', 'RUNNING', 'IDLE', 'OFFLINE'] as const).map((filter) => (
              <Chip
                key={filter}
                active={statusFilter === filter}
                label={filter}
                onPress={() => setStatusFilter(filter)}
              />
            ))}
          </View>
        </>
      )}

      <FlatList
        data={filteredData}
        keyExtractor={(item, index) => String(item.id || item.driverId || index)}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.lg }]}
        refreshControl={
          <RefreshControl
            refreshing={
              metric === 'Active'
                ? devicesQuery.isFetching
                : metric === 'Maint. risk'
                  ? maintenanceQuery.isFetching
                  : metric === 'Risky drivers'
                    ? driverQuery.isFetching
                    : eventsQuery.isFetching
            }
            onRefresh={() => {
              if (metric === 'Active') devicesQuery.refetch();
              else if (metric === 'Maint. risk') maintenanceQuery.refetch();
              else if (metric === 'Risky drivers') driverQuery.refetch();
              else eventsQuery.refetch();
            }}
            tintColor={c.primary}
          />
        }
        ListEmptyComponent={
          <EmptyView
            icon="clipboard-text-outline"
            title="No records found"
            message={`No current records match ${title.toLowerCase()}.`}
          />
        }
        renderItem={({ item }) => {
          if (metric === 'Active') {
            const statusColor = getStatusColor(item.state);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Track vehicle ${item.name}`}
                onPress={() => {
                  onClose?.();
                  onBack();
                  router.push({
                    pathname: '/live-track',
                    params: { deviceId: String(item.id), name: item.name },
                  });
                }}
                style={styles.detailCard}>
                <View style={styles.cardHeader}>
                  <View>
                    <Text style={styles.cardTitle}>{item.vehicleName || 'Vehicle'}</Text>
                    <Text style={styles.cardRegNumber}>{item.name}</Text>
                  </View>
                  <View style={[styles.badge, { backgroundColor: `${statusColor}22`, borderColor: `${statusColor}55` }]}>
                    <Text style={[styles.badgeText, { color: statusColor }]}>{item.state}</Text>
                  </View>
                </View>
                <Text style={styles.cardDesc}>
                  Speed: {item.speed != null ? `${item.speed} km/h` : '0 km/h'} · {item.address || 'Location unknown'}
                </Text>
                <Text style={styles.cardTime}>
                  Last updated: {formatTime(item.lastUpdate)}
                </Text>
              </Pressable>
            );
          }
          if (metric === 'Maint. risk') {
            const riskColor = item.riskLevel === 'CRITICAL' ? c.danger : c.warningOrange;
            return (
              <View style={styles.detailCard}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>{item.vehicleName || `Vehicle #${item.vehicleId}`}</Text>
                  <View style={[styles.badge, { backgroundColor: `${riskColor}22`, borderColor: `${riskColor}55` }]}>
                    <Text style={[styles.badgeText, { color: riskColor }]}>{item.riskLevel}</Text>
                  </View>
                </View>
                <Text style={styles.cardDesc}>{item.reasoning || 'No details available'}</Text>
                <Text style={styles.cardMeta}>
                  {item.predictedComponent ? `${item.predictedComponent} · ` : ''}
                  {item.predictedDaysRemaining != null
                    ? `~${item.predictedDaysRemaining} days remaining`
                    : 'Immediate service recommended'}
                  {item.predictedKmRemaining != null
                    ? ` · ~${Math.round(Number(item.predictedKmRemaining))} km`
                    : ''}
                </Text>
                <Text style={styles.cardTime}>
                  {sourceLabel(item.source)}
                  {item.evaluatedAt ? ` · evaluated ${formatTime(item.evaluatedAt)}` : ''}
                </Text>
              </View>
            );
          }
          if (metric === 'Risky drivers') {
            // A driver with no scored trips is shown as such — never as a
            // flattering default score that was never calculated.
            if (!item.hasScore) {
              return (
                <View style={styles.detailCard}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.cardTitle}>{item.driverName}</Text>
                    <View style={[styles.badge, { backgroundColor: `${c.textMuted}22`, borderColor: `${c.textMuted}55` }]}>
                      <Text style={[styles.badgeText, { color: c.textMuted }]}>Not scored</Text>
                    </View>
                  </View>
                  <Text style={styles.cardDesc}>{item.aiCoachingAdvice}</Text>
                </View>
              );
            }
            const riskColor =
              item.riskLevel === 'CRITICAL' || item.riskLevel === 'HIGH'
                ? c.danger
                : item.riskLevel === 'MEDIUM'
                  ? c.warningOrange
                  : stateColors.RUNNING;
            return (
              <View style={styles.detailCard}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>{item.driverName}</Text>
                  <View style={[styles.badge, { backgroundColor: `${riskColor}22`, borderColor: `${riskColor}55` }]}>
                    <Text style={[styles.badgeText, { color: riskColor }]}>
                      {Number(item.overallScore).toFixed(0)}/100 · {item.grade}
                    </Text>
                  </View>
                </View>
                <Text style={styles.cardDesc}>{item.aiCoachingAdvice}</Text>
                <Text style={styles.cardMeta}>
                  Safety {Number(item.safetyScore).toFixed(0)} · Compliance{' '}
                  {Number(item.complianceScore).toFixed(0)} · Efficiency{' '}
                  {Number(item.efficiencyScore).toFixed(0)}
                </Text>
                <Text style={styles.cardMeta}>
                  {item.harshBrakeCount} harsh brake · {item.harshAccelCount} harsh accel ·{' '}
                  {Math.round(Number(item.speedingSeconds) / 60)} min speeding
                </Text>
                <Text style={styles.cardTime}>
                  {sourceLabel(item.source)}
                  {item.calculatedAt ? ` · calculated ${formatTime(item.calculatedAt)}` : ''}
                </Text>
              </View>
            );
          }
          return (
            <EventRow
              styles={styles}
              colors={c}
              severityColor={severityColor(item.severity, c)}
              event={item}
              onAsk={() => onAsk(aiEventContext(item))}
              onLocate={() => {
                if (item.latitude == null || item.longitude == null) return;
                onClose?.();
                onBack();
                router.push({
                  pathname: '/(app)/map',
                  params: {
                    focusLat: String(item.latitude),
                    focusLng: String(item.longitude),
                    ...(item.deviceId != null ? { deviceId: String(item.deviceId) } : {}),
                    ...(item.vehicleName ? { name: item.vehicleName } : {}),
                  },
                });
              }}
            />
          );
        }}
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    content: { gap: spacing.sm, padding: spacing.md },
    pad: { paddingVertical: spacing.xl },
    heroCard: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
    heroLeft: { alignItems: 'center', minWidth: 96 },
    heroLabel: { color: c.textSecondary, fontSize: typography.caption, fontWeight: '700', textTransform: 'uppercase' },
    gaugeWrap: { alignItems: 'center', justifyContent: 'center' },
    pulse: {
      borderRadius: 999,
      borderWidth: 2,
      height: 64,
      position: 'absolute',
      width: 64,
    },
    heroScore: { fontSize: 44, fontWeight: '900', fontVariant: ['tabular-nums'], lineHeight: 48 },
    heroOutOf: { color: c.textMuted, fontSize: typography.caption },
    heroDivider: { alignSelf: 'stretch', backgroundColor: c.border, width: StyleSheet.hairlineWidth * 2 },
    heroSummary: { color: c.textSecondary, flex: 1, fontSize: typography.body, lineHeight: 20 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    metric: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexBasis: '31%',
      flexGrow: 1,
      gap: 2,
      paddingVertical: spacing.md,
    },
    metricValue: { fontSize: typography.h2, fontWeight: '800', fontVariant: ['tabular-nums'] },
    metricLabel: { color: c.textSecondary, fontSize: 11, textAlign: 'center' },
    liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  liveText: { color: c.textMuted, fontSize: typography.caption, fontWeight: '700' },
  unreadPill: {
    minWidth: 18,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: c.danger,
    alignItems: 'center',
  },
  unreadPillText: { color: '#fff', fontSize: typography.caption, fontWeight: '700' },
  sectionHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: spacing.sm,
    },
    sectionTitle: { color: c.textPrimary, fontSize: typography.title, fontWeight: '900' },
    filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    eventCard: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.sm,
      overflow: 'hidden',
      paddingRight: spacing.md,
    },
    eventBar: { alignSelf: 'stretch', width: 4 },
    eventBody: { flex: 1, gap: 2, paddingVertical: spacing.md },
    eventTop: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
    eventType: { color: c.textPrimary, flex: 1, fontSize: typography.body, fontWeight: '800' },
    badge: { borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth * 2, paddingHorizontal: spacing.sm, paddingVertical: 2 },
    badgeText: { fontSize: 10, fontWeight: '900' },
    eventText: { color: c.textSecondary, fontSize: typography.caption, lineHeight: 17 },
    eventMeta: { color: c.textMuted, fontSize: 11, marginTop: 2 },
    eventActions: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.xs,
      marginTop: spacing.xs,
    },
    iconBtn: {
      alignItems: 'center',
      borderColor: c.border,
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth * 2,
      height: 30,
      justifyContent: 'center',
      width: 34,
    },
    ackedPill: {
      backgroundColor: `${c.textMuted}18`,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
    },
    ackedText: { color: c.textMuted, fontSize: 10, fontWeight: '800' },
    askBtn: {
      alignItems: 'center',
      borderColor: c.primary,
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth * 2,
      height: 34,
      justifyContent: 'center',
      width: 46,
    },
    askText: { color: c.primary, fontSize: typography.caption, fontWeight: '800' },
    detailHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth * 2,
      borderBottomColor: c.border,
      backgroundColor: c.surface,
    },
    backBtnWrapper: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    detailHeaderTitle: {
      color: c.textPrimary,
      fontSize: typography.title,
      fontWeight: '800',
    },
    detailCard: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      padding: spacing.md,
      gap: spacing.xs,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    cardTitle: {
      color: c.textPrimary,
      fontSize: typography.body,
      fontWeight: '800',
    },
    cardDesc: {
      color: c.textSecondary,
      fontSize: typography.caption,
      lineHeight: 18,
    },
    cardMeta: {
      color: c.textMuted,
      fontSize: 11,
    },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      marginHorizontal: spacing.md,
      marginTop: spacing.sm,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      borderColor: c.border,
      paddingHorizontal: spacing.sm,
      height: 44,
    },
    searchInput: {
      flex: 1,
      color: c.textPrimary,
      fontSize: typography.body,
      marginLeft: spacing.xs,
    },
    filterContainer: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      marginVertical: spacing.sm,
    },
    cardRegNumber: {
      color: c.textSecondary,
      fontSize: typography.caption,
      fontWeight: '700',
    },
    cardTime: {
      color: c.textMuted,
      fontSize: 10,
      marginTop: spacing.xs,
    },
  });
