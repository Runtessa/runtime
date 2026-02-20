import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GlobalModulePackage } from './GlobalModulePackage';

@Entity({ name: 'global_module_package_files' })
@Index(['project', 'path'], { unique: true })
export class GlobalModulePackageFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => GlobalModulePackage, { onDelete: 'CASCADE' })
  project!: GlobalModulePackage;

  @Column()
  path!: string;

  @Column({ name: 'file_extension', default: 'ts' })
  fileExtension!: string;

  @Column({ type: 'text', default: '' })
  content!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
