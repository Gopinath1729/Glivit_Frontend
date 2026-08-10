import { Redirect } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { palette } from '@/src/theme/tokens';
import { useAuth, useHasTenant, useIsAuthenticated } from '@/src/store/hooks';

/**
 * Startup gate. Routes according to persisted state:
 *   no company code   -> Company Code screen
 *   code but no session -> Login
 *   valid session      -> All Vehicles Map (the app home)
 * While bootstrapping it renders the splash-coloured background (native splash
 * is still visible until hydration completes).
 */
export default function Index() {
  const { bootstrapped } = useAuth();
  const hasTenant = useHasTenant();
  const authenticated = useIsAuthenticated();

  if (!bootstrapped) {
    return <View style={{ flex: 1, backgroundColor: palette.loginBackground }} />;
  }
  if (!hasTenant) {
    return <Redirect href="/company-code" />;
  }
  if (!authenticated) {
    return <Redirect href="/login" />;
  }
  return <Redirect href="/map" />;
}
