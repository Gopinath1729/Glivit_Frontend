import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import React from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SearchableDropdown, type DropdownOption } from '@/src/components/ui/SearchableDropdown';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { EmptyView } from '@/src/components/ui/StateViews';
import { apiErrorMessage } from '@/src/services/apiError';
import {
  useGetVehicleActivityReportQuery,
  useLazyExportVehicleActivityReportQuery,
  type ActivityReportArgs,
} from '@/src/services/activityReportsApi';
import { useGetAllDevicesQuery } from '@/src/services/devicesApi';
import { isFilePickerCancellation, saveReportFile } from '@/src/services/reportFile';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import type {
  ReportActivityEvent,
  ReportLocationPoint,
  ReportOverspeedEvent,
  ReportPeriod,
  VehicleActivityReport,
} from '@/src/types/api';

const PERIODS: { label: string; value: ReportPeriod }[] = [
  { label: 'Daily', value: 'DAILY' },
  { label: 'Weekly', value: 'WEEKLY' },
  { label: 'Monthly', value: 'MONTHLY' },
];

const SUMMARY_ITEMS: {
  key: keyof VehicleActivityReport['summary'];
  label: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  format: (value: number) => string;
}[] = [
  { key: 'totalDistanceKm', label: 'Total Distance', icon: 'map-marker-distance', format: (v) => `${v.toFixed(1)} km` },
  { key: 'runningSeconds', label: 'Running Time', icon: 'car-cruise-control', format: duration },
  { key: 'idleSeconds', label: 'Idle Time', icon: 'engine-outline', format: duration },
  { key: 'stoppedSeconds', label: 'Stopped Time', icon: 'stop-circle-outline', format: duration },
  { key: 'offlineSeconds', label: 'Offline Time', icon: 'signal-off', format: duration },
  { key: 'maximumSpeedKmh', label: 'Maximum Speed', icon: 'speedometer', format: (v) => `${v.toFixed(1)} km/h` },
  { key: 'averageSpeedKmh', label: 'Average Speed', icon: 'gauge', format: (v) => `${v.toFixed(1)} km/h` },
  { key: 'overspeedCount', label: 'Overspeed Count', icon: 'alert-octagon-outline', format: (v) => String(v) },
];

/** Identity of a filter selection, used to tell "applied" from "edited since". */
function filterSignature(
  deviceId: number | undefined,
  from: Date,
  to: Date,
  period: ReportPeriod
): string {
  return [deviceId ?? 'none', startOfDay(from).getTime(), endOfSelectedDay(to).getTime(), period].join('|');
}

type AppliedFilters = ActivityReportArgs;

