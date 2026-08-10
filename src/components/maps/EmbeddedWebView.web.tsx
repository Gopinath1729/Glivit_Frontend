import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export type EmbeddedWebViewHandle = {
  injectJavaScript: (script: string) => void;
};

export type EmbeddedWebViewMessageEvent = {
  nativeEvent: { data: string };
};

type EmbeddedWebViewProps = {
  onError?: (event: { nativeEvent: { description?: string } }) => void;
  onHttpError?: (event: { nativeEvent: { statusCode: number } }) => void;
  onLoadStart?: () => void;
  onMessage?: (event: EmbeddedWebViewMessageEvent) => void;
  source: { html: string };
  style?: unknown;
};

/**
 * react-native-webview is native-only. On browser builds the same map document
 * runs in a sandboxed srcDoc iframe and exposes the small imperative API used
 * by FleetWebMap.
 */
const EmbeddedWebView = forwardRef<EmbeddedWebViewHandle, EmbeddedWebViewProps>(
  function EmbeddedWebView({ onError, onLoadStart, onMessage, source }, ref) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const onErrorRef = useRef(onError);
    const onLoadStartRef = useRef(onLoadStart);
    const onMessageRef = useRef(onMessage);
    onErrorRef.current = onError;
    onLoadStartRef.current = onLoadStart;
    onMessageRef.current = onMessage;

    useImperativeHandle(
      ref,
      () => ({
        injectJavaScript: (script: string) => {
          try {
            iframeRef.current?.contentWindow?.postMessage(
              { __glivtCommand: true, script },
              '*'
            );
          } catch (error) {
            onErrorRef.current?.({
              nativeEvent: {
                description: error instanceof Error ? error.message : 'Map command failed.',
              },
            });
          }
        },
      }),
      []
    );

    useEffect(() => {
      onLoadStartRef.current?.();
    }, [source.html]);

    useEffect(() => {
      const receive = (event: MessageEvent) => {
        if (event.source !== iframeRef.current?.contentWindow) return;
        const data = event.data as { __glivt?: boolean; payload?: unknown };
        if (!data?.__glivt) return;
        onMessageRef.current?.({ nativeEvent: { data: JSON.stringify(data.payload) } });
      };
      window.addEventListener('message', receive);
      iframeRef.current?.contentWindow?.postMessage({ __glivtPing: true }, '*');
      return () => window.removeEventListener('message', receive);
    }, []);

    return React.createElement('iframe', {
      ref: iframeRef,
      onError: () => onErrorRef.current?.({ nativeEvent: { description: 'Map frame failed to load.' } }),
      onLoad: () => iframeRef.current?.contentWindow?.postMessage({ __glivtPing: true }, '*'),
      sandbox: 'allow-scripts allow-same-origin',
      srcDoc: source.html,
      style: {
        backgroundColor: '#09111D',
        border: 0,
        display: 'block',
        height: '100%',
        width: '100%',
      },
      title: 'Live fleet map',
    });
  }
);

export default EmbeddedWebView;
