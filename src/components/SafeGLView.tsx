import {
  GLView,
  type ExpoWebGLRenderingContext,
} from 'expo-gl';

type SurfaceCreateEvent = {
  nativeEvent: {
    exglCtxId: number;
  };
};

type ExpoGlGlobal = typeof globalThis & {
  __EXGLContexts?: Record<string, ExpoWebGLRenderingContext>;
};

/**
 * Expo GL's stock surface callback configures logging before checking that the
 * native context exists. On a delayed or recycled Android surface that can
 * throw while assigning `__expoSetLogging` to undefined. This subclass keeps
 * Expo's native view/lifecycle but ignores an invalid surface event, allowing
 * the caller's normal image fallback to remain mounted.
 */
export class SafeGLView extends GLView {
  _onSurfaceCreate = ({ nativeEvent: { exglCtxId } }: SurfaceCreateEvent) => {
    const contexts = (globalThis as ExpoGlGlobal).__EXGLContexts;
    const gl = contexts?.[String(exglCtxId)];
    if (!gl) {
      console.warn('[SafeGLView] Native GL context was unavailable; keeping the fallback renderer.');
      return;
    }

    this.exglCtxId = exglCtxId;
    try {
      this.props.onContextCreate?.(gl);
    } catch (error) {
      console.warn('[SafeGLView] GL context setup failed; keeping the fallback renderer.', error);
    }
  };
}
