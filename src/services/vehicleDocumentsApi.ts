import { baseApi, unwrap } from '@/src/services/baseApi';
import type {
  ApiResponse,
  VehicleDocumentContent,
  VehicleDocumentDto,
} from '@/src/types/api';

export type VehicleDocumentUpload = {
  name: string;
  documentType: string;
  fileName: string;
  contentType: string;
  sizeBytes?: number;
  expiryDate?: string;
  notes?: string;
  contentBase64: string;
};

export const vehicleDocumentsApi = baseApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (build) => ({
    getVehicleDocuments: build.query<VehicleDocumentDto[], number>({
      query: (deviceId) => ({ url: `/devices/${deviceId}/documents` }),
      transformResponse: (response: ApiResponse<VehicleDocumentDto[]>) => unwrap(response),
      providesTags: (_result, _error, deviceId) => [
        { type: 'VehicleDocument', id: `DEVICE-${deviceId}` },
      ],
    }),
    uploadVehicleDocument: build.mutation<
      VehicleDocumentDto,
      { deviceId: number; body: VehicleDocumentUpload }
    >({
      query: ({ deviceId, body }) => ({
        url: `/devices/${deviceId}/documents`,
        method: 'POST',
        body,
      }),
      transformResponse: (response: ApiResponse<VehicleDocumentDto>) => unwrap(response),
      invalidatesTags: (_result, _error, { deviceId }) => [
        { type: 'VehicleDocument', id: `DEVICE-${deviceId}` },
      ],
    }),
    getVehicleDocumentContent: build.mutation<
      VehicleDocumentContent,
      { deviceId: number; documentId: number }
    >({
      query: ({ deviceId, documentId }) => ({
        url: `/devices/${deviceId}/documents/${documentId}/content`,
      }),
      transformResponse: (response: ApiResponse<VehicleDocumentContent>) => unwrap(response),
    }),
    deleteVehicleDocument: build.mutation<void, { deviceId: number; documentId: number }>({
      query: ({ deviceId, documentId }) => ({
        url: `/devices/${deviceId}/documents/${documentId}`,
        method: 'DELETE',
      }),
      invalidatesTags: (_result, _error, { deviceId }) => [
        { type: 'VehicleDocument', id: `DEVICE-${deviceId}` },
      ],
    }),
  }),
});

export const {
  useDeleteVehicleDocumentMutation,
  useGetVehicleDocumentContentMutation,
  useGetVehicleDocumentsQuery,
  useUploadVehicleDocumentMutation,
} = vehicleDocumentsApi;