export default function ReportsScreen() {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const compact = width < 720;
  const scrollRef = React.useRef<ScrollView>(null);

  const devices = useGetAllDevicesQuery();
  const [selectedDeviceId, setSelectedDeviceId] = React.useState<number | undefined>();
  const [fromDate, setFromDate] = React.useState(() => daysAgo(6));
  const [toDate, setToDate] = React.useState(() => new Date());
  const [period, setPeriod] = React.useState<ReportPeriod>('DAILY');
  const [applied, setApplied] = React.useState<AppliedFilters | null>(null);
  // Set only by the Apply Filter button. Compared against the current
  // selection so changing vehicle or dates afterwards re-hides the export
  // buttons until the new selection has actually been applied and loaded.
  const [appliedSignature, setAppliedSignature] = React.useState<string | null>(null);
  const [filterOpen, setFilterOpen] = React.useState(true);
  const [showAllStops, setShowAllStops] = React.useState(false);
  const [showAllIdle, setShowAllIdle] = React.useState(false);
  const [showAllOverspeed, setShowAllOverspeed] = React.useState(false);
  const [exportFormat, setExportFormat] = React.useState<'PDF' | 'EXCEL' | null>(null);
  const [exportReport] = useLazyExportVehicleActivityReportQuery();

  const deviceOptions = React.useMemo<DropdownOption[]>(
    () =>
      (devices.data ?? []).map((device) => ({
        id: device.id,
        label: device.vehicleName || device.name,
        subLabel: `${device.name} · IMEI ${device.imei}`,
        searchTags: [device.name, device.vehicleName ?? '', device.imei],
        dotColor: stateColor(device.state, c),
      })),
    [c, devices.data]
  );

  React.useEffect(() => {
    if (selectedDeviceId != null || deviceOptions.length === 0) return;
    const first = deviceOptions[0].id;
    setSelectedDeviceId(first);
    setApplied(toArgs(first, fromDate, toDate, period));
  }, [deviceOptions, fromDate, period, selectedDeviceId, toDate]);

  const reportArgs = React.useMemo(
    () => (applied ? { ...applied, period } : null),
    [applied, period]
  );
  const report = useGetVehicleActivityReportQuery(reportArgs as ActivityReportArgs, {
    skip: reportArgs == null,
    refetchOnFocus: true,
  });

  const currentSignature = React.useMemo(
    () => filterSignature(selectedDeviceId, fromDate, toDate, period),
    [fromDate, period, selectedDeviceId, toDate]
  );

  /**
   * Exports appear only once there is a report to export.
   *
   * All four conditions matter: the user has applied a filter, the selection has
   * not changed since, data actually came back, and nothing is in flight. Without
   * the signature comparison the buttons would stay on screen after the vehicle
   * or dates were changed, and would export the previous vehicle's report.
   */
  const canExport =
    appliedSignature != null &&
    appliedSignature === currentSignature &&
    !report.isFetching &&
    !report.isError &&
    report.data != null;

  const applyFilters = React.useCallback(() => {
    if (selectedDeviceId == null) {
      Alert.alert('Select a vehicle', 'Choose a vehicle before applying the report filter.');
      return;
    }
    if (startOfDay(fromDate).getTime() > endOfSelectedDay(toDate).getTime()) {
      Alert.alert('Invalid date range', 'From Date must be before or equal to To Date.');
      return;
    }
    setShowAllStops(false);
    setShowAllIdle(false);
    setShowAllOverspeed(false);
    setApplied(toArgs(selectedDeviceId, fromDate, toDate, period));
    setAppliedSignature(filterSignature(selectedDeviceId, fromDate, toDate, period));
  }, [fromDate, period, selectedDeviceId, toDate]);

  const download = React.useCallback(
    async (format: 'PDF' | 'EXCEL') => {
      if (!reportArgs || exportFormat) return;
      setExportFormat(format);
      try {
        const payload = await exportReport({ ...reportArgs, period, format }).unwrap();
        const saved = await saveReportFile(payload, reportArgs.deviceId, format);
        Alert.alert('Report downloaded', `${saved.fileName} saved to ${saved.location}.`);
      } catch (error) {
        if (!isFilePickerCancellation(error)) {
          Alert.alert('Export failed', apiErrorMessage(error, 'Unable to export this report.'));
        }
      } finally {
        setExportFormat(null);
      }
    },
    [exportFormat, exportReport, period, reportArgs]
  );

  if (devices.isLoading) {
    return <PageState icon="file-chart-outline" label="Loading report vehicles…" loading styles={styles} />;
  }
  if (devices.isError) {
    return (
      <PageState
        icon="cloud-alert-outline"
        label={apiErrorMessage(devices.error, 'Vehicles could not be loaded.')}
        onRetry={devices.refetch}
        styles={styles}
      />
    );
  }
  if (deviceOptions.length === 0) {
    return <EmptyView icon="car-off" title="No vehicles available" message="Add a vehicle before creating an activity report." />;
  }

  const data = report.data;

  return (
    <ScrollView
      ref={scrollRef}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: Math.max(insets.bottom, 12) + 84 },
      ]}
      refreshControl={
        <RefreshControl
          onRefresh={() => {
            void devices.refetch();
            if (applied) void report.refetch();
          }}
          refreshing={devices.isFetching || report.isFetching}
          tintColor={c.primary}
        />
      }
      style={styles.screen}>
      <View style={[styles.pageWidth, !compact && styles.pageWidthDesktop]}>
        <View style={styles.titleRow}>
          <View>
            <Text style={styles.pageTitle}>Reports</Text>
            <Text style={styles.pageSubtitle}>Comprehensive vehicle activity report</Text>
          </View>
          <Pressable
            accessibilityLabel="Show report filters"
            accessibilityRole="button"
            onPress={() => {
              setFilterOpen((value) => !value);
              scrollRef.current?.scrollTo({ animated: true, y: 0 });
            }}
            style={[styles.filterIcon, filterOpen && styles.filterIconActive]}>
            <MaterialCommunityIcons color={filterOpen ? c.onPrimary : c.primary} name="filter-variant" size={22} />
          </Pressable>
        </View>

        {filterOpen ? (
          <Card style={styles.filterCard}>
            <SectionHeading icon="tune-variant" title="Report filters" styles={styles} color={c.primary} />
            <View style={[styles.filterGrid, !compact && styles.filterGridDesktop]}>
              <View style={styles.filterVehicle}>
                <SearchableDropdown
                  emptyText="No matching vehicles"
                  label="Vehicle"
                  onSelect={(option) => setSelectedDeviceId(option?.id)}
                  options={deviceOptions}
                  placeholder="Select vehicle"
                  selectedId={selectedDeviceId}
                />
              </View>
              <DateField label="From Date" onChange={setFromDate} value={fromDate} />
              <DateField label="To Date" onChange={setToDate} value={toDate} />
            </View>
            <Button icon="filter-check-outline" label="Apply Filter" loading={report.isFetching && !report.data} onPress={applyFilters} />
          </Card>
        ) : null}

        {report.isLoading || (report.isFetching && !data) ? (
          <Card style={styles.loadingCard}>
            <ActivityIndicator color={c.primary} size="large" />
            <Text style={styles.loadingText}>Building report from GPS telemetry…</Text>
          </Card>
        ) : report.isError ? (
          <Card style={styles.errorCard}>
            <MaterialCommunityIcons color={c.danger} name="alert-circle-outline" size={30} />
            <Text style={styles.errorTitle}>Report could not be loaded</Text>
            <Text style={styles.errorText}>{apiErrorMessage(report.error)}</Text>
            <Button icon="refresh" label="Try again" onPress={report.refetch} variant="secondary" />
          </Card>
        ) : data ? (
          <>
            <View style={styles.contextBar}>
              <View style={[styles.statusDot, { backgroundColor: stateColor(data.vehicleStatus, c) }]} />
              <View style={styles.contextText}>
                <Text numberOfLines={1} style={styles.contextTitle}>{data.vehicleName}</Text>
                <Text style={styles.contextMeta}>{formatDateRange(data.fromTime, data.toTime)} · {prettyState(data.vehicleStatus)}</Text>
              </View>
              {report.isFetching ? <ActivityIndicator color={c.primary} size="small" /> : null}
            </View>

            {!data.hasGpsData ? (
              <View style={styles.noGpsBanner}>
                <MaterialCommunityIcons color="#B45309" name="crosshairs-question" size={22} />
                <View style={styles.bannerCopy}>
                  <Text style={styles.noGpsTitle}>No GPS data available</Text>
                  <Text style={styles.noGpsText}>No valid GPS location exists for this vehicle and date range.</Text>
                </View>
              </View>
            ) : null}

            <ReportSection title="Summary overview" icon="view-dashboard-outline" styles={styles} color={c.primary}>
              <View style={styles.summaryGrid}>
                {SUMMARY_ITEMS.map((item) => (
                  <View key={item.key} style={[styles.summaryCard, compact ? styles.summaryCardCompact : styles.summaryCardWide]}>
                    <View style={styles.metricIcon}>
                      <MaterialCommunityIcons color={c.primary} name={item.icon} size={19} />
                    </View>
                    <Text style={styles.metricLabel}>{item.label}</Text>
                    <Text style={styles.metricValue}>{item.format(Number(data.summary[item.key]))}</Text>
                  </View>
                ))}
              </View>
            </ReportSection>

            <ReportSection title="Distance trend" icon="chart-bar" styles={styles} color={c.primary}>
              <View style={styles.periodRow}>
                {PERIODS.map((item) => (
                  <Pressable
                    key={item.value}
                    onPress={() => setPeriod(item.value)}
                    style={[styles.periodButton, period === item.value && styles.periodButtonActive]}>
                    <Text style={[styles.periodText, period === item.value && styles.periodTextActive]}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>
              <DistanceChart data={data.distanceTrend} styles={styles} color={c.primary} muted={c.textMuted} />
            </ReportSection>

            <ReportSection title="Vehicle journey" icon="map-marker-path" styles={styles} color={c.primary}>
              <View style={[styles.journeyGrid, !compact && styles.journeyGridDesktop]}>
                <LocationCard location={data.journey.start} styles={styles} color={c.primary} />
                <LocationCard location={data.journey.end} styles={styles} color={c.primary} />
              </View>
            </ReportSection>

            <ReportSection title="Stop and idle details" icon="timer-pause-outline" styles={styles} color={c.primary}>
              <EventList
                count={data.stopIdleDetails.totalStops}
                events={data.stopIdleDetails.stops}
                expanded={showAllStops}
                icon="stop-circle-outline"
                label="Stop details"
                onToggle={() => setShowAllStops((value) => !value)}
                styles={styles}
                color="#DC2626"
              />
              <View style={styles.sectionDivider} />
              <EventList
                count={data.stopIdleDetails.totalIdleEvents}
                events={data.stopIdleDetails.idleEvents}
                expanded={showAllIdle}
                icon="engine-outline"
                label="Idle details"
                onToggle={() => setShowAllIdle((value) => !value)}
                styles={styles}
                color="#D97706"
              />
            </ReportSection>

            <ReportSection title="Activity summary" icon="chart-donut" styles={styles} color={c.primary}>
              {data.activitySummary.map((item) => {
                const color = activityColor(item.status, c);
                return (
                  <View key={item.status} style={styles.activityRow}>
                    <View style={styles.activityHeader}>
                      <View style={styles.activityNameRow}>
                        <View style={[styles.activityDot, { backgroundColor: color }]} />
                        <Text style={styles.activityName}>{prettyState(item.status)}</Text>
                      </View>
                      <Text style={styles.activityValue}>{duration(item.durationSeconds)} · {item.percentage.toFixed(1)}%</Text>
                    </View>
                    <View style={styles.progressTrack}>
                      <View style={[styles.progressFill, { backgroundColor: color, width: `${Math.min(100, Math.max(0, item.percentage))}%` }]} />
                    </View>
                  </View>
                );
              })}
            </ReportSection>

            <ReportSection title="Overspeed details" icon="speedometer" styles={styles} color={c.primary}>
              <OverspeedList
                events={data.overspeedDetails}
                expanded={showAllOverspeed}
                onToggle={() => setShowAllOverspeed((value) => !value)}
                styles={styles}
                color="#DC2626"
              />
            </ReportSection>

            {/* Hidden until a filter has been applied and its data has arrived,
                so there is never an Export button that would download the
                previous vehicle's report or nothing at all. */}
            {canExport ? (
              <ReportSection title="Export report" icon="download-box-outline" styles={styles} color={c.primary}>
                <Text style={styles.exportHint}>Download the complete filtered report, including journey, trend, stop, idle and activity data.</Text>
                <View style={[styles.exportRow, !compact && styles.exportRowDesktop]}>
                  <View style={styles.exportButton}>
                    <Button icon="file-pdf-box" label="Export PDF" loading={exportFormat === 'PDF'} disabled={exportFormat !== null} onPress={() => void download('PDF')} />
                  </View>
                  <View style={styles.exportButton}>
                    <Button icon="microsoft-excel" label="Export Excel" loading={exportFormat === 'EXCEL'} disabled={exportFormat !== null} onPress={() => void download('EXCEL')} variant="secondary" />
                  </View>
                </View>
              </ReportSection>
            ) : null}
          </>
        ) : (
          <Card style={styles.loadingCard}>
            <MaterialCommunityIcons color={c.textMuted} name="filter-check-outline" size={32} />
            <Text style={styles.loadingText}>Choose a vehicle and date range, then apply the filter.</Text>
          </Card>
        )}
      </View>
    </ScrollView>
  );
}

function DateField({ label, value, onChange }: { label: string; value: Date; onChange: (date: Date) => void }) {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [visible, setVisible] = React.useState(false);
  const changed = (_event: DateTimePickerEvent, selected?: Date) => {
    if (Platform.OS !== 'ios') setVisible(false);
    if (selected) onChange(selected);
  };
  return (
    <View style={styles.dateField}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Pressable onPress={() => setVisible(true)} style={styles.dateTrigger}>
        <MaterialCommunityIcons color={c.primary} name="calendar-month-outline" size={19} />
        <Text style={styles.dateText}>{value.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })}</Text>
        <MaterialCommunityIcons color={c.textMuted} name="chevron-down" size={18} />
      </Pressable>
      {visible ? (
        <DateTimePicker display={Platform.OS === 'ios' ? 'inline' : 'default'} maximumDate={new Date()} mode="date" onChange={changed} value={value} />
      ) : null}
      {visible && Platform.OS === 'ios' ? <Button label="Done" onPress={() => setVisible(false)} variant="ghost" /> : null}
    </View>
  );
}

