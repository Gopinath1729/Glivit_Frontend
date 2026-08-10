import { baseApi, unwrap } from './baseApi';
import type { ApiResponse, GeofenceDto, PageResponse } from '@/src/types/api';

// ---------------------------------------------------------------------------
// DTOs — these mirror the Spring Boot com.glivt.ai.dto.* records exactly.
// The frontend talks ONLY to Spring Boot (/api/ai/*); it never calls Python
// or Ollama directly. Every response is tenant-scoped server-side.
// ---------------------------------------------------------------------------

/** Where an AI answer came from. Surfaced in the UI — never hidden from users. */
export type AiSource = 'OLLAMA' | 'DETERMINISTIC' | 'RULE' | 'MODEL' | 'RULE+ML' | 'NONE';
/**
 * FULL_AI  — the model answered.
 * DIRECT   — answered straight from tenant data because that was faster and
 *            exact; a normal, complete answer, not a degradation.
 * DEGRADED — the model could not answer in time, so the data-based answer was
 *            served instead. Still a real answer; recorded for diagnostics.
 * UNAVAILABLE — nothing could be answered. The only mode the UI flags.
 */
export type AiMode = 'FULL_AI' | 'DIRECT' | 'DEGRADED' | 'UNAVAILABLE';
export type AiIncidentStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

export interface AiEventDto {
  id: number;
  tenantId: number;
  vehicleId?: number | null;
  vehicleName?: string | null;
  deviceId?: number | null;
  driverId?: number | null;
  driverName?: string | null;
  eventType: string;
  severity: string;
  status: AiIncidentStatus;
  /** How many times this incident has been observed (dedup, not row-per-packet). */
  occurrenceCount: number;
  score: number;
  latitude?: number | null;
  longitude?: number | null;
  speed?: number | null;
  /** Server-resolved limit and its provenance — never the device's own claim. */
  speedLimitKph?: number | null;
  speedLimitSource?: string | null;
  routeId?: number | null;
  distanceFromRouteMeters?: number | null;
  allowedDeviationMeters?: number | null;
  deviationPathJson?: string | null;
  reentryPointJson?: string | null;
  explanation?: string | null;
  evidenceJson?: string | null;
  relatedEventsJson?: string | null;
  aiSource?: string | null;
  acknowledged: boolean;
  acknowledgedBy?: number | null;
  acknowledgedAt?: string | null;
  incidentStartedAt?: string | null;
  lastObservedAt?: string | null;
  createdAt: string;
}

export interface AiDashboardSummaryDto {
  fleetHealthScore: number;
  totalActiveVehicles: number;
  unacknowledgedAiAlerts: number;
  criticalRiskVehicles: number;
  highRiskMaintenanceCount: number;
  riskyDriversCount: number;
  activeRouteDeviationsCount: number;
  recentCriticalEvents: AiEventDto[];
  executiveAiSummary: string;
}

export interface FeedbackRequestDto {
  aiEventId?: number | null;
  featureType: string;
  isCorrect: boolean;
  feedbackType?: string;
  comments?: string;
}

export interface EtaRequestDto {
  vehicleId: number;
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
  currentSpeedKph?: number;
}

export interface EtaResponseDto {
  vehicleId: number;
  estimatedDistanceKm: number;
  /** ROAD_ROUTE when a real routed distance was used. */
  distanceSource: 'ROAD_ROUTE' | 'STRAIGHT_LINE';
  estimatedDurationMinutes: number;
  predictedArrivalTime: string;
  trafficDelayMinutes: number;
  confidence: number;
  rangeMinutes: number;
  source: AiSource;
  mode: AiMode;
  calculatedAt: string;
  factors: Record<string, unknown>;
  structuredExplanation: string;
}

export interface ChatMessageDto {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  source?: AiSource;
  mode?: AiMode;
}

export interface EventChatContextDto {
  source: 'STANDARD' | 'AI';
  eventId: number;
  type: string;
  vehicle: string;
  deviceId: string;
  time: string;
  severity: string;
  location: string;
  description: string;
}

