import { baseApi, unwrap } from '@/src/services/baseApi';
import type { ApiResponse } from '@/src/types/api';

export type NavigationPlace = {
  id: string;
  name: string;
  formatted: string;
  resultType: string;
  city: string;
  state: string;
  country: string;
  latitude: number;
  longitude: number;
};

export type NavigationRoute = {
  distanceMeters: number;
  durationSeconds: number;
  coordinates: { latitude: number; longitude: number }[];
};

export type NavigationRouteRequest = {
  fromLatitude: number;
  fromLongitude: number;
  toLatitude: number;
  toLongitude: number;
  includeAlternatives?: boolean;
};

export type NavigationRoutesResponse = NavigationRoute & {
  routes: NavigationRoute[];
};

export type SharedTripRequest = {
  deviceId: number;
  destinationName: string;
  destinationLatitude: number;
  destinationLongitude: number;
  distanceMeters: number;
  durationSeconds: number;
  coordinates: NavigationRoute['coordinates'];
  active: boolean;
};

export type SharedTripCreated = {
  token: string;
  expiresAt: string;
};

export type SharedTripView = {
  status: 'PLANNED' | 'ACTIVE' | 'REACHED';
  vehicleName: string;
  latitude: number;
  longitude: number;
  bearing: number;
  speedKmh: number;
  lastGpsTime: string | null;
  connectionState: string;
  destinationName: string;
  destinationLatitude: number;
  destinationLongitude: number;
  remainingDistanceMeters: number;
  remainingDurationSeconds: number;
  remainingRoute: NavigationRoute['coordinates'];
  expiresAt: string;
};

export const navigationApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    searchNavigationPlaces: build.query<
      NavigationPlace[],
      { query: string; biasLatitude?: number; biasLongitude?: number }
    >({
      query: ({ query, biasLatitude, biasLongitude }) => ({
        url: '/navigation/places',
        params: {
          query,
          ...(biasLatitude != null && biasLongitude != null
            ? { biasLatitude, biasLongitude }
            : {}),
        },
      }),
      transformResponse: (response: ApiResponse<NavigationPlace[]>) => unwrap(response),
    }),
    calculateNavigationRoute: build.mutation<NavigationRoutesResponse, NavigationRouteRequest>({
      query: (body) => ({ url: '/navigation/routes', method: 'POST', body }),
      transformResponse: (response: ApiResponse<NavigationRoutesResponse>) => unwrap(response),
    }),
    createSharedTrip: build.mutation<SharedTripCreated, SharedTripRequest>({
      query: (body) => ({ url: '/navigation/shared-trips', method: 'POST', body }),
      transformResponse: (response: ApiResponse<SharedTripCreated>) => unwrap(response),
    }),
    updateSharedTrip: build.mutation<void, { token: string; body: SharedTripRequest }>({
      query: ({ token, body }) => ({
        url: `/navigation/shared-trips/${encodeURIComponent(token)}/route`,
        method: 'PUT',
        body,
      }),
    }),
    startSharedTrip: build.mutation<void, string>({
      query: (token) => ({
        url: `/navigation/shared-trips/${encodeURIComponent(token)}/start`,
        method: 'POST',
      }),
    }),
    completeSharedTrip: build.mutation<void, string>({
      query: (token) => ({
        url: `/navigation/shared-trips/${encodeURIComponent(token)}/complete`,
        method: 'POST',
      }),
    }),
    cancelSharedTrip: build.mutation<void, string>({
      query: (token) => ({
        url: `/navigation/shared-trips/${encodeURIComponent(token)}`,
        method: 'DELETE',
      }),
    }),
  }),
});

export const {
  useCalculateNavigationRouteMutation,
  useCancelSharedTripMutation,
  useCompleteSharedTripMutation,
  useCreateSharedTripMutation,
  useLazySearchNavigationPlacesQuery,
  useStartSharedTripMutation,
  useUpdateSharedTripMutation,
} = navigationApi;
