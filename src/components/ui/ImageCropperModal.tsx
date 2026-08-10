import React, { useState, useRef, useMemo } from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  View,
  Pressable,
  PanResponder,
  Dimensions,
  Image,
} from 'react-native';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@/src/theme/ThemeProvider';
import { radius, spacing, typography } from '@/src/theme/tokens';
import { Button } from './Button';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CROP_SIZE = SCREEN_WIDTH * 0.75;

interface ImageCropperModalProps {
  visible: boolean;
  imageUri: string | null;
  onClose: () => void;
  onSave: (croppedUri: string) => void;
}

export function ImageCropperModal({
  visible,
  imageUri,
  onClose,
  onSave,
}: ImageCropperModalProps) {
  const { colors: c } = useTheme();
  const [zoom, setZoom] = useState<number>(1);
  const [rotation, setRotation] = useState<number>(0);
  const [panX, setPanX] = useState<number>(0);
  const [panY, setPanY] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState(false);

  // Store last values to compute relative gestures
  const panStartRef = useRef({ x: 0, y: 0 });

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          panStartRef.current = { x: panX, y: panY };
        },
        onPanResponderMove: (evt, gestureState) => {
          setPanX(panStartRef.current.x + gestureState.dx);
          setPanY(panStartRef.current.y + gestureState.dy);
        },
      }),
    [panX, panY]
  );

  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  const handleZoomIn = () => {
    setZoom((prev) => Math.min(prev + 0.25, 4));
  };

  const handleZoomOut = () => {
    setZoom((prev) => Math.max(prev - 0.25, 1));
  };

  const handleReset = () => {
    setZoom(1);
    setRotation(0);
    setPanX(0);
    setPanY(0);
  };

  const handleSave = async () => {
    if (!imageUri) return;
    setIsProcessing(true);

    try {
      const actions: any[] = [];

      if (rotation !== 0) {
        actions.push({ rotate: rotation });
      }

      const sizePromise = new Promise<{ width: number; height: number }>((resolve, reject) => {
        Image.getSize(
          imageUri,
          (width, height) => resolve({ width, height }),
          (err) => reject(err)
        );
      });

      const imgSize = await sizePromise;

      const minDim = Math.min(imgSize.width, imgSize.height);
      const cropWidth = minDim / zoom;
      const cropHeight = minDim / zoom;

      const relativeX = (imgSize.width - cropWidth) / 2 - (panX / CROP_SIZE) * cropWidth;
      const relativeY = (imgSize.height - cropHeight) / 2 - (panY / CROP_SIZE) * cropHeight;

      const x = Math.max(0, Math.min(imgSize.width - cropWidth, relativeX));
      const y = Math.max(0, Math.min(imgSize.height - cropHeight, relativeY));

      actions.push({
        crop: {
          originX: Math.round(x),
          originY: Math.round(y),
          width: Math.round(cropWidth),
          height: Math.round(cropHeight),
        },
      });

      actions.push({
        resize: {
          width: 320,
          height: 320,
        },
      });

      const manipResult = await manipulateAsync(imageUri, actions, {
        compress: 0.85,
        format: SaveFormat.JPEG,
      });

      onSave(manipResult.uri);
    } catch (error) {
      console.error('Failed to crop image', error);
    } finally {
      setIsProcessing(false);
    }
  };

  if (!visible || !imageUri) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: c.pageBackground }]}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <MaterialCommunityIcons name="close" size={24} color={c.textPrimary} />
          </Pressable>
          <Text style={[styles.title, { color: c.textPrimary }]}>Edit Profile Photo</Text>
          <View style={{ width: 40 }} />
        </View>

        <View style={styles.cropWorkspace}>
          <View
            {...panResponder.panHandlers}
            style={[
              styles.imageContainer,
              {
                width: CROP_SIZE,
                height: CROP_SIZE,
                borderRadius: CROP_SIZE / 2,
                overflow: 'hidden',
                backgroundColor: '#1E293B',
              },
            ]}
          >
            <Image
              source={{ uri: imageUri }}
              style={{
                width: '100%',
                height: '100%',
                transform: [
                  { translateX: panX },
                  { translateY: panY },
                  { scale: zoom },
                  { rotate: `${rotation}deg` },
                ],
              }}
              resizeMode="contain"
            />
          </View>

          <View pointerEvents="none" style={styles.cropOverlay}>
            <View style={[styles.cropFrame, { width: CROP_SIZE, height: CROP_SIZE, borderRadius: CROP_SIZE / 2 }]} />
          </View>
        </View>

        <View style={[styles.controlsContainer, { backgroundColor: c.surface }]}>
          <View style={styles.toolsRow}>
            <Pressable onPress={handleZoomOut} style={styles.toolBtn}>
              <MaterialCommunityIcons name="magnify-minus" size={22} color={c.textPrimary} />
              <Text style={[styles.toolLabel, { color: c.textSecondary }]}>Zoom Out</Text>
            </Pressable>

            <Pressable onPress={handleZoomIn} style={styles.toolBtn}>
              <MaterialCommunityIcons name="magnify-plus" size={22} color={c.textPrimary} />
              <Text style={[styles.toolLabel, { color: c.textSecondary }]}>Zoom In</Text>
            </Pressable>

            <Pressable onPress={handleRotate} style={styles.toolBtn}>
              <MaterialCommunityIcons name="rotate-right" size={22} color={c.textPrimary} />
              <Text style={[styles.toolLabel, { color: c.textSecondary }]}>Rotate</Text>
            </Pressable>

            <Pressable onPress={handleReset} style={styles.toolBtn}>
              <MaterialCommunityIcons name="restart" size={22} color={c.textPrimary} />
              <Text style={[styles.toolLabel, { color: c.textSecondary }]}>Reset</Text>
            </Pressable>
          </View>

          <View style={styles.footerRow}>
            <Button
              label="Cancel"
              variant="ghost"
              onPress={onClose}
              style={{ flex: 1 }}
            />
            <Button
              label="Save Photo"
              onPress={handleSave}
              loading={isProcessing}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'space-between',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: 48,
    paddingBottom: spacing.md,
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: typography.title,
    fontWeight: '800',
  },
  cropWorkspace: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  imageContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.3)',
  },
  cropOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cropFrame: {
    borderWidth: 2,
    borderColor: '#FFFFFF',
    borderStyle: 'dashed',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
  },
  controlsContainer: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: 36,
  },
  toolsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: spacing.lg,
  },
  toolBtn: {
    alignItems: 'center',
    gap: 4,
    padding: spacing.sm,
  },
  toolLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  footerRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
});
