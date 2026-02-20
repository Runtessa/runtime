import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Tenant } from './Tenant';

@Entity({ name: 'ui_packages' })
@Index(['tenant', 'name', 'version'], { unique: true })
export class UIPackage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Tenant, (tenant) => tenant.id, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

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

  @Column({ name: 'draft_version', default: '' })
  draftVersion!: string;

  @Column({ name: 'published_version', type: 'varchar', nullable: true })
  publishedVersion?: string | null;

  @Column({ name: 'published_code', type: 'text', nullable: true })
  publishedCode?: string | null;

  @Column({ name: 'published_code_blob', type: 'text', nullable: true })
  publishedCodeBlob?: string | null;

  @Column({ name: 'published_dependencies', type: 'jsonb', nullable: true })
  publishedDependencies?: string[] | null;

  @Column({ name: 'published_file_extension', type: 'varchar', nullable: true })
  publishedFileExtension?: string | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
