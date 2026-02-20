import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true, type: "varchar" })
  email!: string;

  @Index({ unique: true })
  @Column({ nullable: true, type: "varchar" })
  token!: string | null;

  @Column({ name: "password_hash", nullable: true, type: "varchar" })
  passwordHash!: string | null;

  @Column({ default: "user", type: "varchar" })
  role!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
