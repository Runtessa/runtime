import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Tenant } from './Tenant';
import type { MonitoringAlertRule } from './MonitoringAlertRule';

@Entity({ name: 'monitoring_alert_events' })
@Index(['createdAt'])
export class MonitoringAlertEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne('MonitoringAlertRule', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'rule_id' })
  rule!: MonitoringAlertRule;

  @Column({ name: 'rule_id', type: 'uuid' })
  ruleId!: string;

  @ManyToOne('MonitoringSnapshot', 'alerts', {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'snapshot_id' })
  snapshot?: any | null;

  @Column({ name: 'snapshot_id', type: 'uuid', nullable: true })
  snapshotId?: string | null;

  @ManyToOne('Tenant', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant | null;

  @Column({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId?: string | null;

  @Column({ name: 'tenant_hostname', type: 'varchar', nullable: true })
  tenantHostname?: string | null;

  @Column({ name: 'server_name', type: 'varchar' })
  serverName!: string;

  @Column({ name: 'instance_id', type: 'varchar' })
  instanceId!: string;

  @Column({ name: 'metric_key', type: 'varchar' })
  metricKey!: string;

  @Column({ type: 'float', name: 'metric_value' })
  metricValue!: number;

  @Column({ type: 'float' })
  threshold!: number;

  @Column({ type: 'varchar' })
  operator!: string;

  @Column({ type: 'varchar', default: 'warning' })
  severity!: string;

  @Column({ type: 'varchar', default: 'triggered' })
  status!: string;

  @Column({ name: 'webhook_status', nullable: true, type: 'varchar' })
  webhookStatus?: string | null;

  @Column({ name: 'webhook_response', nullable: true, type: 'text' })
  webhookResponse?: string | null;

  @Column({ name: 'webhook_target', nullable: true, type: 'text' })
  webhookTarget?: string | null;

  @Column({ name: 'extra', type: 'jsonb', nullable: true })
  extra?: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
