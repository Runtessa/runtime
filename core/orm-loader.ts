import { OrmModel } from '@idp/shared';
import { loadDynamicOrmEntities } from '@idp/shared/dist/runtime/orm-loader';
import { compileOrmSource } from './orm-compiler';

// Called by the restricted runtime process; entity classes stay in that process.
export const loadOrmEntitiesFromModels = (models: OrmModel[]) => loadDynamicOrmEntities(models.map((model) => {
  const compiled = model.compiledCode?.code;
  const source = model.sourceCode?.code;
  if (!compiled && !source) throw new Error(`ORM model ${model.path} is missing source and compiled code`);
  return { path: model.path, code: compiled ?? compileOrmSource(source!) };
}));
