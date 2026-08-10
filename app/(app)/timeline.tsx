import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PieChart, BarChart } from 'react-native-gifted-charts';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Card } from '@/src/components/ui/Card';
import { DateRangePicker, type DateRange } from '@/src/components/ui/DateRangePicker';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors } from '@/src/theme/tokens';
import { useAppSelector } from '@/src/store/hooks';

export default function TimelineAnalyticsScreen() {
  const { colors: c, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(c), [c]);
  const activeTenantName = useAppSelector((s) => s.tenant.activeTenantName);

  const today = new Date();
  const last7Start = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
  last7Start.setHours(0, 0, 0, 0);

  const [dateRange, setDateRange] = useState<DateRange>({
    label: 'Last 7 Days',
    startDate: last7Start,
    endDate: today,
  });

  // Calculate day difference for mock data scaling
  const daysDiff = Math.max(1, Math.ceil((dateRange.endDate.getTime() - dateRange.startDate.getTime()) / (1000 * 60 * 60 * 24)));

  // Mock data scaling factors based on duration
  const totalDistance = Math.round(daysDiff * 142.5);
  const drivingHours = Math.round(daysDiff * 4.2);
  const idleHours = Math.round(daysDiff * 1.5);
  const stoppedHours = Math.round(daysDiff * 17.5);
  const offlineHours = Math.round(daysDiff * 0.8);
  const totalTrips = Math.round(daysDiff * 3.4);
  const avgSpeed = 48; // Constant representation
  const maxSpeed = 104; // Constant representation

  // Pie chart data showing percentage values on the segments
  const pieData = useMemo(() => {
    const total = drivingHours + idleHours + stoppedHours + offlineHours || 1;
    const drivingPct = Math.round((drivingHours / total) * 100);
    const idlePct = Math.round((idleHours / total) * 100);
    const stoppedPct = Math.round((stoppedHours / total) * 100);
    const offlinePct = 100 - (drivingPct + idlePct + stoppedPct);

    return [
      { value: drivingPct, color: c.success, text: `${drivingPct}%` },
      { value: idlePct, color: c.warningOrange, text: `${idlePct}%` },
      { value: stoppedPct, color: c.danger, text: `${stoppedPct}%` },
      { value: offlinePct, color: c.textMuted, text: `${offlinePct}%` },
    ];
  }, [drivingHours, idleHours, stoppedHours, offlineHours, c]);

  // Bar chart data for daily distance travelled in KM
  const barData = useMemo(() => {
    const data = [];
    let currentDate = new Date(dateRange.startDate);
    
    // Limit to max 7 bars for clear readability, or sample if range is larger
    const displayDays = Math.min(daysDiff, 7);
    const step = Math.max(1, Math.floor(daysDiff / displayDays));
    
    for (let i = 0; i < displayDays; i++) {
      const distance = Math.floor(Math.random() * 80) + 70; // Random 70-150 KM
      data.push({
        value: distance,
        label: currentDate.toLocaleDateString(undefined, { weekday: 'short' }),
        topLabelComponent: () => (
          <Text style={styles.barTopLabel}>{distance}</Text>
        ),
        frontColor: c.primaryGreen,
        dateStr: currentDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        trips: Math.floor(Math.random() * 3) + 2,
      });
      currentDate.setDate(currentDate.getDate() + step);
    }
    return data;
  }, [daysDiff, dateRange.startDate, c, styles.barTopLabel]);

  const renderTooltip = (item: any) => {
    return (
      <View style={styles.tooltip}>
        <Text style={styles.tooltipTitle}>{item.dateStr}</Text>
        <Text style={styles.tooltipText}>{item.value} KM</Text>
        <Text style={styles.tooltipSubText}>{item.trips} Trips</Text>
      </View>
    );
  };

  return (
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]} style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Timeline Analytics</Text>
        <Text style={styles.subtitle}>{activeTenantName || 'Glivt Fleet'}</Text>
      </View>

      {/* Date Picker Card */}
      <Card style={styles.card}>
        <DateRangePicker value={dateRange} onChange={setDateRange} />
      </Card>

      {/* Summary Statistic Cards */}
      <View style={styles.statsGrid}>
        <StatCard icon="chevron-triple-right" title="Total Distance" value={`${totalDistance} KM`} color={c.primary} />
        <StatCard icon="steering" title="Driving Time" value={`${drivingHours}h`} color={c.success} />
        <StatCard icon="engine-outline" title="Idle Time" value={`${idleHours}h`} color={c.warningOrange} />
        <StatCard icon="pause-circle-outline" title="Stopped Time" value={`${stoppedHours}h`} color={c.danger} />
        <StatCard icon="wifi-off" title="Offline Time" value={`${offlineHours}h`} color={c.textMuted} />
        <StatCard icon="speedometer" title="Avg Speed" value={`${avgSpeed} km/h`} color={c.primary} />
        <StatCard icon="speedometer-red" title="Max Speed" value={`${maxSpeed} km/h`} color={c.danger} />
        <StatCard icon="map-marker-distance" title="Total Trips" value={`${totalTrips}`} color={c.success} />
      </View>

      {/* Vehicle Time Distribution Donut Chart */}
      <Card style={styles.card}>
        <Text style={styles.cardTitle}>Vehicle Time Distribution</Text>
        <Text style={styles.cardSubtitle}>Activity allocation across selected timeline</Text>
        
        <View style={styles.chartContainer}>
          <PieChart
            data={pieData}
            donut
            innerRadius={60}
            radius={100}
            showText
            textColor="#FFFFFF"
            textSize={11}
            fontWeight="bold"
            centerLabelComponent={() => (
              <View style={styles.centerLabel}>
                <Text style={styles.centerLabelValue}>{daysDiff * 24}h</Text>
                <Text style={styles.centerLabelText}>Total Duration</Text>
              </View>
            )}
          />
        </View>

        <View style={styles.legendContainer}>
          <LegendItem color={c.success} label="Driving" percentage={`${Math.round((drivingHours / (daysDiff * 24)) * 100)}%`} duration={`${drivingHours}h`} />
          <LegendItem color={c.warningOrange} label="Idle" percentage={`${Math.round((idleHours / (daysDiff * 24)) * 100)}%`} duration={`${idleHours}h`} />
          <LegendItem color={c.danger} label="Stopped" percentage={`${Math.round((stoppedHours / (daysDiff * 24)) * 100)}%`} duration={`${stoppedHours}h`} />
          <LegendItem color={c.textMuted} label="Offline" percentage={`${Math.round((offlineHours / (daysDiff * 24)) * 100)}%`} duration={`${offlineHours}h`} />
        </View>
      </Card>

      {/* Daily Distance Travelled Bar Chart */}
      <Card style={styles.card}>
        <Text style={styles.cardTitle}>Daily Distance Travelled</Text>
        <Text style={styles.cardSubtitle}>Travelled distance in Kilometers (KM)</Text>
        
        <View style={styles.barChartContainer}>
          <BarChart
            data={barData}
            barWidth={32}
            spacing={20}
            roundedTop
            roundedBottom
            xAxisThickness={1}
            yAxisThickness={1}
            yAxisTextStyle={styles.axisText}
            xAxisLabelTextStyle={styles.axisText}
            noOfSections={4}
            maxValue={200}
            isAnimated
            rulesColor={c.divider}
            xAxisColor={c.borderStrong}
            yAxisColor={c.borderStrong}
            renderTooltip={renderTooltip}
            leftShiftForTooltip={10}
            yAxisLabelSuffix=" KM"
          />
        </View>
      </Card>
    </ScrollView>
  );
}

