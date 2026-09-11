import React from 'react';

import { AppDialog } from '@/src/components/ui/AppDialog';

type Tone = 'success' | 'danger' | 'info';

type DialogState = {
  busy?: boolean;
  cancelLabel?: string;
  confirmLabel: string;
  message: string;
  onConfirm: () => void;
  title: string;
  tone: Tone;
};

type ConfirmOptions = {
  cancelLabel?: string;
  confirmLabel?: string;
  message: string;
  onConfirm: () => void | Promise<void>;
  title: string;
  tone?: Tone;
};

type NoticeOptions = {
  confirmLabel?: string;
  message: string;
  onDismiss?: () => void;
  title: string;
  tone?: Tone;
};

/**
 * The application's own confirmations, in place of `Alert.alert`.
 *
 * <p>A native alert is drawn by the platform, so it arrives in the platform's
 * colours and typography: on a dark-themed Android device a destructive prompt
 * from this app appeared as a grey system box with no brand on it at all, and
 * on iOS as a stack of blue text. Routing every prompt through one hook gives
 * them a single look, keeps the destructive ones visibly destructive, and lets
 * a confirm hold its dialog open with a spinner while the request is in flight
 * rather than closing and leaving the user guessing.
 *
 * Returns the imperative helpers plus the element to render once per screen.
 */
export function useAppDialog() {
  const [state, setState] = React.useState<DialogState | null>(null);
  // Survives the unmount that a logout or a navigation can cause mid-request.
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const dismiss = React.useCallback(() => setState(null), []);

  /** A single-button acknowledgement. */
  const notify = React.useCallback((options: NoticeOptions) => {
    setState({
      confirmLabel: options.confirmLabel ?? 'OK',
      message: options.message,
      onConfirm: () => {
        setState(null);
        options.onDismiss?.();
      },
      title: options.title,
      tone: options.tone ?? 'info',
    });
  }, []);

  /** A two-button prompt whose action may be async. */
  const confirm = React.useCallback((options: ConfirmOptions) => {
    const run = () => {
      const result = options.onConfirm();
      if (!(result instanceof Promise)) {
        setState(null);
        return;
      }
      // Keep the dialog up, disabled, until the work settles: dismissing first
      // would report success before the server has agreed to anything.
      setState((current) => (current ? { ...current, busy: true } : current));
      void result.finally(() => {
        if (alive.current) setState(null);
      });
    };
    setState({
      cancelLabel: options.cancelLabel ?? 'Cancel',
      confirmLabel: options.confirmLabel ?? 'Confirm',
      message: options.message,
      onConfirm: run,
      title: options.title,
      tone: options.tone ?? 'danger',
    });
  }, []);

  const dialogElement = (
    <AppDialog
      busy={state?.busy ?? false}
      cancelLabel={state?.cancelLabel}
      confirmLabel={state?.confirmLabel ?? 'OK'}
      message={state?.message ?? ''}
      onCancel={state?.cancelLabel ? dismiss : undefined}
      onConfirm={state?.onConfirm ?? dismiss}
      title={state?.title ?? ''}
      tone={state?.tone}
      visible={state != null}
    />
  );

  return { confirm, dialogElement, dismiss, notify };
}
