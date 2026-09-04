import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import MapView, { Marker } from '@/src/components/maps/NativeMap';
import { VehicleMarker, markerCategory } from '@/src/components/VehicleMarker';
import { KeyboardAwareForm } from '@/src/components/ui/KeyboardAwareForm';
import { ErrorRetryView, LoadingView } from '@/src/components/ui/StateViews';
import { P } from '@/src/constants/permissions';
import { apiErrorMessage } from '@/src/services/apiError';
import {
  formatDeviceState,
  resolveDeviceRecordState,
  type ResolvedDeviceState,
} from '@/src/services/deviceState';
import { useMobileGpsReadiness } from '@/src/services/mobileGpsStatus';
import { useGetDeviceQuery } from '@/src/services/devicesApi';
import { nativeMapsAvailable } from '@/src/services/mapStyle';
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
import { useNowTick } from '@/src/hooks/useNowTick';
import { useTheme } from '@/src/theme/ThemeProvider';
import {
  elevation,
  hexToRgba,
  radius,
  spacing,
  typography,
  type ThemeColors,
} from '@/src/theme/tokens';
import type { DeviceDetail, VehicleDocumentDto } from '@/src/types/api';

type ProfileSection = 'overview' | 'documents';

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

export default function DeviceProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors: c, stateColors } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const params = useLocalSearchParams<{ id?: string; section?: string }>();
  const id = Number(params.id);
  const validId = Number.isSafeInteger(id) && id > 0;
  const [section, setSection] = useState<ProfileSection>(
    params.section === 'documents' ? 'documents' : 'overview'
  );

  const { data, isLoading, isFetching, isError, error, refetch } = useGetDeviceQuery(id, {
    skip: !validId,
    pollingInterval: 30_000,
    skipPollingIfUnfocused: true,
  });

  const readiness = useMobileGpsReadiness();

  if (!validId) {
    return <ErrorRetryView message="This vehicle link is invalid." onRetry={() => router.back()} />;
  }
  if (isLoading) return <LoadingView label="Loading vehicle details…" />;
  if (isError || !data) return <ErrorRetryView message={apiErrorMessage(error)} onRetry={refetch} />;

  // The same resolved status the vehicle list and map show for this device.
  const resolvedState = resolveDeviceRecordState(data, readiness);
  const stateColor = stateColors[resolvedState.state] ?? stateColors.NO_DATA;
  const openLiveTrack = () =>
    router.push({
      pathname: '/live-track',
      params: {
        deviceId: String(data.id),
        name: data.name,
        subtitle: data.address ?? '',
        category: data.category,
      },
    });

  /**
   * Opens Playback for THIS vehicle.
   *
   * Every value is coerced to a defined string before it is handed to the
   * router. `data` is typed as complete, but it is a network payload: a field
   * the API omitted arrives as `undefined`, and an undefined param value throws
   * inside expo-router's URL builder — from an onPress handler, with no error
   * boundary above it, which exits the app rather than showing a broken screen.
   *
   * `deviceId` is the one param the destination cannot work without, so it is
   * checked rather than defaulted; the rest are presentational and fall back.
   */
  const openPlayback = () => {
    if (!Number.isSafeInteger(data.id) || data.id <= 0) return;
    router.push({
      pathname: '/trip-playback',
      params: {
        deviceId: String(data.id),
        // Carried so the Playback screen can identify the vehicle on its own,
        // without a second lookup, and so the header never falls back to a
        // bare "#id" for a device whose name has not loaded.
        imei: typeof data.imei === 'string' ? data.imei : '',
        name: typeof data.name === 'string' && data.name.trim() ? data.name : `Vehicle ${data.id}`,
        category: typeof data.category === 'string' ? data.category : '',
        model: typeof data.model === 'string' ? data.model : '',
        speed: String(Number.isFinite(data.speed) ? data.speed : 0),
        heading: String(Number.isFinite(data.course) ? data.course : 0),
      },
    });
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
        showsVerticalScrollIndicator={false}>
        <VehicleHero
          data={data}
          isFetching={isFetching}
          onBack={() => router.back()}
          onRefresh={() => refetch()}
          resolvedState={resolvedState}
          safeTop={insets.top}
          stateColor={stateColor}
        />

        <View style={styles.body}>
          <View style={styles.actionDeck}>
            <QuickAction color={c.primary} icon="crosshairs-gps" label="Live" onPress={openLiveTrack} primary />
            <QuickAction color={c.info} icon="map-clock-outline" label="Playback" onPress={openPlayback} />
            <QuickAction
              color={c.warning}
              icon="folder-multiple-outline"
              label="Documents"
              onPress={() => setSection('documents')}
            />
          </View>

          <View style={styles.segmentedControl}>
            <SegmentButton active={section === 'overview'} label="Overview" onPress={() => setSection('overview')} />
            <SegmentButton active={section === 'documents'} label="Documents" onPress={() => setSection('documents')} />
          </View>

          {section === 'overview' ? (
            <Overview data={data} stateColor={stateColor} />
          ) : (
            <DocumentLibrary deviceId={data.id} />
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function VehicleHero({
  data,
  isFetching,
  onBack,
  onRefresh,
  resolvedState,
  safeTop,
  stateColor,
}: {
  data: DeviceDetail;
  isFetching: boolean;
  onBack: () => void;
  onRefresh: () => void;
  /** Resolved once by the screen so the hero cannot show a different status. */
  resolvedState: ResolvedDeviceState;
  safeTop: number;
  stateColor: string;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const hasLocation = data.latitude != null && data.longitude != null;
  const canRenderMap = hasLocation && Platform.OS !== 'web' && nativeMapsAvailable;

  return (
    <View style={styles.hero}>
      {canRenderMap ? (
        <MapView
          initialRegion={{
            latitude: data.latitude!,
            longitude: data.longitude!,
            latitudeDelta: 0.008,
            longitudeDelta: 0.008,
          }}
          pitchEnabled={false}
          pointerEvents="none"
          rotateEnabled={false}
          scrollEnabled={false}
          style={StyleSheet.absoluteFillObject}
          zoomEnabled={false}>
          <Marker
            anchor={{ x: 0.5, y: 0.5 }}
            coordinate={{ latitude: data.latitude!, longitude: data.longitude! }}
            flat={false}>
            <VehicleMarker
              category={markerCategory(data.category)}
              color={stateColor}
              heading={data.course ?? 0}
              moving={resolvedState.state === 'RUNNING' && (data.speed ?? 0) > 0}
              selected
              size={96}
            />
          </Marker>
        </MapView>
      ) : (
        <LinearGradient colors={['#172235', '#07101D']} style={StyleSheet.absoluteFillObject} />
      )}

      <LinearGradient
        colors={['rgba(5,12,23,0.04)', 'rgba(5,12,23,0.18)', 'rgba(5,12,23,0.96)']}
        locations={[0, 0.68, 1]}
        style={StyleSheet.absoluteFillObject}
      />

      <View style={[styles.heroToolbar, { top: Math.max(safeTop, spacing.sm) + spacing.xs }]}>
        <GlassButton accessibilityLabel="Go back" icon="arrow-left" onPress={onBack} />
        <GlassButton
          accessibilityLabel="Refresh vehicle"
          icon="refresh"
          loading={isFetching}
          onPress={onRefresh}
        />
      </View>

      {!canRenderMap ? (
        <View style={styles.noLocationIcon}>
          <VehicleMarker
            category={markerCategory(data.category)}
            color={stateColor}
            heading={0}
            selected
            size={118}
          />
        </View>
      ) : null}

      <View style={styles.heroIdentity}>
        <View style={styles.heroEyebrowRow}>
          <View style={[styles.heroStatus, { borderColor: hexToRgba(stateColor, 0.6) }]}>
            <View style={[styles.heroStatusDot, { backgroundColor: stateColor }]} />
            <Text style={[styles.heroStatusText, { color: stateColor }]}>{resolvedState.label}</Text>
          </View>
          <Text style={styles.heroCategory}>{formatLabel(data.category)}</Text>
        </View>
        <Text numberOfLines={1} style={styles.heroName}>{data.vehicleName || data.name}</Text>
        <Text numberOfLines={1} style={styles.heroMeta}>
          {data.model || 'Vehicle'} · IMEI {data.imei}
        </Text>
      </View>
    </View>
  );
}

function Overview({ data, stateColor }: { data: DeviceDetail; stateColor: string }) {
  const { colors: c } = useTheme();
  // "Updated" is a function of the timestamp AND of now. Without a clock of its
  // own it is only recomputed when the device data changes - and a vehicle that
  // has stopped reporting produces no new data, so the figure froze at whatever
  // it read when the screen was opened. A device seen 15 minutes ago still
  // showed "7m" because that was true when the screen mounted.
  const nowMs = useNowTick();
  const styles = useMemo(() => makeStyles(c), [c]);
  const speedUnit = data.speedUnit === 'MPH' ? 'mph' : 'km/h';
  // A phone acting as the tracker has no SIM, model or real IMEI of its own.
  const isMobileGps = data.sourceType === 'MOBILE_GPS';

  return (
    <View style={styles.sectionStack}>
      <View style={styles.kpiGrid}>
        <Kpi icon="speedometer" label="Speed" tone={stateColor} value={`${Math.round(data.speed ?? 0)}`} unit={speedUnit} />
        <Kpi
          icon="engine-outline"
          label="Ignition"
          tone={data.ignition ? c.success : c.textMuted}
          value={data.ignition == null ? '—' : data.ignition ? 'On' : 'Off'}
        />
        <Kpi
          icon="crosshairs-gps"
          label="GPS fix"
          tone={data.gpsValid ? c.success : c.danger}
          value={data.gpsValid ? 'Valid' : 'Invalid'}
        />
        <Kpi icon="update" label="Updated" tone={c.info} value={formatAge(data.lastUpdate, nowMs)} />
      </View>

      <DetailCard icon="map-marker-outline" title="Live location">
        <DetailRow label="Address" value={data.address ?? 'Location unavailable'} multiline />
        <DetailRow
          label="Coordinates"
          value={
            data.latitude != null && data.longitude != null
              ? `${data.latitude.toFixed(5)}, ${data.longitude.toFixed(5)}`
              : 'No GPS coordinates'
          }
        />
        <DetailRow label="Last update" value={formatDateTime(data.lastUpdate)} />
      </DetailCard>

      <DetailCard icon="account-outline" title="Driver details">
        <DetailRow label="Driver" value={data.driverName ?? 'Not added'} />
        <DetailRow label="Contact" value={data.driverPhone ?? 'Not added'} />
        <DetailRow label="Address" value={data.driverAddress ?? 'Not added'} />
      </DetailCard>

      <DetailCard icon="car-info" title="Vehicle & tracker">
        <DetailRow label="Vehicle" value={data.vehicleName ?? data.name} />
        <DetailRow label="Category" value={formatLabel(data.category)} />
        <DetailRow label="Tracking source" value={isMobileGps ? 'Mobile GPS' : 'GPS tracker'} />
        {isMobileGps ? null : <DetailRow label="Model" value={data.model ?? 'Not added'} />}
        {isMobileGps ? null : <DetailRow label="IMEI" value={data.imei} mono />}
        <DetailRow label="Tracker status" value={formatDeviceState(data.status)} />
        <DetailRow label="Subscription expiry" value={formatDate(data.expiryDate)} />
      </DetailCard>

      {/* A Mobile GPS device has no SIM of its own -- the fix comes from the
          phone's own radio -- so SIM number, provider and APN are meaningless
          here and only ever rendered "Not added". */}
      {isMobileGps ? (
        <DetailCard icon="cellphone-marker" title="Connectivity">
          <DetailRow label="GPS source" value="Mobile device" />
          <DetailRow label="Timezone" value={data.timezone ?? 'Asia/Kolkata'} />
        </DetailCard>
      ) : (
        <DetailCard icon="sim-outline" title="Connectivity">
          <DetailRow label="SIM number" value={data.simNumber ?? 'Not added'} mono />
          <DetailRow label="Provider" value={data.simProvider ?? 'Not added'} />
          <DetailRow label="APN" value={data.simApn ?? 'Not added'} mono />
          <DetailRow label="Timezone" value={data.timezone ?? 'Asia/Kolkata'} />
        </DetailCard>
      )}
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

  const expiring = data.filter((document) => expiryTone(document.expiryDate).key !== 'valid').length;

  const openDocument = async (document: VehicleDocumentDto) => {
    if (openingId != null) return;
    setOpeningId(document.id);
    try {
      const content = await getContent({ deviceId, documentId: document.id }).unwrap();
      await openVehicleDocument(content);
    } catch (caught) {
      Alert.alert('Document unavailable', apiErrorMessage(caught, 'The document could not be opened.'));
    } finally {
      setOpeningId(null);
    }
  };

  const confirmDelete = (document: VehicleDocumentDto) => {
    Alert.alert(
      'Delete document?',
      `${document.name} will be permanently removed from this vehicle.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingId(document.id);
            try {
              await deleteDocument({ deviceId, documentId: document.id }).unwrap();
            } catch (caught) {
              Alert.alert('Delete failed', apiErrorMessage(caught));
            } finally {
              setDeletingId(null);
            }
          },
        },
      ]
    );
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
        Alert.alert('File is too large', 'Choose a document smaller than 8 MB.');
        return;
      }
      setAsset(picked);
      setDraft((current) => ({
        ...current,
        name: current.name || stripExtension(picked.name),
      }));
    } catch (caught) {
      Alert.alert('File picker unavailable', apiErrorMessage(caught, 'Please try selecting the file again.'));
    }
  };

  const submit = async () => {
    if (!asset) {
      Alert.alert('Select a file', 'Choose the PDF, image, text or Word document to upload.');
      return;
    }
    if (!draft.name.trim()) {
      Alert.alert('Document name required', 'Add a short name so the file is easy to identify.');
      return;
    }
    if (draft.expiryDate && !isIsoDate(draft.expiryDate)) {
      Alert.alert('Invalid expiry date', 'Use YYYY-MM-DD, for example 2027-03-31.');
      return;
    }

    try {
      const contentBase64 = await documentAssetBase64(asset);
      const estimatedBytes = Math.floor((contentBase64.length * 3) / 4);
      if (estimatedBytes > MAX_VEHICLE_DOCUMENT_BYTES) {
        Alert.alert('File is too large', 'Choose a document smaller than 8 MB.');
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
      Alert.alert('Upload failed', apiErrorMessage(caught, 'The document could not be uploaded.'));
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
    </Modal>
  );
}

function QuickAction({ color, disabled, icon, label, onPress, primary = false }: {
  color: string;
  disabled?: boolean;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.quickAction, disabled && styles.buttonDisabled, pressed && styles.pressed]}>
      <View style={[styles.quickActionIcon, { backgroundColor: primary ? color : hexToRgba(color, 0.12) }]}>
        <MaterialCommunityIcons color={primary ? c.onPrimary : color} name={icon} size={22} />
      </View>
      <Text style={styles.quickActionText}>{label}</Text>
    </Pressable>
  );
}

function GlassButton({ accessibilityLabel, icon, loading, onPress }: {
  accessibilityLabel: string;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  loading?: boolean;
  onPress: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable accessibilityLabel={accessibilityLabel} accessibilityRole="button" disabled={loading} onPress={onPress} style={styles.glassButton}>
      {loading ? <ActivityIndicator color="#FFFFFF" size="small" /> : <MaterialCommunityIcons color="#FFFFFF" name={icon} size={23} />}
    </Pressable>
  );
}

function SegmentButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable accessibilityState={{ selected: active }} onPress={onPress} style={[styles.segment, active && styles.segmentActive]}>
      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Kpi({ icon, label, tone, unit, value }: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  label: string;
  tone: string;
  unit?: string;
  value: string;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.kpi}>
      <View style={styles.kpiHeader}>
        <MaterialCommunityIcons color={tone} name={icon} size={17} />
        <Text style={styles.kpiLabel}>{label}</Text>
      </View>
      <Text numberOfLines={1} style={styles.kpiValue}>{value}<Text style={styles.kpiUnit}>{unit ? ` ${unit}` : ''}</Text></Text>
    </View>
  );
}

function DetailCard({ children, icon, title }: {
  children: React.ReactNode;
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  title: string;
}) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.detailCard}>
      <View style={styles.detailCardHeader}>
        <View style={styles.detailCardIcon}><MaterialCommunityIcons color={c.primary} name={icon} size={20} /></View>
        <Text style={styles.detailCardTitle}>{title}</Text>
      </View>
      <View style={styles.detailRows}>{children}</View>
    </View>
  );
}

function DetailRow({ label, mono, multiline, value }: { label: string; mono?: boolean; multiline?: boolean; value: string }) {
  const { colors: c } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={[styles.detailRow, multiline && styles.detailRowMultiline]}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text numberOfLines={multiline ? 3 : 1} style={[styles.detailValue, mono && styles.monoValue]}>{value}</Text>
    </View>
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

function documentTypeIcon(type: string): React.ComponentProps<typeof MaterialCommunityIcons>['name'] {
  return DOCUMENT_TYPES.find((item) => item.key === type)?.icon ?? 'file-outline';
}

function documentTypeColor(type: string, c: ThemeColors) {
  if (type === 'INSURANCE') return c.info;
  if (type === 'PERMIT') return c.warning;
  if (type === 'POLLUTION') return c.success;
  if (type === 'SERVICE') return c.secondary;
  return c.primary;
}

function expiryTone(value?: string | null): { key: 'valid' | 'soon' | 'expired'; label: string } {
  if (!value) return { key: 'valid', label: 'No expiry' };
  const time = new Date(`${value}T23:59:59`).getTime();
  if (Number.isNaN(time)) return { key: 'valid', label: 'No expiry' };
  const days = Math.ceil((time - Date.now()) / 86_400_000);
  if (days < 0) return { key: 'expired', label: `Expired ${formatDate(value)}` };
  if (days <= 30) return { key: 'soon', label: days === 0 ? 'Expires today' : `Expires in ${days}d` };
  return { key: 'valid', label: `Valid until ${formatDate(value)}` };
}

function formatLabel(value?: string | null) {
  if (!value) return 'Not available';
  return value.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value?: string | null) {
  if (!value) return 'Not set';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? 'Not set'
    : date.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateTime(value?: string | null) {
  if (!value) return 'No data received';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'No data received'
    : date.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatAge(value?: string | null, nowMs?: number) {
  if (!value) return 'Never';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return 'Never';
  const now = nowMs != null && Number.isFinite(nowMs) ? nowMs : Date.now();
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return 'Now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Size unavailable';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stripExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

function mimeTypeForName(fileName: string) {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'txt') return 'text/plain';
  if (extension === 'doc') return 'application/msword';
  if (extension === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'application/pdf';
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