function StatCard({ icon, title, value, color }: { icon: string; title: string; value: string; color: string }) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);

  return (
    <View style={styles.statCard}>
      <View style={[styles.statIconContainer, { backgroundColor: `${color}15` }]}>
        <MaterialCommunityIcons name={icon as any} size={20} color={color} />
      </View>
      <View style={styles.statInfo}>
        <Text style={styles.statTitle}>{title}</Text>
        <Text style={styles.statValue}>{value}</Text>
      </View>
    </View>
  );
}

function LegendItem({ color, label, percentage, duration }: { color: string; label: string; percentage: string; duration: string }) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
      <Text style={styles.legendValue}>{percentage} ({duration})</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: c.pageBackground,
    },
    content: {
      padding: spacing.md,
      gap: spacing.md,
    },
    header: {
      marginBottom: spacing.xs,
    },
    title: {
      fontSize: typography.h2,
      fontWeight: '900',
      color: c.textPrimary,
    },
    subtitle: {
      fontSize: typography.body,
      color: c.textSecondary,
    },
    card: {
      gap: spacing.md,
      padding: spacing.lg,
      borderRadius: radius.lg,
    },
    cardTitle: {
      fontSize: typography.title,
      fontWeight: '800',
      color: c.textPrimary,
    },
    cardSubtitle: {
      fontSize: typography.caption,
      color: c.textSecondary,
      marginTop: -spacing.xs,
    },
    statsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      justifyContent: 'space-between',
    },
    statCard: {
      width: '48%',
      backgroundColor: c.surface,
      borderRadius: radius.md,
      padding: spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderWidth: 1,
      borderColor: c.border,
    },
    statIconContainer: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    statInfo: {
      flex: 1,
    },
    statTitle: {
      fontSize: 10,
      fontWeight: '700',
      color: c.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    statValue: {
      fontSize: 14,
      fontWeight: '800',
      color: c.textPrimary,
      marginTop: 2,
    },
    chartContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      marginVertical: spacing.md,
    },
    barChartContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      marginVertical: spacing.md,
      paddingRight: spacing.lg,
    },
    centerLabel: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    centerLabelValue: {
      fontSize: typography.title,
      fontWeight: '900',
      color: c.textPrimary,
    },
    centerLabelText: {
      fontSize: 9,
      color: c.textMuted,
      fontWeight: '700',
      textTransform: 'uppercase',
    },
    legendContainer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.md,
      marginTop: spacing.md,
      justifyContent: 'space-between',
    },
    legendItem: {
      flexDirection: 'row',
      alignItems: 'center',
      width: '46%',
      gap: spacing.xs + 2,
    },
    legendDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
    },
    legendLabel: {
      fontSize: typography.caption,
      fontWeight: '700',
      color: c.textPrimary,
      flex: 1,
    },
    legendValue: {
      fontSize: typography.caption,
      fontWeight: '600',
      color: c.textSecondary,
    },
    axisText: {
      color: c.textSecondary,
      fontSize: 9,
      fontWeight: '600',
    },
    barTopLabel: {
      color: c.textPrimary,
      fontSize: 9,
      fontWeight: '800',
      marginBottom: 4,
      textAlign: 'center',
    },
    tooltip: {
      backgroundColor: c.surfaceElevated,
      padding: spacing.sm,
      borderRadius: radius.md,
      shadowColor: c.shadowColor,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.15,
      shadowRadius: 8,
      elevation: 4,
      minWidth: 80,
    },
    tooltipTitle: {
      fontSize: 10,
      color: c.textSecondary,
      marginBottom: 2,
    },
    tooltipText: {
      fontSize: typography.body,
      fontWeight: '800',
      color: c.textPrimary,
    },
    tooltipSubText: {
      fontSize: 11,
      color: c.textMuted,
      marginTop: 2,
    },
  });
