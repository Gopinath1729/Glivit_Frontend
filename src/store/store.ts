import { configureStore } from '@reduxjs/toolkit';

import { baseApi } from '@/src/services/baseApi';
import authReducer from '@/src/store/authSlice';
import notificationsReducer from '@/src/store/notificationsSlice';
import tenantReducer from '@/src/store/tenantSlice';
import vehiclePreferencesReducer from '@/src/store/vehiclePreferencesSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    // Centralised active-tenant state. Every tenant-owned slice below resets itself
    // when this one records a switch, so no screen can read another tenant's state.
    tenant: tenantReducer,
    notifications: notificationsReducer,
    vehiclePreferences: vehiclePreferencesReducer,
    [baseApi.reducerPath]: baseApi.reducer,
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
