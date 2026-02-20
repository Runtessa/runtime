import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Tenant } from './Tenant';
import { UIPackage } from './UIEntities';

@Entity({ name: 'ui_package_revisions' })
@Index(['uiPackage', 'revision'], { unique: true })
export class UIPackageRevision {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => UIPackage, { onDelete: 'CASCADE' })
  uiPackage!: UIPackage;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  tenant!: Tenant;

  @Column()
  revision!: number;

  @Column()
  name!: string;

  @Column()
  version!: string;

  @Column({ type: 'text', default: '' })
  code!: string;

  @Column({ name: 'code_blob', type: 'text' })
  codeBlob!: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  dependencies!: string[];

  @Column({ name: 'file_extension', default: 'jsx' })
  fileExtension!: string;

  @Column({ nullable: true })
  action?: string;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy?: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
