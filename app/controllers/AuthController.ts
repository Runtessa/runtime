import { NextFunction, Response } from 'express';
import { DataSource } from 'typeorm';
import { AppError } from '../../common/AppError';
import { CryptoService } from '../../core/security/CryptoService';
import { Account, AccountRole } from '@idp/shared';
import { TenantRequest } from '../../types/RequestContext';

export class AuthController {
  constructor(private readonly dataSource: DataSource, private readonly cryptoService: CryptoService) {}

  register = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) {
        throw new AppError('Tenant required', 400);
      }
      if (req.tenant.allowRegistration === false) {
        return res.status(403).json({ error: 'Registration is disabled for this tenant' });
      }

      const { email, password, role } = req.body ?? {};
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const normalizedEmail = String(email).toLowerCase();
      const resolvedRole = Object.values(AccountRole).includes(role) ? role : AccountRole.DEVELOPER;

      const accountRepo = this.dataSource.getRepository(Account);
      const existing = await accountRepo.findOne({
        where: { email: normalizedEmail, tenant: { id: req.tenant.id } },
        relations: ['tenant'],
      });

      if (existing) {
        return res.status(409).json({ error: 'Account already exists' });
      }

      const passwordHash = await this.cryptoService.hashPassword(String(password));
      const account = accountRepo.create({
        email: normalizedEmail,
        passwordHash,
        role: resolvedRole as AccountRole,
        tenant: req.tenant,
      });

      await accountRepo.save(account);
      res.status(201).json({ id: account.id, email: account.email, role: account.role });
    } catch (error) {
      next(error);
    }
  };

  config = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) {
        throw new AppError('Tenant required', 400);
      }
      res.status(200).json({
        allowRegistration: req.tenant.allowRegistration ?? true,
      });
    } catch (error) {
      next(error);
    }
  };

  login = async (req: TenantRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) {
        throw new AppError('Tenant required', 400);
      }

      const { email, password } = req.body ?? {};
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const accountRepo = this.dataSource.getRepository(Account);
      const account = await accountRepo.findOne({
        where: { email: String(email).toLowerCase(), tenant: { id: req.tenant.id } },
        relations: ['tenant'],
      });

      if (!account) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const passwordMatch = await this.cryptoService.comparePassword(String(password), account.passwordHash);
      if (!passwordMatch) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const ttlSeconds = 60 * 60; // 1 hour
      const token = this.cryptoService.signToken(
        { sub: account.id, tenantId: req.tenant.id, role: account.role },
        ttlSeconds,
      );

      res.json({ token, expiresIn: ttlSeconds });
    } catch (error) {
      next(error);
    }
  };
}
