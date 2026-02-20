import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Team } from "./Team";

@Entity("team_tenants")
@Index(["teamId", "tenantId"], { unique: true })
export class TeamTenant {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: "team_id", type: "int" })
  teamId!: number;

  @Column({ name: "tenant_id", type: "uuid" })
  tenantId!: string;

  @ManyToOne(() => Team, { onDelete: "CASCADE" })
  @JoinColumn({ name: "team_id" })
  team!: Team;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
