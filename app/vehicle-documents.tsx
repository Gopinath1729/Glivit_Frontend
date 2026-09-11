import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAwareForm } from '@/src/components/ui/KeyboardAwareForm';
import { P } from '@/src/constants/permissions';
import { useAppDialog } from '@/src/components/ui/useAppDialog';
import { apiErrorMessage } from '@/src/services/apiError';
import {
  MAX_VEHICLE_DOCUMENT_BYTES,
  VEHICLE_DOCUMENT_MIME_TYPES,
  documentAssetBase64,
  openVehicleDocument,
} from '@/src/services/vehicleDocumentFile';
import {
  useDeleteVehicleDocumentMutation,
  useGetVehicleDocumentContentMutation,
  useGetVehicleDocumentsQuery,
  useUploadVehicleDocumentMutation,
} from '@/src/services/vehicleDocumentsApi';
import { useHasPermission } from '@/src/store/hooks';
import { useTheme } from '@/src/theme/ThemeProvider';
import {
  elevation,
  hexToRgba,
  radius,
  spacing,
  typography,
  type ThemeColors,
} from '@/src/theme/tokens';
import type { VehicleDocumentDto } from '@/src/types/api';

const DOCUMENT_TYPES = [
  { key: 'REGISTRATION', label: 'Registration', icon: 'card-account-details-outline' },
  { key: 'INSURANCE', label: 'Insurance', icon: 'shield-outline' },
  { key: 'PERMIT', label: 'Permit', icon: 'file-certificate-outline' },
  { key: 'POLLUTION', label: 'Pollution', icon: 'leaf-circle-outline' },
  { key: 'SERVICE', label: 'Service', icon: 'wrench-clock' },
  { key: 'OTHER', label: 'Other', icon: 'file-outline' },
] as const;

type DocumentDraft = {
  name: string;
  type: string;
  expiryDate: string;
  notes: string;
};

const EMPTY_DOCUMENT_DRAFT: DocumentDraft = {
  name: '',
  type: 'REGISTRATION',
  expiryDate: '',
  notes: '',
};


/** How long before an expiry date a document starts needing attention. */
const EXPIRY_WARNING_DAYS = 30;

type ExpiryTone = { key: 'valid' | 'soon' | 'expired'; label: string };

/**
 * What a document's expiry date means today, as something to show and a tone.
 *
 * A document with no expiry date is not a problem to be solved - plenty of them
 * never expire - so it reads as valid rather than as missing something.
 */
function expiryTone(expiryDate?: string | null): ExpiryTone {
  const raw = (expiryDate ?? '').trim();
  if (!raw) return { key: 'valid', label: 'No expiry date' };
  const expiry = Date.parse(raw);
  if (!Number.isFinite(expiry)) return { key: 'valid', label: 'No expiry date' };

  const days = Math.ceil((expiry - Date.now()) / 86_400_000);
  const shown = formatDocumentDate(expiry);
  if (days < 0) return { key: 'expired', label: `Expired ${shown}` };
  if (days === 0) return { key: 'expired', label: 'Expires today' };
  if (days <= EXPIRY_WARNING_DAYS) {
    return { key: 'soon', label: `Expires in ${days} day${days === 1 ? '' : 's'}` };
  }
  return { key: 'valid', label: `Valid until ${shown}` };
}

function formatDocumentDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function documentTypeEntry(documentType: string) {
  const key = (documentType ?? '').toUpperCase();
  return DOCUMENT_TYPES.find((entry) => entry.key === key);
}

function documentTypeIcon(
  documentType: string
): React.ComponentProps<typeof MaterialCommunityIcons>['name'] {
  return documentTypeEntry(documentType)?.icon ?? 'file-outline';
}

/** One accent per kind of paperwork, so a library is scannable by colour. */
function documentTypeColor(documentType: string, c: ThemeColors): string {
  switch ((documentType ?? '').toUpperCase()) {
    case 'REGISTRATION':
      return c.primary;
    case 'INSURANCE':
      return c.info;
    case 'PERMIT':
      return c.warningOrange;
    case 'POLLUTION':
      return c.success;
    case 'SERVICE':
      return c.secondary;
    default:
      return c.textMuted;
  }
}

