import 'dotenv/config';
import 'reflect-metadata';
import { AppDataSource, initializeDataSource } from './core/datasource';
import { Tenant, UIPackage, SourceCode, CompiledCode } from '@idp/shared';

const themePackage = {
  name: '@core/theme',
  version: '1.0.0',
  dependencies: [] as string[],
  code: `
    const palette = { primary: '#2563eb', surface: '#0f172a', text: '#e2e8f0' };
    module.exports = { colors: palette };
  `.trim(),
};

const dashboardPackage = {
  name: '@app/dashboard',
  version: '1.0.0',
  dependencies: ['@core/theme'],
  code: `
    const theme = require('@core/theme');

    function App() {
      return React.createElement(
        'div',
        { style: { color: theme.colors.primary, fontFamily: 'Inter, system-ui, sans-serif', padding: '24px' } },
        React.createElement('h1', null, 'Hello Dashboard'),
        React.createElement('p', null, 'Server-driven micro-frontend mounted from the registry.')
      );
    }

    module.exports = {
      mount: function(container) {
        if (!container) {
          throw new Error('Container not found');
        }
        if (ReactDOM && ReactDOM.createRoot) {
          ReactDOM.createRoot(container).render(React.createElement(App));
        } else {
          ReactDOM.render(React.createElement(App), container);
        }
      }
    };
  `.trim(),
};

const packages = [themePackage, dashboardPackage];

const seedPackages = async () => {
  await initializeDataSource();
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const pkgRepo = AppDataSource.getRepository(UIPackage);
  const sourceRepo = AppDataSource.getRepository(SourceCode);
  const compiledRepo = AppDataSource.getRepository(CompiledCode);

  const tenants = await tenantRepo.find();
  if (!tenants.length) {
    throw new Error('No tenants found. Seed tenants first.');
  }

  for (const tenant of tenants) {
    for (const pkg of packages) {
      await upsertPackage(pkgRepo, sourceRepo, compiledRepo, tenant.id, pkg);
    }
  }

  await AppDataSource.destroy();
  console.log('Package registry seeded.');
};

const upsertPackage = async (
  repo: ReturnType<typeof AppDataSource.getRepository<UIPackage>>,
  sourceRepo: ReturnType<typeof AppDataSource.getRepository<SourceCode>>,
  compiledRepo: ReturnType<typeof AppDataSource.getRepository<CompiledCode>>,
  tenantId: string,
  pkg: { name: string; version: string; code: string; dependencies: string[] },
) => {
  let existing = await repo.findOne({
    where: { tenant: { id: tenantId }, name: pkg.name, version: pkg.version },
    relations: ['sourceCode', 'compiledCode'],
  });

  if (!existing) {
    const sc = sourceRepo.create({ code: pkg.code });
    const cc = compiledRepo.create({ code: pkg.code });
    await sourceRepo.save(sc);
    await compiledRepo.save(cc);

    existing = repo.create({
      tenant: { id: tenantId } as Tenant,
      name: pkg.name,
      version: pkg.version,
      sourceCode: sc,
      compiledCode: cc,
      dependencies: pkg.dependencies,
    });
  } else {
    if (!existing.compiledCode) {
      throw new Error(
        `Seed package ${pkg.name}@${pkg.version} missing compiledCode relation for tenant ${tenantId}`,
      );
    }
    existing.compiledCode.code = pkg.code;
    await compiledRepo.save(existing.compiledCode);
    existing.dependencies = pkg.dependencies;
  }

  await repo.save(existing);
  console.log(`Upserted package ${pkg.name}@${pkg.version} for tenant ${tenantId}`);
};

seedPackages().catch((err) => {
  console.error('Failed to seed packages:', err);
  process.exit(1);
});
