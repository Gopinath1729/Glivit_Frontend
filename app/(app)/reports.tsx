import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Chip } from '@/src/components/ui/ModulePrimitives';
import { EmptyView, ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { apiErrorMessage } from '@/src/services/apiError';
import {
  useCreateReportMutation,
  useGetReportsQuery,
  useLazyGetReportContentQuery,
} from '@/src/services/operationsApi';
import { useGetAllDevicesQuery } from '@/src/services/devicesApi';
import { SearchableMultiSelect } from '@/src/components/ui/SearchableMultiSelect';
import type { DropdownOption } from '@/src/components/ui/SearchableDropdown';
import {
  isFilePickerCancellation,
  saveReportFile,
} from '@/src/services/reportFile';
import type { ReportDto } from '@/src/types/api';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';

const REPORT_TYPES = ['SUMMARY', 'ROUTE', 'STOPS', 'TRIPS', 'EVENTS', 'FUEL'];

export default function ReportsScreen() {
  const { colors: c } = useTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [reportType, setReportType] = React.useState('SUMMARY');
  const { data, isLoading, isFetching, isError, error, refetch } = useGetReportsQuery({ size: 50 });
  const { data: devices, isLoading: loadingDevices, refetch: refetchDevices } = useGetAllDevicesQuery();
  const [createReport, { isLoading: isCreating }] = useCreateReportMutation();
  const [getContent] = useLazyGetReportContentQuery();
  const downloadingRef = React.useRef<number | null>(null);
  const [downloadingId, setDownloadingId] = React.useState<number | null>(null);
  const [selectedDeviceIds, setSelectedDeviceIds] = React.useState<number[]>([]);

  const deviceList = React.useMemo(() => devices ?? [], [devices]);

  const dropdownOptions: DropdownOption[] = React.useMemo(() => {
    return deviceList.map((device) => {
      const label = device.vehicleName ? `${device.name} (${device.vehicleName})` : device.name;
      const subLabel = device.driverName ? `Driver: ${device.driverName}` : undefined;
      const searchTags = [device.name, device.vehicleName, device.driverName, device.imei].filter(Boolean) as string[];

      return {
        id: device.id,
        label,
        subLabel,
        dotColor: c.primary,
        searchTags,
      };
    });
  }, [deviceList, c.primary]);

  const refreshAll = React.useCallback(() => {
    void refetch();
    void refetchDevices();
  }, [refetch, refetchDevices]);

  const create = async () => {
    if (selectedDeviceIds.length === 0) {
      Alert.alert('Validation Error', 'Please select at least one vehicle to generate a report.');
      return;
    }
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    try {
      await createReport({
        reportType,
        fromTime: from.toISOString(),
        toTime: to.toISOString(),
        deviceIds: selectedDeviceIds,
        includeAddresses: true,
        includeMapMarkers: false,
        outputFormat: 'CSV',
      }).unwrap();
    } catch (err) {
      Alert.alert('Report not created', apiErrorMessage(err));
    }
  };

  const download = async (report: ReportDto) => {
    if (downloadingRef.current !== null) return;
    downloadingRef.current = report.id;
    setDownloadingId(report.id);
    try {
      const payload = await getContent(report.id).unwrap();
      const saved = await saveReportFile(payload, report.id);
      Alert.alert(
        'Report saved',
        `${saved.fileName} was saved in the folder you selected.`
      );
    } catch (err) {
      if (isFilePickerCancellation(err)) {
        Alert.alert('Download cancelled', 'No folder was selected.');
      } else {
        Alert.alert(
          'Download failed',
          apiErrorMessage(err, 'Unable to save the report. Select a writable folder and try again.')
        );
      }
    } finally {
      downloadingRef.current = null;
      setDownloadingId(null);
    }
  };

  if (isLoading || loadingDevices) return <LoadingView label="Loading reports..." />;
  if (isError || !data) return <ErrorRetryView message={apiErrorMessage(error)} onRetry={refreshAll} />;

  return (
    <View style={styles.screen}>
      <FlatList
        contentContainerStyle={styles.list}
        data={data.content}
        keyExtractor={(item) => String(item.id)}
        refreshControl={<RefreshControl refreshing={isFetching} onRefresh={refreshAll} tintColor={c.primary} />}
        ListHeaderComponent={
          <Card style={styles.generator}>
            <Text style={styles.title}>Generate Report</Text>
            <Text style={styles.subtitle}>Creates a backend job for the last 24 hours using tenant history limits.</Text>
            <SearchableMultiSelect
              label="Select Vehicles"
              placeholder="Search vehicle number, name, driver..."
              emptyText="No matching vehicles found"
              options={dropdownOptions}
              selectedIds={selectedDeviceIds}
              onSelectionChange={setSelectedDeviceIds}
            />
            <View style={styles.chips}>
              {REPORT_TYPES.map((type) => (
                <Chip key={type} active={type === reportType} label={format(type)} onPress={() => setReportType(type)} />
              ))}
            </View>
            <Button label="Generate CSV" loading={isCreating} onPress={create} />
          </Card>
        }
        ListEmptyComponent={<EmptyView icon="file-chart-outline" title="No reports" message="Generated reports will appear here." />}
        renderItem={({ item }) => {
          const downloading = downloadingId === item.id;
          const downloadDisabled = item.status !== 'COMPLETED' || downloadingId !== null;
          return (
            <View style={styles.reportCard}>
              <View style={styles.fileIcon}>
                <MaterialCommunityIcons color={c.info} name="file-delimited-outline" size={24} />
              </View>
              <View style={styles.reportBody}>
                <Text numberOfLines={1} style={styles.reportTitle}>
                  {format(item.reportType)}
                </Text>
                <Text style={styles.meta}>
                  {item.status} | {item.outputFormat} | {formatBytes(item.fileSize)}
                </Text>
                <Text style={styles.meta}>{formatTime(item.createdAt)}</Text>
              </View>
              <Pressable
                accessibilityLabel={`Download ${format(item.reportType)} report`}
                accessibilityRole="button"
                accessibilityState={{ busy: downloading, disabled: downloadDisabled }}
                disabled={downloadDisabled}
                onPress={() => void download(item)}
                style={({ pressed }) => [
                  styles.iconButton,
                  (pressed || downloadDisabled) && styles.iconButtonMuted,
                ]}>
                {downloading ? (
                  <ActivityIndicator color={c.primary} size="small" />
                ) : (
                  <MaterialCommunityIcons
                    color={item.status === 'COMPLETED' ? c.primary : c.textMuted}
                    name="download-outline"
                    size={22}
                  />
                )}
              </Pressable>
            </View>
          );
        }}
      />
    </View>
  );
}

function format(value: string) {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? 'No time'
    : date.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatBytes(value?: number | null) {
  if (!value) return '0 KB';
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    list: { gap: spacing.sm, padding: spacing.md },
    generator: { gap: spacing.md },
    title: { color: c.textPrimary, fontSize: typography.title, fontWeight: '900' },
    subtitle: { color: c.textSecondary, fontSize: typography.caption, lineHeight: 17 },
    chips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.divider,
      paddingBottom: 4,
    },
    reportCard: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderColor: c.border,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth * 2,
      flexDirection: 'row',
      gap: spacing.md,
      padding: spacing.md,
    },
    fileIcon: { alignItems: 'center', backgroundColor: 'rgba(37,99,235,0.12)', borderRadius: radius.sm, height: 42, justifyContent: 'center', width: 42 },
    reportBody: { flex: 1, minWidth: 0 },
    reportTitle: { color: c.textPrimary, fontSize: typography.body, fontWeight: '800' },
    meta: { color: c.textSecondary, fontSize: typography.caption, marginTop: 2 },
    iconButton: { alignItems: 'center', height: 40, justifyContent: 'center', width: 40 },
    iconButtonMuted: { opacity: 0.45 },
  });
