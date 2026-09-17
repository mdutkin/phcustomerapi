CREATE TYPE "public"."user_role" AS ENUM('patient', 'pharmacist', 'admin');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "user_role" DEFAULT 'patient' NOT NULL;