function ReportSection({ title, icon, children, styles, color }: { title: string; icon: React.ComponentProps<typeof MaterialCommunityIcons>['name']; children: React.ReactNode; styles: ReturnType<typeof makeStyles>; color: string }) {
  return <Card style={styles.section}><SectionHeading icon={icon} title={title} styles={styles} color={color} />{children}</Card>;
}

function SectionHeading({ title, icon, styles, color }: { title: string; icon: React.ComponentProps<typeof MaterialCommunityIcons>['name']; styles: ReturnType<typeof makeStyles>; color: string }) {
  return <View style={styles.sectionHeading}><View style={styles.sectionIcon}><MaterialCommunityIcons color={color} name={icon} size={19} /></View><Text style={styles.sectionTitle}>{title}</Text></View>;
}

function DistanceChart({ data, styles, color, muted }: { data: VehicleActivityReport['distanceTrend']; styles: ReturnType<typeof makeStyles>; color: string; muted: string }) {
  const maximum = Math.max(0, ...data.map((item) => item.distanceKm));
  if (data.length === 0) return <Text style={styles.emptyInlineText}>No distance trend data available.</Text>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chartContent}>
      {data.map((item) => {
        const height = maximum <= 0 ? 4 : Math.max(5, Math.round((item.distanceKm / maximum) * 112));
        return <View key={`${item.bucketStart}-${item.label}`} style={styles.barItem}><Text style={styles.barValue}>{item.distanceKm.toFixed(1)}</Text><View style={styles.barTrack}><View style={[styles.bar, { backgroundColor: color, height }]} /></View><Text numberOfLines={1} style={[styles.barLabel, { color: muted }]}>{item.label}</Text></View>;
      })}
    </ScrollView>
  );
}

