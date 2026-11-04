CREATE TABLE "work_item_leases" (
	"work_item_id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"run_id" text NOT NULL,
	"lease_token" uuid NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_command" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_item_leases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "work_item_leases" FORCE ROW LEVEL SECURITY;
