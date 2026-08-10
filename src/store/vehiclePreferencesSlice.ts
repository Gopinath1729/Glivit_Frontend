import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { CarVariant } from '@/src/components/Vehicle3DMarker';
import { clearActiveTenant, switchFailed, switchSucceeded } from '@/src/store/tenantSlice';

export type VehiclePreferencesState = {
  modelByDevice: Record<string, CarVariant>;
};

const initialState: VehiclePreferencesState = {
  modelByDevice: {},
};

const vehiclePreferencesSlice = createSlice({
  name: 'vehiclePreferences',
  initialState,
  reducers: {
    setVehicleModelPreference(
      state,
      action: PayloadAction<{ deviceKey: string; variant: CarVariant }>
    ) {
      state.modelByDevice[action.payload.deviceKey] = action.payload.variant;
    },
  },
  extraReducers: (builder) => {
    // Keyed by device id, and device ids belong to a tenant: keeping these across a
    // switch would apply one tenant's model choices to another tenant's vehicles.
    builder
      .addCase(switchSucceeded, () => initialState)
      .addCase(switchFailed, () => initialState)
      .addCase(clearActiveTenant, () => initialState);
  },
});

export const { setVehicleModelPreference } = vehiclePreferencesSlice.actions;
export default vehiclePreferencesSlice.reducer;
