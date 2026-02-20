import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'global_module_packages' })
@Index(['name', 'version'], { unique: true })
export class GlobalModulePackage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column()
  version!: string;

  @Column({ name: 'entry_path', default: 'src/index.js' })
  entryPath!: string;

  @Column({ type: 'text', default: '' })
  code!: string;

  @Column({ name: 'code_blob', type: 'text' })
  codeBlob!: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  dependencies!: string[];

  @Column({ name: 'file_extension', default: 'js' })
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

  @Column({ name: 'owner_team_id', type: 'int', nullable: true })
  ownerTeamId?: number | null;

  @Column({ name: 'editor_team_ids', type: 'jsonb', default: () => "'[]'" })
  editorTeamIds!: number[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
