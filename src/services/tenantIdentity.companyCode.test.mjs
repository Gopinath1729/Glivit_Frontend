import assert from 'node:assert/strict';
import test from 'node:test';

import { apiErrorMessage } from './apiError.ts';
import {
  buildTenantResolveRequest,
  hasValidTenantSelection,
  normalizeCompanyCode,
  normalizeCompanyCodeInput,
} from './tenantIdentity.ts';

// The company-code screen and RTK Query service are shared by both native
// targets. Running every contract case under both labels makes that intentional
// platform parity visible in the regression output.
for (const platform of ['android', 'ios']) {
  test(`${platform}: valid, lowercase, uppercase, whitespace and hidden characters normalize`, () => {
    assert.equal(normalizeCompanyCodeInput('GLIVT'), 'GLIVT');
    assert.equal(normalizeCompanyCodeInput('glivt'), 'GLIVT');
    assert.equal(normalizeCompanyCodeInput('  GlIvT\n'), 'GLIVT');
    assert.equal(normalizeCompanyCodeInput('\u200Bgl\u200Divt\uFEFF'), 'GLIVT');
  });

  test(`${platform}: invalid blank and invisible-only codes stay invalid`, () => {
    assert.equal(normalizeCompanyCode('   '), null);
    assert.equal(normalizeCompanyCode('\u200B\u200D\uFEFF'), null);
  });

  test(`${platform}: request uses the current normalized code, endpoint and field name`, () => {
    const failedAttempt = buildTenantResolveRequest('nope');
    const validRetry = buildTenantResolveRequest('  glivt  ');

    assert.deepEqual(failedAttempt, {
      url: '/tenant/resolve',
      method: 'POST',
      body: { companyCode: 'NOPE' },
    });
    assert.deepEqual(validRetry, {
      url: '/tenant/resolve',
      method: 'POST',
      body: { companyCode: 'GLIVT' },
    });
    assert.notStrictEqual(failedAttempt, validRetry);
  });

  test(`${platform}: inactive and expired tenant configs are not valid selections`, () => {
    const base = {
      companyCode: 'GLIVT',
      name: 'Glivt',
      appName: 'Glivt',
      primaryColor: '#000000',
      secondaryColor: '#FFFFFF',
      enabledModules: [],
      paymentEnabled: false,
      maxHistoryDays: 90,
    };

    assert.equal(
      hasValidTenantSelection({ companyCode: ' glivt ', tenantConfig: { ...base, status: 'ACTIVE' } }),
      true
    );
    assert.equal(
      hasValidTenantSelection({ companyCode: 'GLIVT', tenantConfig: { ...base, status: 'DISABLED' } }),
      false
    );
    assert.equal(
      hasValidTenantSelection({ companyCode: 'GLIVT', tenantConfig: { ...base, status: 'EXPIRED' } }),
      false
    );
  });

  test(`${platform}: equivalent duplicate spellings produce one canonical identity`, () => {
    const spellings = ['GLIVT', 'glivt', ' GLIVT ', '\u200BGLIVT\uFEFF'];
    assert.deepEqual(new Set(spellings.map(normalizeCompanyCode)), new Set(['GLIVT']));
  });

  test(`${platform}: an HTML gateway failure is never shown as an invalid company code`, () => {
    const message = apiErrorMessage(
      { status: 'PARSING_ERROR', originalStatus: 502, data: '<html>Bad Gateway</html>' },
      'Invalid company code'
    );

    assert.equal(
      message,
      'The server returned an unexpected response (HTTP 502). Check the backend URL or gateway.'
    );
    assert.notEqual(message, 'Invalid company code');
  });
}
