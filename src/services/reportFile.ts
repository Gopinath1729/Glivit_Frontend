import { Directory, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import type { ReportContent } from '@/src/types/api';

export type SavedReportFile = {
  fileName: string;
  uri: string | null;
};

const INVALID_FILE_NAME = /[<>:"/\\|?*\u0000-\u001F]/g;

function safeFileName(value: string | null | undefined, reportId: number): string {
  const leaf = value?.split(/[\\/]/).pop()?.trim() ?? '';
  let fileName = leaf.replace(INVALID_FILE_NAME, '_').replace(/^\.+/, '');
  if (!fileName) fileName = `report-${reportId}.csv`;
  if (!/\.[a-z0-9]{1,8}$/i.test(fileName)) fileName += '.csv';

  if (fileName.length > 120) {
    const extensionIndex = fileName.lastIndexOf('.');
    const extension = extensionIndex > 0 ? fileName.slice(extensionIndex) : '.csv';
    fileName = `${fileName.slice(0, 120 - extension.length)}${extension}`;
  }
  return fileName;
}

function duplicateFileName(fileName: string): string {
  const extensionIndex = fileName.lastIndexOf('.');
  const suffix = `-${Date.now()}`;
  if (extensionIndex <= 0) return `${fileName}${suffix}`;
  return `${fileName.slice(0, extensionIndex)}${suffix}${fileName.slice(extensionIndex)}`;
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('already exists');
}

function saveInBrowser(content: string, contentType: string, fileName: string): SavedReportFile {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('Browser download is unavailable');
  }
  const blob = new Blob([content], { type: contentType });
  const uri = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = uri;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(uri), 1000);
  return { fileName, uri: null };
}

/**
 * Saves a report somewhere the user can access. On mobile this opens the
 * system directory picker, avoiding the app-private document sandbox.
 */
export async function saveReportFile(
  payload: ReportContent,
  reportId: number
): Promise<SavedReportFile> {
  if (!payload || typeof payload.content !== 'string' || !payload.content.length) {
    throw new Error('The report is empty');
  }

  const fileName = safeFileName(payload.fileName, reportId);
  const contentType = payload.contentType?.trim() || 'text/csv';

  if (Platform.OS === 'web') {
    return saveInBrowser(payload.content, contentType, fileName);
  }

  if (Platform.OS === 'ios') {
    // iOS does not support Android's SAF directory picker well for writable arbitrary folders.
    // Write to app cache directory and trigger the native share sheet to let the user save it.
    const file = Paths.cache.createFile(fileName, contentType);
    const isBinary = !contentType.includes('text/') && !contentType.includes('csv');
    const encoding = isBinary ? 'base64' : 'utf8';

    try {
      file.write(payload.content, { encoding });
      const info = file.info();
      
      if (!info.exists || !info.size) {
        throw new Error('The report could not be written or is empty');
      }

      await Sharing.shareAsync(file.uri, {
        UTI: isBinary ? 'public.data' : 'public.comma-separated-values-text',
        mimeType: contentType,
        dialogTitle: 'Download Report',
      });
      return { fileName, uri: file.uri };
    } finally {
      // Clean up the temporary file on iOS after sharing (whether it succeeded, was cancelled, or failed)
      if (file.exists) {
        try {
          file.delete();
        } catch (e) {
          // Best-effort cleanup
        }
      }
    }
  }

  // Android SDK 54 Directory Picker (SAF)
  const directory = (await Directory.pickDirectoryAsync()) as Directory;
  let file: ReturnType<Directory['createFile']>;
  let savedFileName = fileName;
  try {
    file = directory.createFile(fileName, contentType);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    savedFileName = duplicateFileName(fileName);
    file = directory.createFile(savedFileName, contentType);
  }

  const isBinary = !contentType.includes('text/') && !contentType.includes('csv');
  const encoding = isBinary ? 'base64' : 'utf8';

  try {
    file.write(payload.content, { encoding });
    const info = file.info();
    if (!info.exists || !info.size) {
      throw new Error('The report could not be written');
    }
    return { fileName: savedFileName, uri: file.uri };
  } catch (error) {
    if (file.exists) {
      try {
        file.delete();
      } catch {
        // Best-effort cleanup of an incomplete file.
      }
    }
    throw error;
  }
}

export function isFilePickerCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('picker') && (message.includes('cancelled') || message.includes('canceled'));
}
