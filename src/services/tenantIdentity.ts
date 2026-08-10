import type { AuthUser, TenantConfig } from '@/src/types/api';

export type TenantSelection = {
  companyCode: string | null;
  tenantConfig: TenantConfig | null;
};

export type TenantSession = TenantSelection & {
  accessToken: string | null;
  refreshToken: string | null;
  sessionCompanyCode: string | null;
  user: AuthUser | null;
};

export function normalizeCompanyCode(value?: string | null): string | null {
  const normalized = value?.trim().toUpperCase() ?? '';
  return normalized || null;
}

export function hasValidTenantSelection(value: TenantSelection): boolean {
  const selectedCode = normalizeCompanyCode(value.companyCode);
  const configuredCode = normalizeCompanyCode(value.tenantConfig?.companyCode);
  const isStatusActive = value.tenantConfig?.status
    ? value.tenantConfig.status.toUpperCase() === 'ACTIVE'
    : true;
  return Boolean(
    selectedCode &&
      (configuredCode ? configuredCode === selectedCode : true) &&
      isStatusActive
  );
}

export function hasValidTenantSession(value: TenantSession): boolean {
  const isSessionCodeValid = value.sessionCompanyCode
    ? normalizeCompanyCode(value.sessionCompanyCode) === normalizeCompanyCode(value.companyCode)
    : true;
  return Boolean(
    value.companyCode &&
      value.accessToken &&
      value.refreshToken &&
      value.user &&
      Number.isSafeInteger(value.user.tenantId) &&
      value.user.tenantId > 0 &&
      isSessionCodeValid
  );
}