export interface ChatRequestDto {
  message: string;
  history?: ChatMessageDto[];
  eventContext?: EventChatContextDto;
  vehicleId?: number;
}

export interface ChatCitation {
  type: string;
  id?: number | null;
  label: string;
}

export interface ChatResponseDto {
  reply: string;
  source: AiSource;
  mode: AiMode;
  model: string;
  durationMs: number;
  fallbackReason: string | null;
  citations: ChatCitation[];
  suggestedActions: Record<string, unknown>[];
  promptVersion?: string | null;
  intent?: string | null;
  timestamp?: string;
}

export interface DriverScoreDto {
  id?: number | null;
  driverId: number;
  driverName: string;
  vehicleId?: number | null;
  scoreDate: string;
  scorePeriod: string;
  safetyScore: number;
  efficiencyScore: number;
  complianceScore: number;
  overallScore: number;
  grade: string;
  riskLevel: string;
  totalDistanceKm: number;
  totalDrivingMinutes: number;
  harshAccelCount: number;
  harshBrakeCount: number;
  sharpTurnCount: number;
  speedingSeconds: number;
  excessiveIdleMinutes: number;
  anomaliesCount: number;
  breakdownJson?: string | null;
  reasonsJson?: string | null;
  source: AiSource;
  modelVersion?: string | null;
  ruleVersion?: string | null;
  calculatedAt?: string | null;
  /** False when the driver has never been scored — show "not scored yet", not 100. */
  hasScore: boolean;
  aiCoachingAdvice: string;
}

export interface GeofenceSuggestionDto {
  id: number;
  suggestedName: string;
  centerLatitude: number;
  centerLongitude: number;
  suggestedRadiusMeters: number;
  clusterPointCount: number;
  visitCount: number;
  averageStopMinutes: number;
  firstVisitAt?: string | null;
  lastVisitAt?: string | null;
  confidence: number;
  reasoning?: string | null;
  polygonJson?: string | null;
  status: string;
}

export interface RankedVehicleDto {
  vehicleId: number;
  name: string;
  matchScore: number;
  distanceToOriginKm: number;
  distanceSource: 'ROAD_ROUTE' | 'STRAIGHT_LINE';
  etaToOriginMinutes: number;
  rank: number;
  eligible: boolean;
  reasons: string[];
}

export interface DispatchRecommendRequestDto {
  jobDescription: string;
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
  requiredCategory?: string;
  candidateVehicleIds?: number[];
}

export interface DispatchRecommendResponseDto {
  rankedVehicles: RankedVehicleDto[];
  topRecommendationReason: string;
  source: AiSource;
  mode: AiMode;
  /** Always true — AI recommends, a human confirms. */
  requiresConfirmation: boolean;
}

export interface MaintenancePredictionDto {
  id: number;
  vehicleId: number;
  vehicleName: string;
  riskScore: number;
  riskLevel: string;
  predictedComponent?: string | null;
  predictedFailureDate?: string | null;
  predictedDaysRemaining?: number | null;
  predictedKmRemaining?: number | null;
  odometerAtPrediction: number;
  engineHoursAtPrediction: number;
  batteryHealth: number;
  drivingStressFactor: number;
  recommendedActions: string[];
  reasoning?: string | null;
  componentsJson?: string | null;
  confidence?: number | null;
  /** RULE or MODEL — displayed so a rule result is never shown as a model one. */
  source: AiSource;
  modelVersion?: string | null;
  ruleVersion?: string | null;
  evaluatedAt?: string | null;
  status: string;
}

export interface AiSearchHit {
  id: string;
  recordType: string;
  recordId: number;
  vehicleId?: number | null;
  score: number;
  content: string;
  metadata: Record<string, unknown>;
  source: 'EMBEDDING' | 'KEYWORD_FALLBACK';
}