function LocationCard({ location, styles, color }: { location?: ReportLocationPoint | null; styles: ReturnType<typeof makeStyles>; color: string }) {
  if (!location) return <View style={styles.locationCard}><Text style={styles.emptyInlineText}>No GPS data available.</Text></View>;
  return (
    <View style={styles.locationCard}>
      <View style={styles.locationTitleRow}><View style={[styles.locationPin, { backgroundColor: color }]}><MaterialCommunityIcons color="#FFFFFF" name="map-marker" size={18} /></View><View style={styles.locationTitleCopy}><Text style={styles.locationTitle}>{location.label}</Text>{location.lastKnown ? <Text style={styles.lastKnown}>LAST AVAILABLE GPS LOCATION</Text> : null}</View></View>
      <Text style={styles.locationAddress}>{location.address || 'Address unavailable'}</Text>
      <View style={styles.locationMetaRow}><MaterialCommunityIcons color="#64748B" name="calendar-clock" size={15} /><Text style={styles.locationMeta}>{formatDateTime(location.dateTime)}</Text></View>
      <View style={styles.locationMetaRow}><MaterialCommunityIcons color="#64748B" name="crosshairs-gps" size={15} /><Text style={styles.locationMeta}>{location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}</Text></View>
      <Pressable onPress={() => viewOnMap(location.latitude, location.longitude)} style={styles.mapAction}><MaterialCommunityIcons color={color} name="map-search-outline" size={17} /><Text style={[styles.mapActionText, { color }]}>View on Map</Text></Pressable>
    </View>
  );
}

