import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

@Entity("system_logs")
export class SystemLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  level!: string;

  @Column({ type: "varchar" })
  source!: string;

  @Column({ nullable: true, type: "varchar" })
  action!: string | null;

  @Column({ nullable: true, type: "text" })
  message!: string | null;

  @Column("simple-json", { nullable: true })
  meta!: any;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
