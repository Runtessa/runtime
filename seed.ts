import 'dotenv/config';
import 'reflect-metadata';
import { AppDataSource, initializeDataSource } from './core/datasource';
import { CryptoService } from './core/security/CryptoService';
import { Tenant } from '@idp/shared';
import { Secret } from '@idp/shared';
import { ModuleEntity, HttpMethod, SourceCode } from '@idp/shared';

const getKeyFromEnv = (envName: string, expectedBytes: number): Buffer => {
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(`${envName} is required`);
  }

  const isHex = /^[a-fA-F0-9]+$/.test(raw) && raw.length === expectedBytes * 2;
  const buffer = isHex ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buffer.length !== expectedBytes) {
    throw new Error(`${envName} must decode to ${expectedBytes} bytes`);
  }
  return buffer;
};

const cryptoService = new CryptoService(getKeyFromEnv('ENCRYPTION_KEY', 32), getKeyFromEnv('TOKEN_SECRET', 32));

const seedTenants = [
  {
    hostname: 'dev.internal.local',
    resourceConfig: { memory: 512, timeout: 30000 },
    secrets: {
      PG_URL: 'postgres://postgres:postgres@localhost:5432/idpcore',
      API_KEY: 'dev-api-key',
    },
  },
  {
    hostname: 'prod.internal.local',
    resourceConfig: { memory: 1024, timeout: 5000 },
    secrets: {
      PG_URL: 'postgres://postgres:postgres@localhost:5432/idpcore',
      API_KEY: 'prod-api-key',
    },
  },
];

const bootstrapSeed = async () => {
  await initializeDataSource();

  for (const tenantSeed of seedTenants) {
    await seedTenant(tenantSeed);
  }

  await AppDataSource.destroy();
  console.log('Seeding completed');
};

const seedTenant = async (seed: (typeof seedTenants)[number]) => {
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const secretRepo = AppDataSource.getRepository(Secret);
  const moduleRepo = AppDataSource.getRepository(ModuleEntity);
  const sourceRepo = AppDataSource.getRepository(SourceCode);

  let tenant = await tenantRepo.findOne({ where: { hostname: seed.hostname } });
  if (!tenant) {
    tenant = tenantRepo.create({
      hostname: seed.hostname,
      resourceConfig: seed.resourceConfig,
      isSuspended: false,
    });
    await tenantRepo.save(tenant);
    console.log(`Created tenant ${seed.hostname}`);
  } else {
    tenant.resourceConfig = seed.resourceConfig;
    tenant.isSuspended = false;
    await tenantRepo.save(tenant);
    console.log(`Updated tenant ${seed.hostname}`);
  }

  for (const [keyName, value] of Object.entries(seed.secrets)) {
    let secret = await secretRepo.findOne({ where: { keyName, tenant: { id: tenant.id } } });
    const encrypted = cryptoService.encryptSecret(value);
    if (!secret) {
      secret = secretRepo.create({
        keyName,
        encryptedValue: encrypted.encryptedValue,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        tenant,
      });
    } else {
      secret.encryptedValue = encrypted.encryptedValue;
      secret.iv = encrypted.iv;
      secret.authTag = encrypted.authTag;
    }
    await secretRepo.save(secret);
  }
  console.log(`Stored secrets for ${seed.hostname}`);

  const sampleModule = await moduleRepo.findOne({
    where: { tenant: { id: tenant.id }, routePath: '/hello', method: HttpMethod.GET },
  });
  const helloCode = `
    module.exports = async function handler(req, adapters) {
      return {
        statusCode: 200,
        body: { message: 'Hello from ${seed.hostname}' }
      };
    };
  `;
  if (!sampleModule) {
    const sourceCode = sourceRepo.create({ code: helloCode });
    await sourceRepo.save(sourceCode);

    const mod = moduleRepo.create({
      routePath: '/hello',
      method: HttpMethod.GET,
      sourceCode,
      tenant,
    });
    await moduleRepo.save(mod);
    console.log(`Created sample module for ${seed.hostname}`);
  }
};

bootstrapSeed().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
