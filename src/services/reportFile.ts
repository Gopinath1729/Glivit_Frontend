import { Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import type { ReportContent } from '@/src/types/api';

export type SavedReportFile = {
  fileName: string;
  uri: string | null;
  /** Human-readable place the file landed, for the confirmation message. */
  location: string;
};

export type ReportFormat = 'PDF' | 'EXCEL' | 'CSV';

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

/**
 * Writes a report to the device. Nothing is asked of the user.
 *
 * <p>Export used to open the Storage Access Framework directory picker so the
 * file could land in the public Downloads folder. That is the only supported
 * route to public Downloads on Android 11+ — `WRITE_EXTERNAL_STORAGE` is
 * ignored and `expo-file-system` exposes no public directory — but it meant
 * "Export PDF" opened a file browser and asked the operator to pick a folder
 * before anything downloaded, which is not what a download button should do.
 *
 * <p>So the file is written straight into the app's own documents directory,
 * which needs no permission and no prompt. The caller is handed the `uri` and
 * offers to open or share it afterwards, which is also how a file reaches
 * Downloads or Drive if the operator wants it there — but as a choice made
 * after the export, not a toll gate in front of it.
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

  const file = Paths.document.createFile(fileName, contentType);
  file.write(payload.content, { encoding: binary ? 'base64' : 'utf8' });
  const info = file.info();
  if (!info.exists || !info.size) {
    throw new Error('The report could not be written or is empty');
  }

  return {
    fileName,
    uri: file.uri,
    location:
      Platform.OS === 'ios' ? 'Files › On My iPhone › GLIVT' : 'the app’s documents folder',
  };
}

/**
 * True when the export failed because the user dismissed a system dialog.
 *
 * <p>Saving no longer opens one, but sharing an exported file still can, and
 * a dismissed share sheet is a decision rather than an error to report.
 */
export function isFilePickerCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    (message.includes('picker') || message.includes('share')) &&
    (message.includes('cancelled') || message.includes('canceled') || message.includes('dismiss'))
  );
}
