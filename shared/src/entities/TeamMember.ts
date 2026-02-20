import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { Team } from "./Team";
import { User } from "./User";

@Entity("team_members")
@Index(["teamId", "userId"], { unique: true })
export class TeamMember {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: "team_id", type: "int" })
  teamId!: number;

  @Column({ name: "user_id", type: "int" })
  userId!: number;

  @Column({ type: "varchar", default: "observer" })
  role!: string;

  @Column({ type: "jsonb", default: () => "'[\"observer\"]'" })
  roles!: string[];

  @ManyToOne(() => Team, { onDelete: "CASCADE" })
  @JoinColumn({ name: "team_id" })
  team!: Team;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
