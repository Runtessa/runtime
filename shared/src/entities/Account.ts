import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import type { Tenant } from './Tenant';

export enum AccountRole {
  ADMIN = 'ADMIN',
  DEVELOPER = 'DEVELOPER',
  AUDITOR = 'AUDITOR',
}

@Entity({ name: 'accounts' })
@Unique(['email', 'tenant'])
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  email!: string;

  @Column()
  passwordHash!: string;

  @Column({ type: 'enum', enum: AccountRole, default: AccountRole.DEVELOPER })
  role!: AccountRole;

  @Column({ type: 'jsonb', nullable: true })
  groups?: string[];

  @ManyToOne('Tenant', 'accounts', { onDelete: 'CASCADE' })
  tenant!: Tenant;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
