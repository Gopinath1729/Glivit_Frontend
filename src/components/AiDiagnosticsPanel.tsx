import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/src/components/ui/Card';
import { ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { apiErrorMessage } from '@/src/services/apiError';
import { useGetAiDiagnosticsQuery } from '@/src/services/aiApi';
import { useAppSelector } from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography, type ThemeColors, hexToRgba } from '@/src/theme/tokens';

/**
 * AI stack diagnostics — SUPER_ADMIN only.
 *
 * The backend enforces the role; this component additionally hides itself for
 * other roles so the option never appears. The internal token is never returned
 * by the API, so it cannot be displayed here even by accident: only whether one
 * is configured, and whether it is still the development default.
 */
export function AiDiagnosticsPanel() {
  const { colors: c, stateColors } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const role = useAppSelector((s) => s.auth.user?.role);
  const isSuperAdmin = role === 'SUPER_ADMIN';

  const diagnostics = useGetAiDiagnosticsQuery(undefined, { skip: !isSuperAdmin });

  if (!isSuperAdmin) {
    return (
      <View style={styles.screen}>
        <Card style={styles.card}>
          <Text style={styles.title}>AI diagnostics</Text>
          <Text style={styles.muted}>
            AI diagnostics are restricted to platform administrators.
          </Text>
        </Card>
      </View>
    );
  }

  if (diagnostics.isLoading) return <LoadingView label="Checking AI services…" />;
  if (diagnostics.isError || !diagnostics.data) {
    return (
      <ErrorRetryView
        message={apiErrorMessage(diagnostics.error, 'Could not reach AI diagnostics.')}
        onRetry={diagnostics.refetch}
      />
    );
  }

  const d = diagnostics.data;
  const modeColor =
    d.mode === 'FULL_AI'
      ? stateColors.RUNNING
      : d.mode === 'DEGRADED'
        ? c.warningOrange
        : c.danger;

  const rows: { label: string; value: string; ok: boolean | null }[] = [
    { label: 'Python AI service', value: d.pythonService, ok: d.pythonService === 'UP' },
    { label: 'Ollama', value: d.ollama, ok: d.ollama === 'UP' },
    { label: 'Chat model', value: d.chatModel, ok: d.chatModel === 'AVAILABLE' },
    { label: 'Embedding model', value: d.embeddingModel, ok: d.embeddingModel === 'AVAILABLE' },
    {
      label: 'Circuit breaker',
      value: d.circuitBreakerOpen ? 'OPEN' : 'CLOSED',
      ok: !d.circuitBreakerOpen,
    },
    {
      label: 'Internal token',
      value: d.internalTokenIsDevelopmentDefault ? 'DEVELOPMENT DEFAULT' : 'CONFIGURED',
      ok: !d.internalTokenIsDevelopmentDefault,
    },
  ];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Card style={styles.card}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>AI stack</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Re-check AI services now"
            onPress={() => diagnostics.refetch()}
            style={styles.refreshBtn}>
            <MaterialCommunityIcons name="refresh" size={18} color={c.primary} />
          </Pressable>
        </View>
        <View style={[styles.modeBadge, { backgroundColor: hexToRgba(modeColor, 0.13), borderColor: hexToRgba(modeColor, 0.33) }]}>
          <Text style={[styles.modeText, { color: modeColor }]}>{d.mode}</Text>
        </View>
        {d.mode !== 'FULL_AI' && (
          <Text style={styles.muted}>
            {d.mode === 'DEGRADED'
              ? 'Rule-based results are being served. GPS ingestion, tracking and alerts are unaffected.'
              : 'The AI service is unreachable. GPS ingestion, tracking and alerts are unaffected.'}
          </Text>
        )}
        {d.message ? <Text style={styles.muted}>{d.message}</Text> : null}
        {d.errorCode ? <Text style={styles.errorCode}>Error code: {d.errorCode}</Text> : null}
      </Card>

      <Card style={styles.card}>
        {rows.map((row) => (
          <View key={row.label} style={styles.row}>
            <Text style={styles.rowLabel}>{row.label}</Text>
            <View style={styles.rowRight}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: row.ok ? stateColors.RUNNING : c.danger },
                ]}
              />
              <Text style={styles.rowValue}>{row.value}</Text>
            </View>
          </View>
        ))}
      </Card>

      <Card style={styles.card}>
        <Text style={styles.title}>Configuration</Text>
        <Detail styles={styles} label="AI service URL" value={d.pythonServiceUrl} />
        <Detail styles={styles} label="Ollama URL" value={d.ollamaBaseUrl} />
        <Detail styles={styles} label="Chat model" value={d.configuredChatModel} />
        <Detail styles={styles} label="Embedding model" value={d.configuredEmbeddingModel} />
        <Detail styles={styles} label="Probe duration" value={`${d.probeDurationMs} ms`} />
        <Detail styles={styles} label="Last checked" value={formatTime(d.lastCheckedAt)} />
      </Card>

      <Card style={styles.card}>
        <Text style={styles.title}>Anomaly evaluation queue</Text>
        {Object.entries(d.evaluationQueue ?? {}).map(([key, value]) => (
          <Detail key={key} styles={styles} label={humanise(key)} value={String(value)} />
        ))}
        <Text style={styles.muted}>
          Dropped or coalesced evaluations mean the queue shed load. GPS positions are
          still stored — only anomaly scoring is skipped.
        </Text>
      </Card>
    </ScrollView>
  );
}

function Detail({
  styles,
  label,
  value,
}: {
  styles: ReturnType<typeof makeStyles>;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function humanise(key: string) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (ch) => ch.toUpperCase());
}

function formatTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    content: { gap: spacing.sm, padding: spacing.md },
    card: { gap: spacing.sm },
    headerRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    refreshBtn: { padding: spacing.xs },
    title: { color: c.textPrimary, fontSize: typography.title, fontWeight: '900' },
    modeBadge: {
      alignSelf: 'flex-start',
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth * 2,
      paddingHorizontal: spacing.md,
      paddingVertical: 4,
    },
    modeText: { fontSize: typography.label, fontWeight: '800' },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'space-between',
    },
    rowRight: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
    rowLabel: { color: c.textSecondary, fontSize: typography.label },
    rowValue: { color: c.textPrimary, fontSize: typography.label, fontWeight: '700' },
    dot: { borderRadius: 4, height: 8, width: 8 },
    muted: { color: c.textMuted, fontSize: typography.caption, lineHeight: 17 },
    errorCode: { color: c.danger, fontSize: typography.caption, fontWeight: '700' },
  });
