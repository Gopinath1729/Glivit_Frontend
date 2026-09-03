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

/**
 * Characters that can be pasted into a field without occupying visible space.
 * Keeping them would make a code look identical to the operator while producing
 * a different request value on both Android and iOS.
 */
const INVISIBLE_COMPANY_CODE_CHARACTERS = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/** Canonical wire/storage form for a company code. */
export function normalizeCompanyCodeInput(value?: string | null): string {
  return (value ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE_COMPANY_CODE_CHARACTERS, '')
    .trim()
    .toUpperCase();
}

export function normalizeCompanyCode(value?: string | null): string | null {
  const normalized = normalizeCompanyCodeInput(value);
  return normalized || null;
}

/**
 * The public tenant-resolution API contract in one testable place. Keeping the
 * path, HTTP method, field name and normalization together prevents the screen
 * and API endpoint from silently drifting apart.
 */
export function buildTenantResolveRequest(companyCode: string) {
  return {
    url: '/tenant/resolve',
    method: 'POST' as const,
    body: { companyCode: normalizeCompanyCodeInput(companyCode) },
  };
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
  const selectedCode = normalizeCompanyCode(value.companyCode);
  const sessionCode = normalizeCompanyCode(value.sessionCompanyCode);
  return Boolean(
    selectedCode &&
      sessionCode &&
      sessionCode === selectedCode &&
      value.accessToken &&
      value.refreshToken &&
      value.user &&
      Number.isSafeInteger(value.user.tenantId) &&
      value.user.tenantId > 0
  );
}
