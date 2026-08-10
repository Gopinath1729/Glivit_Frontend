import { forwardRef, type ReactNode } from 'react';

type StubProps = {
  children?: ReactNode;
  [key: string]: unknown;
};

/**
 * Web screens render FleetWebMap instead. These inert exports keep Metro from
 * pulling react-native-maps' native codegen modules into the web bundle.
 */
const NativeMapWebStub = forwardRef<unknown, StubProps>(function NativeMapWebStub() {
  return null;
});

export function Marker(_props: StubProps) {
  return null;
}

export function Circle(_props: StubProps) {
  return null;
}

export function Polyline(_props: StubProps) {
  return null;
}

export default NativeMapWebStub;
