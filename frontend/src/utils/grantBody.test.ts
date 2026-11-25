import { describe, expect, it } from 'vitest';
import { buildGrantBody, type GrantFormValues } from './grantBody';

const form: GrantFormValues = {
  subjectType: 'user',
  email: ' colleague@example.com ',
  organizationId: 'org-1',
  planId: 'plan-1',
  applicationSlug: ' gine ',
  permission: 'read',
  expiresAt: null,
};

describe('buildGrantBody', () => {
  it('sends only the e-mail for a user grant', () => {
    const body = buildGrantBody(form);
    expect(body).toEqual({
      subjectType: 'user',
      subjectEmail: 'colleague@example.com',
      permission: 'read',
      expiresAt: null,
    });
    expect('subjectId' in body).toBe(false);
  });

  it.each([
    ['organization', { subjectId: 'org-1' }],
    ['plan', { subjectId: 'plan-1' }],
    ['application', { subjectId: 'gine' }],
  ] as const)('sends only a subject id for a %s grant', (subjectType, expected) => {
    const body = buildGrantBody({ ...form, subjectType });
    expect(body).toEqual({ subjectType, ...expected, permission: 'read', expiresAt: null });
    expect('subjectEmail' in body).toBe(false);
  });

  it('sends no subject for an everyone grant', () => {
    expect(buildGrantBody({ ...form, subjectType: 'everyone' })).toEqual({
      subjectType: 'everyone',
      permission: 'read',
      expiresAt: null,
    });
  });
});
