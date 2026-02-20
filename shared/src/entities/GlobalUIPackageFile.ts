import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GlobalUIPackage } from './GlobalUIPackage';

@Entity({ name: 'global_ui_package_files' })
@Index(['project', 'path'], { unique: true })
export class GlobalUIPackageFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => GlobalUIPackage, { onDelete: 'CASCADE' })
  project!: GlobalUIPackage;

  @Column()
  path!: string;

  @Column({ name: 'file_extension', default: 'tsx' })
  fileExtension!: string;

  @Column({ type: 'text', default: '' })
  content!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
