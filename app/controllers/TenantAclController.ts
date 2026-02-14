import { NextFunction, Response } from 'express';
import { DataSource } from 'typeorm';
import { AppError } from '../../common/AppError';
import { TenantRequest } from '../../types/RequestContext';
import { Tenant } from '@idp/shared';

const defaultPermissions = { permissions: [] as Array<{ key: string; label?: string }> };
const defaultRoles = {
  roles: {} as Record<string, string[]>,
  groups: {} as Record<string, string[]>,
};
const defaultEndpoints = {} as Record<
  string,
  { read?: string[]; write?: string[]; edit?: string[]; delete?: string[]; allowAnonymous?: boolean }
>;

const parseJsonBody = (value: unknown) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
};

const validateEndpointAcl = (endpoints: Record<string, any>) => {
  Object.entries(endpoints || {}).forEach(([path, config]) => {
    if (!config || typeof config !== 'object') {
      throw new AppError(`Invalid ACL config for endpoint ${path}`, 400);
    }
    if (
      (config as any).allowAnonymous !== undefined &&
      typeof (config as any).allowAnonymous !== 'boolean'
    ) {
      throw new AppError(`Endpoint ${path} allowAnonymous must be boolean`, 400);
    }
    const read = Array.isArray((config as any).read) ? (config as any).read : [];
    const write = Array.isArray((config as any).write) ? (config as any).write : [];
    const edit = Array.isArray((config as any).edit) ? (config as any).edit : [];
    const del = Array.isArray((config as any).delete) ? (config as any).delete : [];

    if (write.length > 0 && read.length === 0) {
      throw new AppError(`Endpoint ${path} write requires read permissions`, 400);
    }
    if (edit.length > 0 && write.length === 0) {
      throw new AppError(`Endpoint ${path} edit requires write permissions`, 400);
    }
    if (del.length > 0 && (edit.length === 0 || write.length === 0 || read.length === 0)) {
      throw new AppError(`Endpoint ${path} delete requires read, write, and edit permissions`, 400);
    }
  });
};

export class TenantAclController {
  constructor(private readonly dataSource: DataSource) {}

  getConfig = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) throw new AppError('Tenant required', 400);
      const tenant = req.tenant as Tenant;
      res.status(200).json({
        permissions: tenant.aclPermissions ?? defaultPermissions,
        roles: tenant.aclRoles ?? defaultRoles,
        endpoints: tenant.aclEndpoints ?? defaultEndpoints,
      });
    } catch (error) {
      next(error);
    }
  };

  updateConfig = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) throw new AppError('Tenant required', 400);
      const repo = this.dataSource.getRepository(Tenant);
      const tenant = (req.tenant as Tenant) ?? (await repo.findOne({ where: { id: req.tenant.id } }));
      if (!tenant) throw new AppError('Tenant not found', 404);

      const file = String(req.body?.file || '').toLowerCase();
      const content = parseJsonBody(req.body?.content);

      if (file && !content) {
        throw new AppError('Invalid JSON content', 400);
      }

      if (file === 'permissions') {
        tenant.aclPermissions = (content ?? defaultPermissions) as Tenant['aclPermissions'];
      } else if (file === 'roles') {
        tenant.aclRoles = (content ?? defaultRoles) as Tenant['aclRoles'];
      } else if (file === 'endpoints') {
        validateEndpointAcl(content ?? {});
        tenant.aclEndpoints = (content ?? defaultEndpoints) as Tenant['aclEndpoints'];
      } else {
        const permissions = parseJsonBody(req.body?.permissions);
        const roles = parseJsonBody(req.body?.roles);
        const endpoints = parseJsonBody(req.body?.endpoints);
        if (!permissions && !roles && !endpoints) {
          throw new AppError('No ACL content provided', 400);
        }
        if (permissions) tenant.aclPermissions = permissions as Tenant['aclPermissions'];
        if (roles) tenant.aclRoles = roles as Tenant['aclRoles'];
        if (endpoints) {
          validateEndpointAcl(endpoints);
          tenant.aclEndpoints = endpoints as Tenant['aclEndpoints'];
        }
      }

      await repo.save(tenant);
      res.status(200).json({
        permissions: tenant.aclPermissions ?? defaultPermissions,
        roles: tenant.aclRoles ?? defaultRoles,
        endpoints: tenant.aclEndpoints ?? defaultEndpoints,
      });
    } catch (error) {
      next(error);
    }
  };
}