function EventList({ count, events, expanded, onToggle, label, icon, color, styles }: { count: number; events: ReportActivityEvent[]; expanded: boolean; onToggle: () => void; label: string; icon: React.ComponentProps<typeof MaterialCommunityIcons>['name']; color: string; styles: ReturnType<typeof makeStyles> }) {
  const visible = expanded ? events : events.slice(0, 3);
  return (
    <View style={styles.eventGroup}>
      <View style={styles.eventHeading}><View style={styles.eventTitleRow}><MaterialCommunityIcons color={color} name={icon} size={20} /><Text style={styles.eventTitle}>{label}</Text></View><View style={[styles.countBadge, { backgroundColor: `${color}18` }]}><Text style={[styles.countText, { color }]}>{count}</Text></View></View>
      {events.length === 0 ? <Text style={styles.emptyInlineText}>No {label.toLowerCase()} in this reporting period.</Text> : visible.map((event, index) => <View key={`${event.startTime}-${index}`} style={styles.eventRow}><View style={[styles.eventIndex, { borderColor: color }]}><Text style={[styles.eventIndexText, { color }]}>{index + 1}</Text></View><View style={styles.eventCopy}><Text numberOfLines={2} style={styles.eventAddress}>{event.address || 'Address unavailable'}</Text><Text style={styles.eventMeta}>{formatDateTime(event.startTime)} → {formatDateTime(event.endTime)}</Text><Text style={styles.eventDuration}>Duration {duration(event.durationSeconds)}</Text>{event.latitude != null && event.longitude != null ? <Pressable onPress={() => viewOnMap(event.latitude!, event.longitude!)}><Text style={[styles.inlineMap, { color }]}>View on Map</Text></Pressable> : null}</View></View>)}
      {events.length > 3 ? <Pressable onPress={onToggle} style={styles.expandButton}><Text style={[styles.expandText, { color }]}>{expanded ? 'Show less' : `View all ${events.length} records`}</Text><MaterialCommunityIcons color={color} name={expanded ? 'chevron-up' : 'chevron-down'} size={18} /></Pressable> : null}
    </View>
  );
}

