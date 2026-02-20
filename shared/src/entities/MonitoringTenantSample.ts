import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { Tenant } from './Tenant';

@Entity({ name: 'monitoring_tenant_samples' })
@Index(['tenantId', 'createdAt'])
export class MonitoringTenantSample {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne('MonitoringSnapshot', 'tenantSamples', {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'snapshot_id' })
  snapshot!: any;

  @ManyToOne('Tenant', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant | null;

  @Column({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId?: string | null;

  @Column({ name: 'tenant_hostname', type: 'varchar', nullable: true })
  tenantHostname?: string | null;

  @Column({ type: 'int', name: 'request_count', default: 0 })
  requestCount!: number;

  @Column({ type: 'int', name: 'error_count', default: 0 })
  errorCount!: number;

  @Column({ type: 'float', name: 'error_rate_pct', default: 0 })
  errorRatePct!: number;

  @Column({ type: 'float', name: 'avg_latency_ms', default: 0 })
  avgLatencyMs!: number;

  @Column({ type: 'float', name: 'p95_latency_ms', default: 0 })
  p95LatencyMs!: number;

  @Column({ type: 'float', name: 'max_latency_ms', default: 0 })
  maxLatencyMs!: number;

  @Column({ type: 'float', name: 'network_in_bytes', default: 0 })
  networkInBytes!: number;

  @Column({ type: 'float', name: 'network_out_bytes', default: 0 })
  networkOutBytes!: number;

  @Column({ type: 'timestamp with time zone', name: 'created_at', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}
