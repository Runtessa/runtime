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
import type { Tenant } from './Tenant';

export type MonitoringRuleScope = 'global' | 'instance' | 'tenant';
export type MonitoringRuleOperator = 'gt' | 'gte' | 'lt' | 'lte';

@Entity({ name: 'monitoring_alert_rules' })
@Index(['enabled', 'scope'])
export class MonitoringAlertRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column({ default: true })
  enabled!: boolean;

  @Column({ type: 'varchar', default: 'global' })
  scope!: MonitoringRuleScope;

  @ManyToOne('Tenant', { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant | null;

  @Column({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId?: string | null;

  @Column({ name: 'metric_key', type: 'varchar' })
  metricKey!: string;

  @Column({ type: 'varchar', default: 'gte' })
  operator!: MonitoringRuleOperator;

  @Column({ type: 'float' })
  threshold!: number;

  @Column({ type: 'int', name: 'cooldown_sec', default: 300 })
  cooldownSec!: number;

  @Column({ type: 'varchar', default: 'warning' })
  severity!: string;

  @Column({ name: 'webhook_url', nullable: true, type: 'text' })
  webhookUrl?: string | null;

  @Column({ name: 'webhook_method', type: 'varchar', nullable: true, default: 'POST' })
  webhookMethod?: string | null;

  @Column({ name: 'webhook_headers', type: 'jsonb', nullable: true })
  webhookHeaders?: Record<string, string> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
