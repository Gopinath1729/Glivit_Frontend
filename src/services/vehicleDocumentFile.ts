import type { DocumentPickerAsset } from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import type { VehicleDocumentContent } from '@/src/types/api';

export const VEHICLE_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

export const MAX_VEHICLE_DOCUMENT_BYTES = 8 * 1024 * 1024;

export async function documentAssetBase64(asset: DocumentPickerAsset): Promise<string> {
  if (asset.base64) return stripDataUrl(asset.base64);

  if (Platform.OS === 'web' && asset.file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('The selected file could not be read.'));
      reader.onload = () => resolve(stripDataUrl(String(reader.result ?? '')));
      reader.readAsDataURL(asset.file as Blob);
    });
  }

  return new File(asset.uri).base64();
}

export async function openVehicleDocument(payload: VehicleDocumentContent): Promise<void> {
  const fileName = safeFileName(payload.fileName);
  const content = stripDataUrl(payload.content);

  if (Platform.OS === 'web') {
    const binary = atob(content);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: payload.contentType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return;
  }

  const file = new File(Paths.cache, fileName);
  file.create({ overwrite: true, intermediates: true });
  const binary = atob(content);
  file.write(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(file.uri, {
    dialogTitle: `Open ${fileName}`,
    mimeType: payload.contentType || undefined,
  });
}

function stripDataUrl(value: string): string {
  const comma = value.indexOf(',');
  return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value;
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-').trim();
  return cleaned || 'vehicle-document';
}