/** The human name for a document type, including one the server invented. */
function formatLabel(documentType: string): string {
  const known = documentTypeEntry(documentType);
  if (known) return known.label;
  const raw = (documentType ?? '').trim();
  if (!raw) return 'Document';
  return raw
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** "insurance-2027.pdf" -> "insurance-2027", so the name field starts useful. */
function stripExtension(fileName: string): string {
  const name = (fileName ?? '').trim();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** A real YYYY-MM-DD, not merely something shaped like one. */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * The content type for a file the picker did not label.
 *
 * Restricted to the types the upload accepts: a file whose extension is not one
 * of them is sent as a generic stream and refused by the server, which is the
 * correct outcome rather than a mislabelled upload.
 */
function mimeTypeForName(fileName: string): string {
  const extension = (fileName ?? '').toLowerCase().split('.').pop() ?? '';
  switch (extension) {
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'heic':
      return 'image/heic';
    default:
      return 'application/octet-stream';
  }
}

/**
 * A vehicle's document library.
 *
 * This route used to be the vehicle DETAILS page: a hero, an overview of live
 * telemetry, and documents behind a segmented control. Everything above the
 * documents was a slower copy of what the Vehicles list and the Live and
 * Playback screens already show, and reaching any of it meant opening a vehicle
 * first and then choosing again. The list now goes straight to Live or
 * Playback, so the only thing that still needed a screen of its own is the one
 * thing neither of those can hold.
 */
export default function VehicleDocumentsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const params = useLocalSearchParams<{ id?: string; name?: string }>();
  const deviceId = Number(params.id);
  const valid = Number.isSafeInteger(deviceId) && deviceId > 0;

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(app)/vehicles');
  }, [router]);

  if (!valid) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + spacing.md }]}>
        <View style={styles.docHeader}>
          <Pressable
            accessibilityLabel="Go back"
            accessibilityRole="button"
            hitSlop={10}
            onPress={goBack}
            style={styles.docBack}>
            <MaterialCommunityIcons color={c.textPrimary} name="arrow-left" size={22} />
          </Pressable>
          <Text style={styles.docTitle}>Documents</Text>
        </View>
        <View style={styles.documentsState}>
          <Text style={styles.documentsStateTitle}>No vehicle selected</Text>
          <Text style={styles.documentsStateText}>
            Open a vehicle from the Vehicles list to see its documents.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.docHeader}>
        <Pressable
          accessibilityLabel="Go back"
          accessibilityRole="button"
          hitSlop={10}
          onPress={goBack}
          style={styles.docBack}>
          <MaterialCommunityIcons color={c.textPrimary} name="arrow-left" size={22} />
        </Pressable>
        <View style={styles.docHeaderCopy}>
          <Text numberOfLines={1} style={styles.docTitle}>
            {params.name?.trim() || `Vehicle ${deviceId}`}
          </Text>
          <Text style={styles.docSubtitle}>DOCUMENTS</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        showsVerticalScrollIndicator={false}>
        <DocumentLibrary deviceId={deviceId} />
      </ScrollView>
    </View>
  );
}

