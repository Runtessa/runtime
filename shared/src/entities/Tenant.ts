import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import { Account } from "./Account";
import { Secret } from "./Secret";
import { ModuleEntity } from "./Module";
import { OrmModel } from "./OrmModel";

@Entity({ name: "tenants" })
@Unique(["hostname"])
export class Tenant {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  hostname!: string;

  @Column({ type: "jsonb", default: () => '\'{"memory":512,"timeout":5000}\'' })
  resourceConfig!: {
    memory: number;
    timeout: number;
  };

  @Column({ type: "jsonb", default: () => "'{}'" })
  adapterAccess!: Record<string, { allow: string[] }>;

  @Column({ type: "jsonb", default: () => "'{}'" })
  adapterConfig!: Record<string, unknown>;

  @Column({ type: "jsonb", default: () => '\'{"mode":"shared","secretKey":null}\'' })
  authDbConfig!: {
    mode: 'shared' | 'dedicated';
    secretKey?: string | null;
  };

  @Column({ type: "jsonb", default: () => "'{}'" })
  aclPermissions!: { permissions?: Array<{ key: string; label?: string }> };

  @Column({ type: "jsonb", default: () => "'{}'" })
  aclRoles!: { roles?: Record<string, string[]>; groups?: Record<string, string[]> };

  @Column({ type: "jsonb", default: () => "'{}'" })
  aclEndpoints!: Record<
    string,
    {
      read?: string[];
      write?: string[];
      edit?: string[];
      delete?: string[];
      allowAnonymous?: boolean;
    }
  >;

  @Column({ default: false })
  isSuspended!: boolean;

  @Column({ default: true })
  allowRegistration!: boolean;

  @OneToMany(() => Account, (account) => account.tenant, { cascade: true })
  accounts!: Account[];

  @OneToMany(() => Secret, (secret) => secret.tenant, { cascade: true })
  secrets!: Secret[];

  @OneToMany(() => ModuleEntity, (module) => module.tenant, { cascade: true })
  modules!: ModuleEntity[];

  @OneToMany(() => OrmModel, (model) => model.tenant, { cascade: true })
  ormModels!: OrmModel[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

}

export type TenantDTO = Pick<
  Tenant,
  | 'id'
  | 'hostname'
  | 'resourceConfig'
  | 'adapterAccess'
  | 'adapterConfig'
  | 'authDbConfig'
  | 'aclPermissions'
  | 'aclRoles'
  | 'aclEndpoints'
  | 'isSuspended'
  | 'allowRegistration'
  | 'createdAt'
  | 'updatedAt'
>;
