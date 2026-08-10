import type { ExpoWebGLRenderingContext } from 'expo-gl';
import * as THREE from 'three';

type ExpoRendererOptions = Omit<THREE.WebGLRendererParameters, 'canvas' | 'context'>;

function createExpoCanvas(gl: ExpoWebGLRenderingContext) {
  const nativeCanvas = (gl as unknown as WebGLRenderingContext).canvas;
  if (nativeCanvas) {
    return nativeCanvas;
  }

  const canvas = {
    width: gl.drawingBufferWidth,
    height: gl.drawingBufferHeight,
    style: {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setAttribute: () => undefined,
    getContext: () => gl,
  };

  return canvas as unknown as HTMLCanvasElement;
}

export function createExpoThreeRenderer(
  gl: ExpoWebGLRenderingContext,
  options: ExpoRendererOptions = {}
): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    ...options,
    canvas: createExpoCanvas(gl),
    context: gl as unknown as WebGL2RenderingContext,
  });
  renderer.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight, false);
  return renderer;
}