export interface AiDiagnosticsDto {
  pythonService: 'UP' | 'DOWN';
  ollama: 'UP' | 'DOWN' | 'UNKNOWN';
  chatModel: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
  embeddingModel: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
  mode: AiMode;
  errorCode?: string | null;
  message?: string | null;
  pythonServiceUrl: string;
  ollamaBaseUrl: string;
  configuredChatModel: string;
  configuredEmbeddingModel: string;
  internalTokenConfigured: boolean;
  internalTokenIsDevelopmentDefault: boolean;
  circuitBreakerOpen: boolean;
  evaluationQueue: Record<string, number>;
  probeDurationMs: number;
  lastCheckedAt: string;
}

export interface AiEventQuery {
  vehicleId?: number;
  severity?: string;
  eventType?: string;
  status?: AiIncidentStatus;
  page?: number;
  size?: number;
}

export const aiApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    getAiDashboardSummary: builder.query<AiDashboardSummaryDto, void>({
      query: () => '/ai/dashboard',
      transformResponse: (response: ApiResponse<AiDashboardSummaryDto>) => unwrap(response),
      providesTags: ['Dashboard'],
    }),
    getAiEvents: builder.query<PageResponse<AiEventDto>, AiEventQuery | void>({
      query: (params) => {
        const q = (params ?? {}) as AiEventQuery;
        return {
          url: '/ai/events',
          params: {
            ...(q.vehicleId != null ? { vehicleId: q.vehicleId } : {}),
            ...(q.severity ? { severity: q.severity } : {}),
            ...(q.eventType ? { eventType: q.eventType } : {}),
            ...(q.status ? { status: q.status } : {}),
            page: q.page ?? 0,
            size: q.size ?? 20,
          },
        };
      },
      transformResponse: (response: ApiResponse<PageResponse<AiEventDto>>) => unwrap(response),
      providesTags: ['Event'],
    }),
    acknowledgeAiEvent: builder.mutation<AiEventDto, number>({
      query: (id) => ({ url: `/ai/events/${id}/acknowledge`, method: 'POST' }),
      transformResponse: (response: ApiResponse<AiEventDto>) => unwrap(response),
      invalidatesTags: ['Event', 'Dashboard'],
    }),
    resolveAiEvent: builder.mutation<AiEventDto, number>({
      query: (id) => ({ url: `/ai/events/${id}/resolve`, method: 'POST' }),
      transformResponse: (response: ApiResponse<AiEventDto>) => unwrap(response),
      invalidatesTags: ['Event', 'Dashboard'],
    }),
    submitAiFeedback: builder.mutation<void, FeedbackRequestDto>({
      query: (body) => ({ url: '/ai/feedback', method: 'POST', body }),
      invalidatesTags: ['Event'],
    }),
    sendChatMessage: builder.mutation<ChatResponseDto, ChatRequestDto>({
      query: (body) => ({ url: '/ai/chat', method: 'POST', body }),
      transformResponse: (response: ApiResponse<ChatResponseDto>) => unwrap(response),
    }),
    // ETA is a user-triggered POST, so it is a mutation rather than an unused
    // read query — the previous query form was never invoked by any screen.
    predictEta: builder.mutation<EtaResponseDto, EtaRequestDto>({
      query: (body) => ({ url: '/ai/predict/eta', method: 'POST', body }),
      transformResponse: (response: ApiResponse<EtaResponseDto>) => unwrap(response),
    }),
    getDriverScores: builder.query<DriverScoreDto[], void>({
      query: () => '/ai/scoring/drivers',
      transformResponse: (response: ApiResponse<DriverScoreDto[]>) => unwrap(response),
      providesTags: ['Driver'],
    }),
    getDriverScore: builder.query<DriverScoreDto, number>({
      query: (driverId) => `/ai/scoring/driver/${driverId}`,
      transformResponse: (response: ApiResponse<DriverScoreDto>) => unwrap(response),
      providesTags: ['Driver'],
    }),
    getDriverScoreTrend: builder.query<DriverScoreDto[], { driverId: number; days?: number }>({
      query: ({ driverId, days }) => ({
        url: `/ai/scoring/driver/${driverId}/trend`,
        params: { days: days ?? 14 },
      }),
      transformResponse: (response: ApiResponse<DriverScoreDto[]>) => unwrap(response),
      providesTags: ['Driver'],
    }),
    getGeofenceSuggestions: builder.query<GeofenceSuggestionDto[], void>({
      query: () => '/ai/geofence/suggestions',
      transformResponse: (response: ApiResponse<GeofenceSuggestionDto[]>) => unwrap(response),
      providesTags: ['Geofence'],
    }),
    approveGeofenceSuggestion: builder.mutation<
      GeofenceDto,
      { id: number; name?: string; radiusMeters?: number }
    >({
      query: ({ id, name, radiusMeters }) => ({
        url: `/ai/geofence/suggestions/${id}/approve`,
        method: 'POST',
        params: {
          ...(name ? { name } : {}),
          ...(radiusMeters != null ? { radiusMeters } : {}),
        },
      }),
      transformResponse: (response: ApiResponse<GeofenceDto>) => unwrap(response),
      invalidatesTags: ['Geofence'],
    }),
    dismissGeofenceSuggestion: builder.mutation<void, number>({
      query: (id) => ({ url: `/ai/geofence/suggestions/${id}/dismiss`, method: 'POST' }),
      invalidatesTags: ['Geofence'],
    }),
    // Dispatch is likewise a user-triggered POST with side effects (it is
    // persisted and audited), so mutation semantics are correct here.
    recommendDispatch: builder.mutation<DispatchRecommendResponseDto, DispatchRecommendRequestDto>({
      query: (body) => ({ url: '/ai/dispatch/recommend', method: 'POST', body }),
      transformResponse: (response: ApiResponse<DispatchRecommendResponseDto>) => unwrap(response),
    }),
    getMaintenancePredictions: builder.query<MaintenancePredictionDto[], number>({
      query: (deviceId) => `/ai/maintenance/predict/${deviceId}`,
      transformResponse: (response: ApiResponse<MaintenancePredictionDto[]>) => unwrap(response),
      providesTags: ['Device'],
    }),
    getFleetMaintenance: builder.query<MaintenancePredictionDto[], void>({
      query: () => '/ai/maintenance',
      transformResponse: (response: ApiResponse<MaintenancePredictionDto[]>) => unwrap(response),
      providesTags: ['Device'],
    }),
    searchAiRecords: builder.query<AiSearchHit[], { q: string; limit?: number }>({
      query: ({ q, limit }) => ({ url: '/ai/search', params: { q, limit: limit ?? 10 } }),
      transformResponse: (response: ApiResponse<AiSearchHit[]>) => unwrap(response),
    }),
    /** SUPER_ADMIN only; the backend enforces the role. */
    getAiDiagnostics: builder.query<AiDiagnosticsDto, boolean | void>({
      query: (refresh) => ({ url: '/ai/diagnostics', params: { refresh: Boolean(refresh) } }),
      transformResponse: (response: ApiResponse<AiDiagnosticsDto>) => unwrap(response),
    }),
  }),
});

export const {
  useGetAiDashboardSummaryQuery,
  useGetAiEventsQuery,
  useLazyGetAiEventsQuery,
  useAcknowledgeAiEventMutation,
  useResolveAiEventMutation,
  useSubmitAiFeedbackMutation,
  useSendChatMessageMutation,
  usePredictEtaMutation,
  useGetDriverScoresQuery,
  useGetDriverScoreQuery,
  useGetDriverScoreTrendQuery,
  useGetGeofenceSuggestionsQuery,
  useApproveGeofenceSuggestionMutation,
  useDismissGeofenceSuggestionMutation,
  useRecommendDispatchMutation,
  useGetMaintenancePredictionsQuery,
  useGetFleetMaintenanceQuery,
  useSearchAiRecordsQuery,
  useLazySearchAiRecordsQuery,
  useGetAiDiagnosticsQuery,
} = aiApi;