function DocumentLibrary({ deviceId }: { deviceId: number }) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const canManage = useHasPermission(P.MANAGE_DEVICES);
  const { data = [], isLoading, isError, error, refetch } = useGetVehicleDocumentsQuery(deviceId);
  const [getContent] = useGetVehicleDocumentContentMutation();
  const [deleteDocument] = useDeleteVehicleDocumentMutation();
  const [modalVisible, setModalVisible] = useState(false);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const { confirm, dialogElement, notify } = useAppDialog();

  const expiring = data.filter((document) => expiryTone(document.expiryDate).key !== 'valid').length;

  const openDocument = async (document: VehicleDocumentDto) => {
    if (openingId != null) return;
    setOpeningId(document.id);
    try {
      const content = await getContent({ deviceId, documentId: document.id }).unwrap();
      await openVehicleDocument(content);
    } catch (caught) {
      notify({
        message: apiErrorMessage(caught, 'The document could not be opened.'),
        title: 'Document unavailable',
        tone: 'danger',
      });
    } finally {
      setOpeningId(null);
    }
  };

  const confirmDelete = (document: VehicleDocumentDto) => {
    confirm({
      confirmLabel: 'Delete',
      message: `${document.name} will be permanently removed from this vehicle.`,
      onConfirm: async () => {
        setDeletingId(document.id);
        try {
          await deleteDocument({ deviceId, documentId: document.id }).unwrap();
        } catch (caught) {
          notify({ message: apiErrorMessage(caught), title: 'Delete failed', tone: 'danger' });
        } finally {
          setDeletingId(null);
        }
      },
      title: 'Delete document?',
      tone: 'danger',
    });
  };

  return (
    <View style={styles.sectionStack}>
      <LinearGradient
        colors={[hexToRgba(c.primary, 0.16), hexToRgba(c.info, 0.08)]}
        style={styles.documentSummary}>
        <View style={styles.documentSummaryIcon}>
          <MaterialCommunityIcons color={c.primary} name="folder-lock-outline" size={28} />
        </View>
        <View style={styles.documentSummaryText}>
          <Text style={styles.documentSummaryTitle}>Vehicle vault</Text>
          <Text style={styles.documentSummaryMeta}>
            {data.length} {data.length === 1 ? 'document' : 'documents'} · {expiring} need attention
          </Text>
        </View>
        {canManage ? (
          <Pressable accessibilityRole="button" onPress={() => setModalVisible(true)} style={styles.addDocumentButton}>
            <MaterialCommunityIcons color={c.onPrimary} name="plus" size={18} />
            <Text style={styles.addDocumentText}>Add</Text>
          </Pressable>
        ) : null}
      </LinearGradient>

      {isLoading ? (
        <View style={styles.documentsState}>
          <ActivityIndicator color={c.primary} />
          <Text style={styles.documentsStateText}>Loading documents…</Text>
        </View>
      ) : isError ? (
        <View style={styles.documentsState}>
          <MaterialCommunityIcons color={c.danger} name="cloud-alert-outline" size={30} />
          <Text style={styles.documentsStateTitle}>Could not load documents</Text>
          <Text style={styles.documentsStateText}>{apiErrorMessage(error)}</Text>
          <Pressable onPress={() => refetch()} style={styles.retryDocumentButton}>
            <Text style={styles.retryDocumentText}>Try again</Text>
          </Pressable>
        </View>
      ) : data.length === 0 ? (
        <View style={styles.documentsEmpty}>
          <View style={styles.documentsEmptyIcon}>
            <MaterialCommunityIcons color={c.textMuted} name="file-document-multiple-outline" size={34} />
          </View>
          <Text style={styles.documentsStateTitle}>No vehicle documents yet</Text>
          <Text style={styles.documentsStateText}>
            Keep registration, insurance, permits and service records together with the vehicle.
          </Text>
          {canManage ? (
            <Pressable onPress={() => setModalVisible(true)} style={styles.emptyAddButton}>
              <MaterialCommunityIcons color={c.primary} name="file-plus-outline" size={18} />
              <Text style={styles.emptyAddText}>Upload first document</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <View style={styles.documentList}>
          {data.map((document) => (
            <DocumentRow
              canDelete={canManage}
              deleting={deletingId === document.id}
              document={document}
              key={document.id}
              onDelete={() => confirmDelete(document)}
              onOpen={() => void openDocument(document)}
              opening={openingId === document.id}
            />
          ))}
        </View>
      )}

      <DocumentUploadModal
        deviceId={deviceId}
        onClose={() => setModalVisible(false)}
        visible={modalVisible}
      />

      {dialogElement}
    </View>
  );
}

function DocumentRow({
  canDelete,
  deleting,
  document,
  onDelete,
  onOpen,
  opening,
}: {
  canDelete: boolean;
  deleting: boolean;
  document: VehicleDocumentDto;
  onDelete: () => void;
  onOpen: () => void;
  opening: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const expiry = expiryTone(document.expiryDate);
  const expiryColor = expiry.key === 'expired' ? c.danger : expiry.key === 'soon' ? c.warning : c.success;

  return (
    <View style={styles.documentRow}>
      <View style={[styles.documentTypeIcon, { backgroundColor: hexToRgba(documentTypeColor(document.documentType, c), 0.12) }]}>
        <MaterialCommunityIcons
          color={documentTypeColor(document.documentType, c)}
          name={documentTypeIcon(document.documentType)}
          size={23}
        />
      </View>
      <View style={styles.documentBody}>
        <Text numberOfLines={1} style={styles.documentName}>{document.name}</Text>
        <Text numberOfLines={1} style={styles.documentFileMeta}>
          {formatLabel(document.documentType)} · {formatBytes(document.sizeBytes)}
        </Text>
        <View style={styles.documentExpiryRow}>
          <MaterialCommunityIcons color={expiryColor} name="calendar-clock-outline" size={13} />
          <Text style={[styles.documentExpiry, { color: expiryColor }]}>{expiry.label}</Text>
        </View>
      </View>
      <Pressable
        accessibilityLabel={`Open ${document.name}`}
        accessibilityRole="button"
        disabled={opening}
        onPress={onOpen}
        style={styles.documentIconButton}>
        {opening ? (
          <ActivityIndicator color={c.primary} size="small" />
        ) : (
          <MaterialCommunityIcons color={c.primary} name="open-in-new" size={20} />
        )}
      </Pressable>
      {canDelete ? (
        <Pressable
          accessibilityLabel={`Delete ${document.name}`}
          accessibilityRole="button"
          disabled={deleting}
          onPress={onDelete}
          style={styles.documentIconButton}>
          {deleting ? (
            <ActivityIndicator color={c.danger} size="small" />
          ) : (
            <MaterialCommunityIcons color={c.danger} name="trash-can-outline" size={20} />
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

function DocumentUploadModal({ deviceId, onClose, visible }: { deviceId: number; onClose: () => void; visible: boolean }) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(c), [c]);
  const [draft, setDraft] = useState<DocumentDraft>(EMPTY_DOCUMENT_DRAFT);
  const [asset, setAsset] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [upload, { isLoading }] = useUploadVehicleDocumentMutation();
  const { dialogElement, notify } = useAppDialog();

  const close = () => {
    if (isLoading) return;
    setDraft(EMPTY_DOCUMENT_DRAFT);
    setAsset(null);
    onClose();
  };

  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        base64: true,
        copyToCacheDirectory: true,
        multiple: false,
        type: VEHICLE_DOCUMENT_MIME_TYPES,
      });
      if (result.canceled) return;
      const picked = result.assets[0];
      if (picked.size != null && picked.size > MAX_VEHICLE_DOCUMENT_BYTES) {
        notify({
          message: 'Choose a document smaller than 8 MB.',
          title: 'File is too large',
          tone: 'info',
        });
        return;
      }
      setAsset(picked);
      setDraft((current) => ({
        ...current,
        name: current.name || stripExtension(picked.name),
      }));
    } catch (caught) {
      notify({
        message: apiErrorMessage(caught, 'Please try selecting the file again.'),
        title: 'File picker unavailable',
        tone: 'danger',
      });
    }
  };

  const submit = async () => {
    if (!asset) {
      notify({
        message: 'Choose the PDF, image, text or Word document to upload.',
        title: 'Select a file',
        tone: 'info',
      });
      return;
    }
    if (!draft.name.trim()) {
      notify({
        message: 'Add a short name so the file is easy to identify.',
        title: 'Document name required',
        tone: 'info',
      });
      return;
    }
    if (draft.expiryDate && !isIsoDate(draft.expiryDate)) {
      notify({
        message: 'Use YYYY-MM-DD, for example 2027-03-31.',
        title: 'Invalid expiry date',
        tone: 'info',
      });
      return;
    }

    try {
      const contentBase64 = await documentAssetBase64(asset);
      const estimatedBytes = Math.floor((contentBase64.length * 3) / 4);
      if (estimatedBytes > MAX_VEHICLE_DOCUMENT_BYTES) {
        notify({
          message: 'Choose a document smaller than 8 MB.',
          title: 'File is too large',
          tone: 'info',
        });
        return;
      }
      await upload({
        deviceId,
        body: {
          name: draft.name.trim(),
          documentType: draft.type,
          fileName: asset.name,
          contentType: asset.mimeType || mimeTypeForName(asset.name),
          sizeBytes: asset.size ?? estimatedBytes,
          expiryDate: draft.expiryDate || undefined,
          notes: draft.notes.trim() || undefined,
          contentBase64,
        },
      }).unwrap();
      close();
    } catch (caught) {
      notify({
        message: apiErrorMessage(caught, 'The document could not be uploaded.'),
        title: 'Upload failed',
        tone: 'danger',
      });
    }
  };

  return (
    <Modal animationType="slide" onRequestClose={close} transparent visible={visible}>
      <View style={styles.modalOverlay}>
        <Pressable onPress={close} style={StyleSheet.absoluteFillObject} />
        <View style={[styles.uploadSheet, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <View style={styles.sheetHandle} />
          <View style={styles.uploadHeader}>
            <View>
              <Text style={styles.uploadTitle}>Add vehicle document</Text>
              <Text style={styles.uploadSubtitle}>PDF, image, text or Word · max 8 MB</Text>
            </View>
            <Pressable accessibilityLabel="Close" onPress={close} style={styles.closeButton}>
              <MaterialCommunityIcons color={c.textSecondary} name="close" size={22} />
            </Pressable>
          </View>

          {/* The sheet already applies the bottom inset. */}
          <KeyboardAwareForm
            applyBottomInset={false}
            contentContainerStyle={styles.uploadContent}
            dismissOnTapOutside={false}>
            <Pressable onPress={() => void pickFile()} style={[styles.filePicker, asset && styles.filePickerSelected]}>
              <View style={styles.filePickerIcon}>
                <MaterialCommunityIcons color={c.primary} name={asset ? 'file-check-outline' : 'cloud-upload-outline'} size={28} />
              </View>
              <View style={styles.filePickerText}>
                <Text numberOfLines={1} style={styles.filePickerTitle}>{asset?.name ?? 'Choose a document'}</Text>
                <Text style={styles.filePickerMeta}>
                  {asset ? `${formatBytes(asset.size ?? 0)} · Tap to replace` : 'Browse files on this device'}
                </Text>
              </View>
              <MaterialCommunityIcons color={c.textMuted} name="chevron-right" size={22} />
            </Pressable>

            <FieldLabel label="Document name" required />
            <TextInput
              maxLength={160}
              onChangeText={(name) => setDraft((current) => ({ ...current, name }))}
              placeholder="e.g. Comprehensive insurance"
              placeholderTextColor={c.textMuted}
              style={styles.uploadInput}
              value={draft.name}
            />

            <FieldLabel label="Type" />
            <View style={styles.typeGrid}>
              {DOCUMENT_TYPES.map((type) => {
                const active = draft.type === type.key;
                return (
                  <Pressable
                    accessibilityState={{ selected: active }}
                    key={type.key}
                    onPress={() => setDraft((current) => ({ ...current, type: type.key }))}
                    style={[styles.typeChip, active && styles.typeChipActive]}>
                    <MaterialCommunityIcons color={active ? c.primary : c.textMuted} name={type.icon} size={17} />
                    <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>{type.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <FieldLabel label="Expiry date" optional />
            <View style={styles.inputWithIcon}>
              <MaterialCommunityIcons color={c.textMuted} name="calendar-outline" size={19} />
              <TextInput
                maxLength={10}
                onChangeText={(expiryDate) => setDraft((current) => ({ ...current, expiryDate }))}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={c.textMuted}
                style={styles.inputWithIconText}
                value={draft.expiryDate}
              />
            </View>

            <FieldLabel label="Notes" optional />
            <TextInput
              maxLength={500}
              multiline
              onChangeText={(notes) => setDraft((current) => ({ ...current, notes }))}
              placeholder="Policy number, provider, reminder…"
              placeholderTextColor={c.textMuted}
              style={[styles.uploadInput, styles.notesInput]}
              textAlignVertical="top"
              value={draft.notes}
            />

            <Pressable disabled={isLoading} onPress={() => void submit()} style={[styles.uploadButton, isLoading && styles.buttonDisabled]}>
              {isLoading ? (
                <ActivityIndicator color={c.onPrimary} />
              ) : (
                <>
                  <MaterialCommunityIcons color={c.onPrimary} name="shield-check-outline" size={20} />
                  <Text style={styles.uploadButtonText}>Save securely</Text>
                </>
              )}
            </Pressable>
          </KeyboardAwareForm>
        </View>
      </View>

      {dialogElement}
    </Modal>
  );
}

function FieldLabel({ label, optional, required }: { label: string; optional?: boolean; required?: boolean }) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.fieldLabelRow}>
      <Text style={styles.fieldLabel}>{label}{required ? <Text style={{ color: c.danger }}> *</Text> : null}</Text>
      {optional ? <Text style={styles.optionalText}>Optional</Text> : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    screen: { backgroundColor: c.pageBackground, flex: 1 },
    content: { flexGrow: 1 },
    hero: { backgroundColor: '#07101D', height: 330, overflow: 'hidden' },
    heroToolbar: { flexDirection: 'row', justifyContent: 'space-between', left: spacing.md, position: 'absolute', right: spacing.md },
    glassButton: { alignItems: 'center', backgroundColor: 'rgba(7,16,29,0.68)', borderColor: 'rgba(255,255,255,0.25)', borderRadius: radius.pill, borderWidth: 1, height: 44, justifyContent: 'center', width: 44 },
    noLocationIcon: { alignItems: 'center', left: 0, position: 'absolute', right: 0, top: 55 },
    heroIdentity: { bottom: 46, gap: 5, left: spacing.md, position: 'absolute', right: spacing.md },
    heroEyebrowRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
    heroStatus: { alignItems: 'center', backgroundColor: 'rgba(4,10,20,0.75)', borderRadius: radius.pill, borderWidth: 1, flexDirection: 'row', gap: 6, paddingHorizontal: 9, paddingVertical: 4 },
    heroStatusDot: { borderRadius: 5, height: 7, width: 7 },
    heroStatusText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.7, textTransform: 'uppercase' },
    heroCategory: { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase' },
    heroName: { color: '#FFFFFF', fontSize: 27, fontWeight: '900', letterSpacing: -0.5 },
    heroMeta: { color: 'rgba(255,255,255,0.72)', fontSize: 13, fontWeight: '600' },
    body: { gap: spacing.md, marginTop: -30, paddingHorizontal: spacing.md },
    actionDeck: { ...elevation(c, 2), backgroundColor: c.surface, borderColor: c.border, borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', paddingHorizontal: spacing.sm, paddingVertical: 12 },
    quickAction: { alignItems: 'center', flex: 1, gap: 6 },
    quickActionIcon: { alignItems: 'center', borderRadius: 15, height: 45, justifyContent: 'center', width: 45 },
    quickActionText: { color: c.textPrimary, fontSize: 11, fontWeight: '800' },
    buttonDisabled: { opacity: 0.45 },
    pressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
    segmentedControl: { backgroundColor: c.surfaceAlt, borderColor: c.border, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', padding: 4 },
    segment: { alignItems: 'center', borderRadius: radius.sm, flex: 1, paddingVertical: 9 },
    segmentActive: { ...elevation(c, 1), backgroundColor: c.surface },
    segmentText: { color: c.textMuted, fontSize: typography.label, fontWeight: '700' },
    segmentTextActive: { color: c.primary, fontWeight: '900' },
    sectionStack: { gap: spacing.md },
    kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    kpi: { backgroundColor: c.surface, borderColor: c.border, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, flexBasis: '47%', flexGrow: 1, gap: 8, minHeight: 88, padding: 13 },
    kpiHeader: { alignItems: 'center', flexDirection: 'row', gap: 6 },
    kpiLabel: { color: c.textMuted, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
    kpiValue: { color: c.textPrimary, fontSize: 22, fontVariant: ['tabular-nums'], fontWeight: '900' },
    kpiUnit: { color: c.textMuted, fontSize: 11, fontWeight: '700' },
    detailCard: { backgroundColor: c.surface, borderColor: c.border, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
    detailCardHeader: { alignItems: 'center', borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, padding: spacing.md },
    detailCardIcon: { alignItems: 'center', backgroundColor: hexToRgba(c.primary, 0.11), borderRadius: radius.sm, height: 34, justifyContent: 'center', width: 34 },
    detailCardTitle: { color: c.textPrimary, flex: 1, fontSize: typography.body, fontWeight: '900' },
    detailRows: { paddingHorizontal: spacing.md },
    detailRow: { alignItems: 'center', borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: spacing.md, minHeight: 49, paddingVertical: 10 },
    detailRowMultiline: { alignItems: 'flex-start' },
    detailLabel: { color: c.textMuted, fontSize: typography.caption, fontWeight: '700', width: 116 },
    detailValue: { color: c.textPrimary, flex: 1, fontSize: typography.label, fontWeight: '700', textAlign: 'right' },
    monoValue: { fontVariant: ['tabular-nums'], letterSpacing: 0.4 },
    documentSummary: { alignItems: 'center', borderColor: hexToRgba(c.primary, 0.22), borderRadius: radius.lg, borderWidth: 1, flexDirection: 'row', gap: 12, padding: spacing.md },
    documentSummaryIcon: { alignItems: 'center', backgroundColor: c.surface, borderRadius: radius.md, height: 48, justifyContent: 'center', width: 48 },
    documentSummaryText: { flex: 1, minWidth: 0 },
    documentSummaryTitle: { color: c.textPrimary, fontSize: typography.title, fontWeight: '900' },
    documentSummaryMeta: { color: c.textSecondary, fontSize: typography.caption, marginTop: 2 },
    addDocumentButton: { alignItems: 'center', backgroundColor: c.primary, borderRadius: radius.sm, flexDirection: 'row', gap: 4, paddingHorizontal: 12, paddingVertical: 9 },
    addDocumentText: { color: c.onPrimary, fontSize: typography.caption, fontWeight: '900' },
    documentsState: { alignItems: 'center', backgroundColor: c.surface, borderColor: c.border, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, gap: 8, padding: spacing.xl },
    documentsEmpty: { alignItems: 'center', backgroundColor: c.surface, borderColor: c.border, borderRadius: radius.lg, borderStyle: 'dashed', borderWidth: 1.5, gap: 8, padding: spacing.xl },
    documentsEmptyIcon: { alignItems: 'center', backgroundColor: c.surfaceAlt, borderRadius: radius.pill, height: 64, justifyContent: 'center', marginBottom: 4, width: 64 },
    documentsStateTitle: { color: c.textPrimary, fontSize: typography.body, fontWeight: '900', textAlign: 'center' },
    documentsStateText: { color: c.textMuted, fontSize: typography.caption, lineHeight: 18, maxWidth: 300, textAlign: 'center' },
    retryDocumentButton: { backgroundColor: c.surfaceAlt, borderRadius: radius.sm, marginTop: 4, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    retryDocumentText: { color: c.primary, fontSize: typography.label, fontWeight: '900' },
    emptyAddButton: { alignItems: 'center', borderColor: hexToRgba(c.primary, 0.35), borderRadius: radius.sm, borderWidth: 1, flexDirection: 'row', gap: 7, marginTop: 7, paddingHorizontal: spacing.md, paddingVertical: 10 },
    emptyAddText: { color: c.primary, fontSize: typography.label, fontWeight: '900' },
    docHeader: {
      alignItems: 'center',
      backgroundColor: c.surface,
      borderBottomColor: c.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing.sm,
      paddingBottom: spacing.sm,
      paddingHorizontal: spacing.sm,
    },
    docBack: {
      alignItems: 'center',
      borderRadius: radius.sm,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    docHeaderCopy: { flex: 1, minWidth: 0 },
    docTitle: { color: c.textPrimary, fontSize: 17, fontWeight: '900', letterSpacing: -0.3 },
    docSubtitle: {
      color: c.textMuted,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 1.3,
      marginTop: 1,
    },
    documentList: { backgroundColor: c.surface, borderColor: c.border, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
    documentRow: { alignItems: 'center', borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 90, padding: 12 },
    documentTypeIcon: { alignItems: 'center', borderRadius: radius.md, height: 46, justifyContent: 'center', width: 46 },
    documentBody: { flex: 1, gap: 3, minWidth: 0 },
    documentName: { color: c.textPrimary, fontSize: typography.label, fontWeight: '900' },
    documentFileMeta: { color: c.textMuted, fontSize: 11 },
    documentExpiryRow: { alignItems: 'center', flexDirection: 'row', gap: 4, marginTop: 2 },
    documentExpiry: { fontSize: 11, fontWeight: '800' },
    documentIconButton: { alignItems: 'center', borderRadius: radius.sm, height: 38, justifyContent: 'center', width: 34 },
    modalOverlay: { backgroundColor: c.overlay, flex: 1, justifyContent: 'flex-end' },
    uploadSheet: { backgroundColor: c.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, maxHeight: '92%', paddingTop: 8 },
    sheetHandle: { alignSelf: 'center', backgroundColor: c.borderStrong, borderRadius: radius.pill, height: 4, marginBottom: 10, width: 42 },
    uploadHeader: { alignItems: 'center', borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', paddingBottom: spacing.md, paddingHorizontal: spacing.md },
    uploadTitle: { color: c.textPrimary, fontSize: typography.title, fontWeight: '900' },
    uploadSubtitle: { color: c.textMuted, fontSize: 11, marginTop: 3 },
    closeButton: { alignItems: 'center', backgroundColor: c.surfaceAlt, borderRadius: radius.pill, height: 38, justifyContent: 'center', width: 38 },
    uploadContent: { gap: 10, padding: spacing.md },
    filePicker: { alignItems: 'center', backgroundColor: c.surfaceAlt, borderColor: c.borderStrong, borderRadius: radius.md, borderStyle: 'dashed', borderWidth: 1.5, flexDirection: 'row', gap: 12, padding: spacing.md },
    filePickerSelected: { backgroundColor: hexToRgba(c.primary, 0.07), borderColor: c.primary, borderStyle: 'solid' },
    filePickerIcon: { alignItems: 'center', backgroundColor: hexToRgba(c.primary, 0.12), borderRadius: radius.md, height: 48, justifyContent: 'center', width: 48 },
    filePickerText: { flex: 1, minWidth: 0 },
    filePickerTitle: { color: c.textPrimary, fontSize: typography.label, fontWeight: '900' },
    filePickerMeta: { color: c.textMuted, fontSize: 11, marginTop: 3 },
    fieldLabelRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: 3 },
    fieldLabel: { color: c.textPrimary, fontSize: typography.caption, fontWeight: '800' },
    optionalText: { color: c.textMuted, fontSize: 10 },
    uploadInput: { backgroundColor: c.surfaceAlt, borderColor: c.border, borderRadius: radius.sm, borderWidth: 1, color: c.textPrimary, fontSize: typography.label, minHeight: 48, paddingHorizontal: 13, paddingVertical: 11 },
    notesInput: { minHeight: 76 },
    typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
    typeChip: { alignItems: 'center', backgroundColor: c.surfaceAlt, borderColor: c.border, borderRadius: radius.pill, borderWidth: 1, flexDirection: 'row', gap: 5, paddingHorizontal: 10, paddingVertical: 8 },
    typeChipActive: { backgroundColor: hexToRgba(c.primary, 0.1), borderColor: c.primary },
    typeChipText: { color: c.textSecondary, fontSize: 11, fontWeight: '700' },
    typeChipTextActive: { color: c.primary, fontWeight: '900' },
    inputWithIcon: { alignItems: 'center', backgroundColor: c.surfaceAlt, borderColor: c.border, borderRadius: radius.sm, borderWidth: 1, flexDirection: 'row', gap: 9, minHeight: 48, paddingHorizontal: 13 },
    inputWithIconText: { color: c.textPrimary, flex: 1, fontSize: typography.label, paddingVertical: 10 },
    uploadButton: { alignItems: 'center', backgroundColor: c.primary, borderRadius: radius.md, flexDirection: 'row', gap: 8, height: 52, justifyContent: 'center', marginTop: 6 },
    uploadButtonText: { color: c.onPrimary, fontSize: typography.body, fontWeight: '900' },
  });
