export type CoreAuthUserRole = 'ADMIN' | 'DEVELOPER' | 'AUDITOR' | 'USER';

export interface CoreAuthOrganization {
  randId: string;
  code: string | null;
  name: string | null;
}

export interface CoreAuthUser {
  id: string;
  email: string;
  role: CoreAuthUserRole | string;
  roles: string[];
  groups: string[];
  organizations: CoreAuthOrganization[];
  tenantOrgRandId: string | null;
  authRandId: string | null;
  firstName: string | null;
  lastName: string | null;
}
