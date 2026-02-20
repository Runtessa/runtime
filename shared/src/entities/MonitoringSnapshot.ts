import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'monitoring_snapshots' })
@Index(['serverName', 'instanceId', 'createdAt'])
export class MonitoringSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'server_name' })
  serverName!: string;

  @Column({ name: 'instance_id' })
  instanceId!: string;

  @Column({ type: 'float', name: 'cpu_percent', default: 0 })
  cpuPercent!: number;

  @Column({ type: 'float', name: 'memory_rss_mb', default: 0 })
  memoryRssMb!: number;

  @Column({ type: 'float', name: 'memory_heap_used_mb', default: 0 })
  memoryHeapUsedMb!: number;

  @Column({ type: 'float', name: 'memory_heap_total_mb', default: 0 })
  memoryHeapTotalMb!: number;

  @Column({ type: 'float', name: 'storage_total_mb', default: 0 })
  storageTotalMb!: number;

  @Column({ type: 'float', name: 'storage_used_mb', default: 0 })
  storageUsedMb!: number;

  @Column({ type: 'float', name: 'storage_free_mb', default: 0 })
  storageFreeMb!: number;

  @Column({ type: 'float', name: 'storage_used_pct', default: 0 })
  storageUsedPct!: number;

  @Column({ type: 'int', name: 'thread_active_handles', default: 0 })
  threadActiveHandles!: number;

  @Column({ type: 'int', name: 'thread_active_requests', default: 0 })
  threadActiveRequests!: number;

  @Column({ type: 'float', name: 'event_loop_lag_ms', default: 0 })
  eventLoopLagMs!: number;

  @Column({ type: 'float', name: 'network_in_bytes', default: 0 })
  networkInBytes!: number;

  @Column({ type: 'float', name: 'network_out_bytes', default: 0 })
  networkOutBytes!: number;

  @Column({ type: 'int', name: 'request_count', default: 0 })
  requestCount!: number;

  @Column({ type: 'int', name: 'error_count', default: 0 })
  errorCount!: number;

  @Column({ type: 'float', name: 'error_rate_pct', default: 0 })
  errorRatePct!: number;

  @OneToMany('MonitoringTenantSample', 'snapshot', {
    cascade: true,
  })
  tenantSamples!: any[];

  @OneToMany('MonitoringAlertEvent', 'snapshot')
  alerts!: any[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
