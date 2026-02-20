import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Tenant } from './Tenant';

@Entity({ name: 'orm_models' })
@Index(['tenant', 'path'], { unique: true })
export class OrmModel {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne('Tenant', 'ormModels', { onDelete: 'CASCADE' })
  tenant!: Tenant;

  @Column()
  path!: string;

  @Column({ type: 'text', default: '' })
  code!: string;

  @Column({ name: 'code_blob', type: 'text', default: '' })
  codeBlob!: string;

  @Column({ name: 'file_extension', default: 'js' })
  fileExtension!: string;

  @Column({ name: 'draft_version', default: '' })
  draftVersion!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
