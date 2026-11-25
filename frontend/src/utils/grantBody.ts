import type { CreateGrantBody, ResourcePermission, ResourceSubjectType } from '@/api/resources';

export interface GrantFormValues {
  subjectType: ResourceSubjectType;
  email: string;
  organizationId: string;
  planId: string;
  applicationSlug: string;
  permission: ResourcePermission;
  // ISO date-time, or null when the grant does not expire.
  expiresAt: string | null;
}

// The API rejects a field that does not belong to the subject type, even as
// `null`, so only the relevant one is sent.
export function buildGrantBody(form: GrantFormValues): CreateGrantBody {
  const base = { permission: form.permission, expiresAt: form.expiresAt };
  switch (form.subjectType) {
    case 'everyone':
      return { ...base, subjectType: 'everyone' };
    case 'user':
      return { ...base, subjectType: 'user', subjectEmail: form.email.trim() };
    case 'organization':
      return { ...base, subjectType: 'organization', subjectId: form.organizationId };
    case 'plan':
      return { ...base, subjectType: 'plan', subjectId: form.planId };
    case 'application':
      return { ...base, subjectType: 'application', subjectId: form.applicationSlug.trim() };
  }
}
