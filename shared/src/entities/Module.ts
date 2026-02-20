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

export enum HttpMethod {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT',
  PATCH = 'PATCH',
  DELETE = 'DELETE',
}

@Entity({ name: 'modules' })
@Index(['tenant', 'routePath', 'method'], { unique: true })
export class ModuleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  routePath!: string;

  @Column({ type: 'enum', enum: HttpMethod, default: HttpMethod.GET })
  method!: HttpMethod;

  @Column({ type: 'text' })
  code!: string;

  @Column({ name: 'file_extension', default: 'js' })
  fileExtension!: string;

  @Column({ name: 'draft_version', default: '' })
  draftVersion!: string;

  @Column({ name: 'published_version', type: 'varchar', nullable: true })
  publishedVersion?: string | null;

  @Column({ name: 'published_route_path', type: 'varchar', nullable: true })
  publishedRoutePath?: string | null;

  @Column({ name: 'published_method', type: 'enum', enum: HttpMethod, nullable: true })
  publishedMethod?: HttpMethod | null;

  @Column({ name: 'published_code', type: 'text', nullable: true })
  publishedCode?: string | null;

  @Column({ name: 'published_file_extension', type: 'varchar', nullable: true })
  publishedFileExtension?: string | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt?: Date | null;

  @ManyToOne('Tenant', 'modules', { onDelete: 'CASCADE' })
  tenant!: Tenant;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
