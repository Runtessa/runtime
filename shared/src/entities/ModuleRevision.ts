import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Tenant } from './Tenant';
import { ModuleEntity, HttpMethod } from './Module';

@Entity({ name: 'module_revisions' })
@Index(['module', 'revision'], { unique: true })
export class ModuleRevision {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => ModuleEntity, { onDelete: 'CASCADE' })
  module!: ModuleEntity;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  tenant!: Tenant;

  @Column()
  revision!: number;

  @Column()
  routePath!: string;

  @Column({ type: 'enum', enum: HttpMethod })
  method!: HttpMethod;

  @Column({ type: 'text' })
  code!: string;

  @Column({ name: 'file_extension', default: 'js' })
  fileExtension!: string;

  @Column({ nullable: true })
  action?: string;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
