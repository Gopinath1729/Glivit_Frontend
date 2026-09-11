import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import { Circle, G, Path, Svg, Text as SvgText } from 'react-native-svg';
import React from 'react';
import {
  ActivityIndicator,
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
import { useAppDialog } from '@/src/components/ui/useAppDialog';
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

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const PERIODS: { label: string; value: ReportPeriod }[] = [
  { label: 'Daily', value: 'DAILY' },
  { label: 'Weekly', value: 'WEEKLY' },
  { label: 'Monthly', value: 'MONTHLY' },
];

/**
 * Everything the summary reports, as one uniform grid.
 *
 * <p>Two tiles were drawn large and six small, on the theory that distance and
 * top speed are what the page is opened for. That is true of some visits and
 * wrong for the rest - somebody checking utilisation wants running against
 * idle, and somebody checking a driver wants average against maximum - and the
 * split made the pairs that need comparing different sizes. They are equals
 * now; `tone` carries the colour that ties each one to its arc in the donut
 * below, which is what actually helps the eye group them.
 */
const SUMMARY_ITEMS: {
  key: keyof VehicleActivityReport['summary'];
  label: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  format: (value: number) => string;
  tone?: 'running' | 'idle' | 'stopped' | 'offline' | 'alert';
}[] = [
  {
    key: 'totalDistanceKm',
    label: 'Distance',
    icon: 'map-marker-distance',
    format: (v) => `${v.toFixed(1)} km`,
  },
  { key: 'trips', label: 'Trips', icon: 'road-variant', format: (v) => String(Math.round(v)) },
  {
    key: 'runningSeconds',
    label: 'Running time',
    icon: 'car-cruise-control',
    format: compactDuration,
    tone: 'running',
  },
  {
    key: 'idleSeconds',
    label: 'Idle time',
    icon: 'engine-outline',
    format: compactDuration,
    tone: 'idle',
  },
  {
    key: 'stoppedSeconds',
    label: 'Stopped time',
    icon: 'stop-circle-outline',
    format: compactDuration,
    tone: 'stopped',
  },
  {
    key: 'offlineSeconds',
    label: 'Offline time',
    icon: 'signal-off',
    format: compactDuration,
    tone: 'offline',
  },
  {
    key: 'averageSpeedKmh',
    label: 'Average speed',
    icon: 'gauge',
    format: (v) => `${v.toFixed(1)} km/h`,
  },
  {
    key: 'maximumSpeedKmh',
    label: 'Maximum speed',
    icon: 'speedometer',
    format: (v) => `${v.toFixed(1)} km/h`,
  },
];

/**
 * A metric's text, or a dash when the server did not send it.
 *
 * <p>`trips` is newer than some deployed backends, and `Number(undefined)` is
 * `NaN` - which formats as "NaN" and reads as a broken report rather than a
 * field this server does not publish yet. An em dash says the difference.
 */
function metricValue(
  item: (typeof SUMMARY_ITEMS)[number],
  summary: VehicleActivityReport['summary']
): string {
  const raw = Number(summary[item.key]);
  return Number.isFinite(raw) ? item.format(raw) : '—';
}

function toneColor(tone: string | undefined, c: ThemeColors): string {
  switch (tone) {
    case 'running':
      return c.success;
    case 'idle':
      return c.warning;
    case 'stopped':
      return c.danger;
    case 'alert':
      return c.danger;
    case 'offline':
      return c.textMuted;
    default:
      return c.primary;
  }
}

/**
 * Identity of a filter selection, used to tell "applied" from "edited since".
 *
 * <p>Built from the calendar days the user picked, never from a computed
 * instant. It used to end the range with `endOfSelectedDay`, which returns
 * `new Date()` whenever the chosen day is today - so the signature of an
 * unchanged selection differed every time it was evaluated, the applied and
 * current signatures could never match, and the export buttons were
 * unreachable for the default range.
 */
function filterSignature(
  deviceId: number | undefined,
  from: Date,
  to: Date,
  period: ReportPeriod
): string {
  return [deviceId ?? 'none', dayKey(from), dayKey(to), period].join('|');
}

/** Local calendar day, stable regardless of the time of day inside the Date. */
function dayKey(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-');
}

type AppliedFilters = ActivityReportArgs;

export default function ReportsScreen() {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const compact = width < 720;
  const scrollRef = React.useRef<ScrollView>(null);

  /**
   * Re-validated every time this tab is entered.
   *
   * <p>This is the only screen that asks for the device list with no
   * arguments, so it owns a cache entry of its own - separate from the one the
   * Vehicles tab fills. Nothing was subscribed to it while the fleet changed,
   * so re-entering Reports was served the empty array it had cached from
   * before the vehicle existed, and the screen said "No vehicles available"
   * about a vehicle visible one tab away. That state was also terminal: it
   * renders before the scroll view, so there was no pull-to-refresh and no
   * retry, and only restarting the app cleared it.
   */
  const devices = useGetAllDevicesQuery(undefined, { refetchOnMountOrArgChange: true });
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
  const { confirm, dialogElement, notify } = useAppDialog();

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

  // First vehicle is selected and applied automatically, and the signature is
  // recorded with it - otherwise the very first report on screen counted as
  // "never applied" and offered no export until the user pressed a filter
  // button that would change nothing.
  React.useEffect(() => {
    if (selectedDeviceId != null || deviceOptions.length === 0) return;
    const first = deviceOptions[0].id;
    setSelectedDeviceId(first);
    setApplied(toArgs(first, fromDate, toDate, period));
    setAppliedSignature(filterSignature(first, fromDate, toDate, period));
  }, [deviceOptions, fromDate, period, selectedDeviceId, toDate]);

  // `applied` already carries the period it was applied with. Overriding it
  // here with the live control made the request and the recorded selection
  // disagree, so the chart could be rebuilt for a granularity the rest of the
  // page had never been told about.
  const reportArgs = applied;
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

  /**
   * Trend granularity re-applies immediately.
   *
   * It only re-buckets a window that is already chosen, so making the user
   * press Apply for it would be ceremony - but it does change the exported
   * file, so it has to move the applied filter and its signature together.
   */
  const changePeriod = React.useCallback(
    (next: ReportPeriod) => {
      setPeriod(next);
      if (selectedDeviceId == null) return;
      setApplied(toArgs(selectedDeviceId, fromDate, toDate, next));
      setAppliedSignature(filterSignature(selectedDeviceId, fromDate, toDate, next));
    },
    [fromDate, selectedDeviceId, toDate]
  );

  const applyFilters = React.useCallback(() => {
    if (selectedDeviceId == null) {
      notify({
        message: 'Choose a vehicle before applying the report filter.',
        title: 'Select a vehicle',
        tone: 'info',
      });
      return;
    }
    if (startOfDay(fromDate).getTime() > startOfDay(toDate).getTime()) {
      notify({
        message: 'From Date must be before or equal to To Date.',
        title: 'Invalid date range',
        tone: 'danger',
      });
      return;
    }
    setShowAllStops(false);
    setShowAllIdle(false);
    setShowAllOverspeed(false);
    setApplied(toArgs(selectedDeviceId, fromDate, toDate, period));
    setAppliedSignature(filterSignature(selectedDeviceId, fromDate, toDate, period));
  }, [fromDate, notify, period, selectedDeviceId, toDate]);

  const download = React.useCallback(
    async (format: 'PDF' | 'EXCEL') => {
      if (!reportArgs || exportFormat) return;
      setExportFormat(format);
      try {
        const payload = await exportReport({ ...reportArgs, format }).unwrap();
        const saved = await saveReportFile(payload, reportArgs.deviceId, format);
        // The file is already written. Opening it is the operator's choice, and
        // the share sheet is also how the file reaches Downloads or Drive if
        // that is where they want it.
        if (saved.uri && (await Sharing.isAvailableAsync())) {
          confirm({
            cancelLabel: 'Done',
            confirmLabel: 'Open',
            message: `${saved.fileName} was saved to ${saved.location}.`,
            onConfirm: () =>
              Sharing.shareAsync(saved.uri as string, {
                dialogTitle: saved.fileName,
                mimeType: format === 'PDF' ? 'application/pdf' : EXCEL_MIME,
              }),
            title: 'Report downloaded',
            tone: 'success',
          });
          return;
        }
        notify({
          message: `${saved.fileName} was saved to ${saved.location}.`,
          title: 'Report downloaded',
          tone: 'success',
        });
      } catch (error) {
        if (!isFilePickerCancellation(error)) {
          notify({
            message: apiErrorMessage(error, 'Unable to export this report.'),
            title: 'Export failed',
            tone: 'danger',
          });
        }
      } finally {
        setExportFormat(null);
      }
    },
    [confirm, exportFormat, exportReport, notify, reportArgs]
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
    // Offered a retry rather than only an explanation: an empty fleet and a
    // list that failed to refresh look identical from here, and one of them
    // is fixed by asking again.
    return (
      <PageState
        icon="car-off"
        label="No vehicles available. Add a vehicle before creating an activity report."
        onRetry={devices.refetch}
        styles={styles}
      />
    );
  }

  const data = report.data;
  const selectedVehicleLabel =
    deviceOptions.find((option) => option.id === selectedDeviceId)?.label ?? 'Select vehicle';

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
        {/* The app bar already says "Reports". This row spends its space on the
            selection instead, so the filters can stay collapsed while still
            telling the operator what they are looking at. */}
        <Pressable
          accessibilityHint="Opens the vehicle and date range filters"
          accessibilityLabel="Report filters"
          accessibilityRole="button"
          onPress={() => {
            setFilterOpen((value) => !value);
            scrollRef.current?.scrollTo({ animated: true, y: 0 });
          }}
          style={[styles.filterBar, filterOpen && styles.filterBarOpen]}>
          <View style={styles.filterBarIcon}>
            <MaterialCommunityIcons color={c.primary} name="filter-variant" size={19} />
          </View>
          <View style={styles.filterBarCopy}>
            <Text numberOfLines={1} style={styles.filterBarTitle}>
              {selectedVehicleLabel}
            </Text>
            <Text numberOfLines={1} style={styles.filterBarMeta}>
              {`${dayKey(fromDate)} → ${dayKey(toDate)} · ${period.toLowerCase()}`}
            </Text>
          </View>
          <MaterialCommunityIcons
            color={c.textMuted}
            name={filterOpen ? 'chevron-up' : 'chevron-down'}
            size={20}
          />
        </Pressable>

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
              <View style={styles.metricGrid}>
                {SUMMARY_ITEMS.map((item) => {
                  const tint = toneColor(item.tone, c);
                  return (
                    <View
                      key={item.key}
                      style={[
                        styles.metricCard,
                        compact ? styles.metricCardCompact : styles.metricCardWide,
                      ]}>
                      <View style={[styles.metricIcon, { backgroundColor: `${tint}1A` }]}>
                        <MaterialCommunityIcons color={tint} name={item.icon} size={16} />
                      </View>
                      <Text numberOfLines={1} style={styles.metricLabel}>
                        {item.label}
                      </Text>
                      <Text adjustsFontSizeToFit numberOfLines={1} style={styles.metricValue}>
                        {metricValue(item, data.summary)}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </ReportSection>

            <ReportSection title="Distance trend" icon="chart-bar" styles={styles} color={c.primary}>
              <View style={styles.periodRow}>
                {PERIODS.map((item) => (
                  <Pressable
                    key={item.value}
                    onPress={() => changePeriod(item.value)}
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
              <ActivityDonut compact={compact} items={data.activitySummary} styles={styles} />
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

      {dialogElement}
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

/**
 * How the window was spent.
 *
 * <p>One shape whose parts are the whole period, because that is the question
 * this section answers - what the vehicle's time was made of. Four stacked
 * progress bars could tell you idle was thirty hours but not that it was a
 * fifth of the month, and bars on separate rows share no baseline, so
 * comparing two of them meant reading two numbers instead of looking at a
 * picture.
 *
 * <p>Each figure appears exactly once in the place it reads best: the share on
 * its own arc, the duration in the legend beside it, and the period total in
 * the hole in the middle - which is the number every other one is a fraction
 * of, and the only one with nowhere else to go.
 *
 * <p>Drawn with arc paths rather than a chart library: four segments needs no
 * axes, no scales and no layout engine.
 */
function ActivityDonut({
  compact,
  items,
  styles,
}: {
  compact: boolean;
  items: VehicleActivityReport['activitySummary'];
  styles: ReturnType<typeof makeStyles>;
}) {
  const { colors: c } = useTheme();
  const size = compact ? 190 : 210;
  const stroke = compact ? 34 : 38;
  const radius = (size - stroke) / 2;
  const centre = size / 2;

  const totalSeconds = items.reduce((sum, item) => sum + Math.max(0, item.durationSeconds), 0);

  if (totalSeconds <= 0) {
    return <Text style={styles.emptyInlineText}>No activity recorded for this period.</Text>;
  }

  // Laid out from 12 o'clock, clockwise, in the fixed order the legend lists
  // them - so the same status is always in the same place across two different
  // vehicles' reports.
  let cursor = 0;
  const segments = items.map((item) => {
    const share = Math.max(0, item.durationSeconds) / totalSeconds;
    const start = cursor;
    cursor += share;
    return { ...item, color: activityColor(item.status, c), share, start };
  });

  return (
    <View style={styles.donutWrap}>
      <View style={styles.donutStage}>
        <Svg height={size} width={size}>
          <G rotation={-90} origin={`${centre}, ${centre}`}>
            {/* A track behind the arcs keeps the ring closed where rounding
                leaves a hairline between two segments. */}
            <Circle
              cx={centre}
              cy={centre}
              fill="none"
              r={radius}
              stroke={c.surfaceAlt}
              strokeWidth={stroke}
            />
            {segments
              .filter((segment) => segment.share > 0)
              .map((segment) => (
                <Path
                  d={arcPath(centre, radius, segment.start, segment.start + segment.share)}
                  fill="none"
                  key={segment.status}
                  stroke={segment.color}
                  strokeWidth={stroke}
                />
              ))}
          </G>
          {/* Labelled on the arc itself, but only where the slice is wide
              enough to hold the text - a 0.4% sliver cannot, and printing it
              anyway is how three labels end up stacked on one edge. */}
          {segments
            .filter((segment) => segment.share >= 0.06)
            .map((segment) => {
              const mid = segment.start + segment.share / 2;
              const angle = mid * 2 * Math.PI - Math.PI / 2;
              return (
                <SvgText
                  fill="#FFFFFF"
                  fontSize={compact ? 12 : 13}
                  fontWeight="900"
                  key={`label-${segment.status}`}
                  textAnchor="middle"
                  x={centre + radius * Math.cos(angle)}
                  y={centre + radius * Math.sin(angle) + (compact ? 4 : 5)}>
                  {`${Math.round(segment.percentage)}%`}
                </SvgText>
              );
            })}
        </Svg>
        <View pointerEvents="none" style={styles.donutCentre}>
          <Text adjustsFontSizeToFit numberOfLines={1} style={styles.donutValue}>
            {compactDuration(totalSeconds)}
          </Text>
          <Text style={styles.donutCaption}>Total time</Text>
        </View>
      </View>

      <View style={styles.donutLegend}>
        {items.map((item) => (
          <View key={item.status} style={styles.legendRow}>
            <View style={[styles.legendDot, { backgroundColor: activityColor(item.status, c) }]} />
            <View style={styles.legendCopy}>
              <Text numberOfLines={2} style={styles.legendName}>
                {statusLabel(item.status)}
              </Text>
              <Text numberOfLines={1} style={styles.legendDuration}>
                {compactDuration(item.durationSeconds)}
              </Text>
            </View>
            <Text style={styles.legendPercent}>{item.percentage.toFixed(0)}%</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The label the operator reads, which is not always the wire value. */
function statusLabel(status: string): string {
  return status === 'OFFLINE' ? 'Offline / Not reporting' : prettyState(status);
}

/**
 * `104h 10m` — the form these durations are read in.
 *
 * A month of offline time is 158 hours, and `158:16:19` makes the reader parse
 * a clock to find that out. Seconds are dropped above a minute because nothing
 * here is decided on them.
 */
function compactDuration(raw: number): string {
  const seconds = Math.max(0, Math.round(raw));
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * An SVG arc between two fractions of a full turn.
 *
 * A full-circle segment is drawn as two half arcs, because an arc whose start
 * and end points coincide is a zero-length path and renders as nothing - which
 * is exactly the case for a vehicle that was offline for the whole window.
 */
function arcPath(centre: number, radius: number, from: number, to: number): string {
  const span = Math.min(1, Math.max(0, to - from));
  if (span >= 0.9999) {
    const top = `${centre} ${centre - radius}`;
    const bottom = `${centre} ${centre + radius}`;
    return `M ${top} A ${radius} ${radius} 0 1 1 ${bottom} A ${radius} ${radius} 0 1 1 ${top}`;
  }
  const startAngle = from * 2 * Math.PI;
  const endAngle = (from + span) * 2 * Math.PI;
  const x1 = centre + radius * Math.cos(startAngle);
  const y1 = centre + radius * Math.sin(startAngle);
  const x2 = centre + radius * Math.cos(endAngle);
  const y2 = centre + radius * Math.sin(endAngle);
  const largeArc = span > 0.5 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`;
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
  filterBar: {
    alignItems: 'center',
    backgroundColor: c.surface,
    borderColor: c.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  filterBarOpen: { borderColor: c.primary },
  filterBarIcon: {
    alignItems: 'center',
    backgroundColor: c.accentSoft,
    borderRadius: 9,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  filterBarCopy: { flex: 1, minWidth: 0 },
  filterBarTitle: { color: c.textPrimary, fontSize: 14, fontWeight: '800' },
  filterBarMeta: { color: c.textMuted, fontSize: 11, marginTop: 1 },
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
  donutWrap: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'center',
  },
  donutStage: { alignItems: 'center', justifyContent: 'center', position: 'relative' },
  donutCentre: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  donutValue: {
    color: c.textPrimary,
    fontSize: 22,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
    letterSpacing: -0.6,
    maxWidth: '58%',
  },
  donutCaption: { color: c.textMuted, fontSize: 10.5, fontWeight: '700', marginTop: 1 },
  donutLegend: { flex: 1, gap: 6, minWidth: 0 },
  legendRow: {
    alignItems: 'center',
    backgroundColor: c.surfaceAlt,
    borderRadius: radius.sm,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  legendDot: { borderRadius: 5, height: 10, width: 10 },
  legendCopy: { flex: 1, minWidth: 0 },
  legendName: { color: c.textPrimary, fontSize: 12, fontWeight: '800', lineHeight: 15 },
  legendDuration: {
    color: c.textMuted,
    fontSize: 10.5,
    fontVariant: ['tabular-nums'],
    marginTop: 1,
  },
  legendPercent: {
    color: c.textPrimary,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
  },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  metricCard: {
    backgroundColor: c.surfaceAlt,
    borderColor: c.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 5,
    padding: 11,
  },
  metricCardCompact: { flexBasis: '47%', flexGrow: 1 },
  metricCardWide: { flexBasis: '22%', flexGrow: 1 },
  metricIcon: {
    alignItems: 'center',
    borderRadius: 9,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  metricLabel: { color: c.textSecondary, fontSize: 11, fontWeight: '700' },
  metricValue: {
    color: c.textPrimary,
    fontSize: 17,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
    letterSpacing: -0.3,
  },
  /** A colour key that ties each figure to its bar in Activity summary. */
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
  emptyInlineText: { color: c.textSecondary, flex: 1, fontSize: typography.caption, lineHeight: 18 },
  exportHint: { color: c.textSecondary, fontSize: typography.caption, lineHeight: 18 },
  exportRow: { gap: spacing.sm },
  exportRowDesktop: { flexDirection: 'row' },
  exportButton: { flex: 1 },
});
