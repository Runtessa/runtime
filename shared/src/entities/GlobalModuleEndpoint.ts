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
import { HttpMethod } from './Module';

@Entity({ name: 'global_module_endpoints' })
@Index(['routePath', 'method'], { unique: true })
export class GlobalModuleEndpoint {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'route_path' })
  routePath!: string;

  @Column({ type: 'enum', enum: HttpMethod, default: HttpMethod.GET })
  method!: HttpMethod;

  @ManyToOne(() => GlobalModulePackage, { onDelete: 'CASCADE' })
  package!: GlobalModulePackage;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
