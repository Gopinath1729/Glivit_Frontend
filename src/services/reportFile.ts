import { Paths } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { ReportContent } from '@/src/types/api';

export type SavedReportFile = {
  fileName: string;
  uri: string | null;
  /** Human-readable place the file landed, for the confirmation message. */
  location: string;
};

export type ReportFormat = 'PDF' | 'EXCEL' | 'CSV';

/**
 * Where Android reports are written.
 *
 * Android 11+ has no supported way to write an arbitrary file straight into
 * public Downloads: the old WRITE_EXTERNAL_STORAGE permission is ignored, and
 * expo-file-system exposes only app-private directories plus the Storage Access
 * Framework. The grant SAF returns is persistable, though -- so the folder is
 * chosen once and every export after that writes silently, with no picker.
 */
const SAF_GRANT_KEY = 'glivt.reports.saf-directory';

const EXTENSIONS: Record<ReportFormat, string> = {
  PDF: 'pdf',
  EXCEL: 'xlsx',
  CSV: 'csv',
};

const MIME_TYPES: Record<ReportFormat, string> = {
  PDF: 'application/pdf',
  EXCEL: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  CSV: 'text/csv',
};

/** `Report_2026-08-28.pdf` — dated, so repeated exports do not collide. */
export function reportFileName(format: ReportFormat, when: Date = new Date()): string {
  const stamp = [
    when.getFullYear(),
    String(when.getMonth() + 1).padStart(2, '0'),
    String(when.getDate()).padStart(2, '0'),
  ].join('-');
  return `Report_${stamp}.${EXTENSIONS[format]}`;
}

function isBinaryFormat(format: ReportFormat): boolean {
  return format !== 'CSV';
}

function saveInBrowser(content: string, contentType: string, fileName: string): SavedReportFile {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('Browser download is unavailable');
  }
  const isBinary = !contentType.includes('text/') && !contentType.includes('csv');
  let body: BlobPart = content;
  if (isBinary) {
    const decoded = atob(content);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    body = bytes;
  }
  const blob = new Blob([body], { type: contentType });
  const uri = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = uri;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(uri), 1000);
  return { fileName, uri: null, location: 'Downloads' };
}

async function readGrantedDirectory(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SAF_GRANT_KEY);
  } catch {
    return null;
  }
}

async function rememberGrantedDirectory(uri: string | null): Promise<void> {
  try {
    if (uri) await SecureStore.setItemAsync(SAF_GRANT_KEY, uri);
    else await SecureStore.deleteItemAsync(SAF_GRANT_KEY);
  } catch {
    // Losing the grant only costs one extra prompt next time.
  }
}

/**
 * Asks once for a download folder, seeded at Downloads, and remembers it.
 *
 * Only reached when there is no usable grant already; every later export uses
 * the stored one and shows nothing.
 */
async function requestDownloadDirectory(): Promise<string | null> {
  const { StorageAccessFramework } = LegacyFileSystem;
  const initial = StorageAccessFramework.getUriForDirectoryInRoot('Download');
  const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync(initial);
  if (!permission.granted) return null;
  await rememberGrantedDirectory(permission.directoryUri);
  return permission.directoryUri;
}

async function writeIntoDirectory(
  directoryUri: string,
  fileName: string,
  mimeType: string,
  content: string,
  binary: boolean
): Promise<string> {
  const { StorageAccessFramework } = LegacyFileSystem;
  const fileUri = await StorageAccessFramework.createFileAsync(directoryUri, fileName, mimeType);
  await StorageAccessFramework.writeAsStringAsync(fileUri, content, {
    encoding: binary ? 'base64' : 'utf8',
  });
  return fileUri;
}

/**
 * Saves a report to the device without prompting.
 *
 * On Android the folder is remembered from a one-time grant, so a tap on Export
 * writes the file and nothing appears on screen. On iOS the file goes to the
 * app's Documents folder -- reachable from Files under On My iPhone -- because
 * iOS has no shared Downloads directory and the alternative, a share sheet, is
 * the "Save As" dialog this is meant to avoid.
 */
export async function saveReportFile(
  payload: ReportContent,
  reportId: number,
  format: ReportFormat = 'CSV'
): Promise<SavedReportFile> {
  if (!payload || typeof payload.content !== 'string' || !payload.content.length) {
    throw new Error('The report is empty');
  }

  const fileName = reportFileName(format);
  const contentType = payload.contentType?.trim() || MIME_TYPES[format];
  const binary = isBinaryFormat(format);

  if (Platform.OS === 'web') {
    return saveInBrowser(payload.content, contentType, fileName);
  }

  if (Platform.OS === 'ios') {
    const file = Paths.document.createFile(fileName, contentType);
    file.write(payload.content, { encoding: binary ? 'base64' : 'utf8' });
    const info = file.info();
    if (!info.exists || !info.size) {
      throw new Error('The report could not be written or is empty');
    }
    return { fileName, uri: file.uri, location: 'Files › On My iPhone › GLIVT' };
  }

  // Android: reuse the remembered folder, and only ask if there is not one.
  let directoryUri = await readGrantedDirectory();
  if (directoryUri) {
    try {
      return {
        fileName,
        uri: await writeIntoDirectory(directoryUri, fileName, contentType, payload.content, binary),
        location: 'Downloads',
      };
    } catch {
      // The grant can be revoked, or the folder removed, long after it was
      // stored. Drop it and fall through to ask once more rather than failing.
      await rememberGrantedDirectory(null);
      directoryUri = null;
    }
  }

  directoryUri = await requestDownloadDirectory();
  if (!directoryUri) {
    throw new Error('DOWNLOAD_FOLDER_NOT_GRANTED');
  }
  return {
    fileName,
    uri: await writeIntoDirectory(directoryUri, fileName, contentType, payload.content, binary),
    location: 'Downloads',
  };
}

/** True when the user dismissed the one-time folder grant. */
export function isFilePickerCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message.includes('download_folder_not_granted')) return true;
  return message.includes('picker') && (message.includes('cancelled') || message.includes('canceled'));
}