function OverspeedList({ events, expanded, onToggle, color, styles }: { events: ReportOverspeedEvent[]; expanded: boolean; onToggle: () => void; color: string; styles: ReturnType<typeof makeStyles> }) {
  const visible = expanded ? events : events.slice(0, 3);
  if (events.length === 0) {
    return <Text style={styles.emptyInlineText}>No overspeed events in this reporting period.</Text>;
  }
  return (
    <View style={styles.eventGroup}>
      {visible.map((event, index) => (
        <View key={`${event.startTime}-${index}`} style={styles.eventRow}>
          <View style={[styles.eventIndex, { borderColor: color }]}>
            <Text style={[styles.eventIndexText, { color }]}>{index + 1}</Text>
          </View>
          <View style={styles.eventCopy}>
            <Text style={styles.eventAddress}>{event.maximumSpeedKmh.toFixed(1)} km/h <Text style={styles.eventMeta}>/ {event.speedLimitKmh.toFixed(1)} km/h limit</Text></Text>
            <Text numberOfLines={2} style={styles.eventMeta}>{event.address || 'Address unavailable'}</Text>
            <Text style={styles.eventMeta}>{formatDateTime(event.startTime)} → {formatDateTime(event.endTime)}</Text>
            <Text style={styles.eventDuration}>Duration {duration(event.durationSeconds)}</Text>
            {event.latitude != null && event.longitude != null ? (
              <Pressable onPress={() => viewOnMap(event.latitude!, event.longitude!)}>
                <Text style={[styles.inlineMap, { color }]}>View on Map</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ))}
      {events.length > 3 ? (
        <Pressable onPress={onToggle} style={styles.expandButton}>
          <Text style={[styles.expandText, { color }]}>{expanded ? 'Show less' : `View all ${events.length} events`}</Text>
          <MaterialCommunityIcons color={color} name={expanded ? 'chevron-up' : 'chevron-down'} size={18} />
        </Pressable>
      ) : null}
    </View>
  );
}


function PageState({ icon, label, loading, onRetry, styles }: { icon: React.ComponentProps<typeof MaterialCommunityIcons>['name']; label: string; loading?: boolean; onRetry?: () => void; styles: ReturnType<typeof makeStyles> }) {
  const { colors: c } = useTheme();
  return <View style={styles.fullState}>{loading ? <ActivityIndicator color={c.primary} size="large" /> : <MaterialCommunityIcons color={c.danger} name={icon} size={38} />}<Text style={styles.loadingText}>{label}</Text>{onRetry ? <View style={styles.retry}><Button icon="refresh" label="Retry" onPress={onRetry} /></View> : null}</View>;
}

function toArgs(deviceId: number, from: Date, to: Date, period: ReportPeriod): AppliedFilters { return { deviceId, from: startOfDay(from).toISOString(), to: endOfSelectedDay(to).toISOString(), period }; }
function startOfDay(value: Date) { const date = new Date(value); date.setHours(0, 0, 0, 0); return date; }
function endOfSelectedDay(value: Date) { const date = new Date(value); const now = new Date(); date.setHours(23, 59, 59, 999); return date.getTime() > now.getTime() ? now : date; }
function daysAgo(days: number) { const date = new Date(); date.setDate(date.getDate() - days); return date; }
function duration(raw: number) { const seconds = Math.max(0, Math.round(raw)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const rest = seconds % 60; return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`; }
function formatDateTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function formatDateRange(from: string, to: string) { return `${new Date(from).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}`; }
function prettyState(value: string) { const text = (value || 'NO_DATA').replaceAll('_', ' ').toLowerCase(); return text.replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function activityColor(status: string, c: ThemeColors) { const normalized = (status || '').toUpperCase(); if (normalized === 'RUNNING') return c.success; if (normalized === 'STOPPED') return c.danger; if (normalized === 'IDLE') return c.warning; return c.textMuted; }
function stateColor(status: string, c: ThemeColors) { const normalized = (status || '').toUpperCase(); if (normalized === 'RUNNING') return c.success; if (normalized === 'STOPPED') return c.danger; if (normalized === 'IDLE') return c.warning; return c.textMuted; }
function viewOnMap(latitude: number, longitude: number) { const url = Platform.select({ ios: `maps:0,0?q=${latitude},${longitude}`, default: `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}` })!; void Linking.openURL(url); }

const makeStyles = (c: ThemeColors) => StyleSheet.create({
  screen: { backgroundColor: c.pageBackground, flex: 1 },
  content: { padding: 10 },
  pageWidth: { alignSelf: 'center', gap: 10, width: '100%' },
  pageWidthDesktop: { maxWidth: 1080 },
  titleRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2 },
  pageTitle: { color: c.textPrimary, fontSize: 26, fontWeight: '900', letterSpacing: -0.6 },
  pageSubtitle: { color: c.textSecondary, fontSize: typography.caption, marginTop: 2 },
  filterIcon: { alignItems: 'center', backgroundColor: c.surface, borderColor: c.border, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth * 2, height: 44, justifyContent: 'center', width: 44 },
  filterIconActive: { backgroundColor: c.primary, borderColor: c.primary },
  filterCard: { gap: 10, padding: 12 },
  filterGrid: { gap: 10 },
  filterGridDesktop: { alignItems: 'flex-start', flexDirection: 'row' },
  filterVehicle: { flex: 1.4, minWidth: 230 },
  dateField: { flex: 1, gap: 4, minWidth: 180 },
  fieldLabel: { color: c.textSecondary, fontSize: typography.label, fontWeight: '600' },
  dateTrigger: { alignItems: 'center', backgroundColor: c.surface, borderColor: c.border, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth * 2, flexDirection: 'row', gap: spacing.sm, minHeight: 44, paddingHorizontal: 12 },
  dateText: { color: c.textPrimary, flex: 1, fontSize: typography.body, fontWeight: '600' },
  section: { gap: 10, padding: 12 },
  sectionHeading: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  sectionIcon: { alignItems: 'center', backgroundColor: c.accentSoft, borderRadius: radius.sm, height: 32, justifyContent: 'center', width: 32 },
  sectionTitle: { color: c.textPrimary, flex: 1, fontSize: typography.title, fontWeight: '900' },
  loadingCard: { alignItems: 'center', gap: spacing.md, justifyContent: 'center', minHeight: 160 },
  loadingText: { color: c.textSecondary, fontSize: typography.body, textAlign: 'center' },
  errorCard: { alignItems: 'center', gap: spacing.sm, minHeight: 190 },
  errorTitle: { color: c.textPrimary, fontSize: typography.title, fontWeight: '800' },
  errorText: { color: c.textSecondary, fontSize: typography.caption, textAlign: 'center' },
  fullState: { alignItems: 'center', backgroundColor: c.pageBackground, flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.xl },
  retry: { width: 180 },
  contextBar: { alignItems: 'center', backgroundColor: c.surface, borderColor: c.border, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth * 2, flexDirection: 'row', gap: spacing.sm, padding: 10 },
  statusDot: { borderRadius: 6, height: 12, width: 12 },
  contextText: { flex: 1, minWidth: 0 },
  contextTitle: { color: c.textPrimary, fontSize: typography.body, fontWeight: '800' },
  contextMeta: { color: c.textSecondary, fontSize: typography.caption, marginTop: 2 },
  noGpsBanner: { alignItems: 'flex-start', backgroundColor: 'rgba(245, 158, 11, 0.12)', borderColor: 'rgba(245, 158, 11, 0.34)', borderRadius: radius.md, borderWidth: 1, flexDirection: 'row', gap: spacing.sm, padding: 10 },
  bannerCopy: { flex: 1 },
  noGpsTitle: { color: c.warning, fontSize: typography.label, fontWeight: '800' },
  noGpsText: { color: c.textSecondary, fontSize: typography.caption, lineHeight: 17, marginTop: 2 },
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  summaryCard: { backgroundColor: c.surfaceAlt, borderColor: c.border, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, gap: 4, minHeight: 94, padding: 10 },
  summaryCardCompact: { flexBasis: '47%', flexGrow: 1 },
  summaryCardWide: { flexBasis: '23%', flexGrow: 1 },
  metricIcon: { alignItems: 'center', backgroundColor: c.accentSoft, borderRadius: 9, height: 30, justifyContent: 'center', width: 30 },
  metricLabel: { color: c.textSecondary, fontSize: 11, fontWeight: '700' },
  metricValue: { color: c.textPrimary, fontSize: 16, fontVariant: ['tabular-nums'], fontWeight: '900' },
  periodRow: { backgroundColor: c.surfaceAlt, borderRadius: radius.md, flexDirection: 'row', padding: 3 },
  periodButton: { alignItems: 'center', borderRadius: radius.sm, flex: 1, paddingVertical: 9 },
  periodButtonActive: { backgroundColor: c.primary },
  periodText: { color: c.textSecondary, fontSize: typography.caption, fontWeight: '700' },
  periodTextActive: { color: c.onPrimary, fontWeight: '900' },
  chartContent: { alignItems: 'flex-end', gap: spacing.sm, minHeight: 150, paddingBottom: 2, paddingTop: 8 },
  barItem: { alignItems: 'center', gap: 5, width: 58 },
  barValue: { color: c.textPrimary, fontSize: 10, fontVariant: ['tabular-nums'], fontWeight: '700' },
  barTrack: { alignItems: 'center', height: 112, justifyContent: 'flex-end', width: 28 },
  bar: { borderRadius: 7, width: 22 },
  barLabel: { fontSize: 10, textAlign: 'center', width: 58 },
  journeyGrid: { gap: spacing.sm },
  journeyGridDesktop: { flexDirection: 'row' },
  locationCard: { backgroundColor: c.surfaceAlt, borderColor: c.border, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, flex: 1, gap: 8, minHeight: 166, padding: 12 },
  locationTitleRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  locationPin: { alignItems: 'center', borderRadius: 18, height: 36, justifyContent: 'center', width: 36 },
  locationTitleCopy: { flex: 1 },
  locationTitle: { color: c.textPrimary, fontSize: typography.body, fontWeight: '900' },
  lastKnown: { color: c.warning, fontSize: 8, fontWeight: '900', letterSpacing: 0.5, marginTop: 2 },
  locationAddress: { color: c.textPrimary, fontSize: typography.caption, fontWeight: '600', lineHeight: 18 },
  locationMetaRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  locationMeta: { color: c.textSecondary, flex: 1, fontSize: typography.caption, fontVariant: ['tabular-nums'] },
  mapAction: { alignItems: 'center', alignSelf: 'flex-start', flexDirection: 'row', gap: 5, paddingVertical: 4 },
  mapActionText: { fontSize: typography.caption, fontWeight: '800' },
  eventGroup: { gap: spacing.sm },
  eventHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  eventTitleRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  eventTitle: { color: c.textPrimary, fontSize: typography.body, fontWeight: '800' },
  countBadge: { borderRadius: radius.pill, minWidth: 30, paddingHorizontal: 9, paddingVertical: 4 },
  countText: { fontSize: typography.caption, fontWeight: '900', textAlign: 'center' },
  eventRow: { alignItems: 'flex-start', backgroundColor: c.surfaceAlt, borderRadius: radius.sm, flexDirection: 'row', gap: spacing.sm, padding: spacing.sm },
  eventIndex: { alignItems: 'center', borderRadius: 14, borderWidth: 1.5, height: 28, justifyContent: 'center', width: 28 },
  eventIndexText: { fontSize: 10, fontWeight: '900' },
  eventCopy: { flex: 1, gap: 3 },
  eventAddress: { color: c.textPrimary, fontSize: typography.caption, fontWeight: '700' },
  eventMeta: { color: c.textSecondary, fontSize: 10 },
  eventDuration: { color: c.textPrimary, fontSize: 11, fontVariant: ['tabular-nums'], fontWeight: '800' },
  inlineMap: { fontSize: 11, fontWeight: '800', paddingVertical: 2 },
  expandButton: { alignItems: 'center', alignSelf: 'center', flexDirection: 'row', gap: 3, padding: spacing.sm },
  expandText: { fontSize: typography.caption, fontWeight: '800' },
  sectionDivider: { backgroundColor: c.divider, height: StyleSheet.hairlineWidth, marginVertical: spacing.xs },
  activityRow: { gap: 6 },
  activityHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  activityNameRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  activityDot: { borderRadius: 5, height: 10, width: 10 },
  activityName: { color: c.textPrimary, fontSize: typography.caption, fontWeight: '800' },
  activityValue: { color: c.textSecondary, fontSize: typography.caption, fontVariant: ['tabular-nums'], fontWeight: '700' },
  progressTrack: { backgroundColor: c.surfaceAlt, borderRadius: radius.pill, height: 9, overflow: 'hidden' },
  progressFill: { borderRadius: radius.pill, height: 9 },
  emptyInline: { alignItems: 'center', backgroundColor: c.surfaceAlt, borderRadius: radius.md, flexDirection: 'row', gap: spacing.sm, padding: 12 },
  emptyInlineText: { color: c.textSecondary, flex: 1, fontSize: typography.caption, lineHeight: 18 },
  exportHint: { color: c.textSecondary, fontSize: typography.caption, lineHeight: 18 },
  exportRow: { gap: spacing.sm },
  exportRowDesktop: { flexDirection: 'row' },
  exportButton: { flex: 1 },
});
