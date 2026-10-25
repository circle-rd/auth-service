CREATE TABLE "registration_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"application_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registration_invitations" ADD CONSTRAINT "registration_invitations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "registration_invitations_token_hash_idx" ON "registration_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "registration_invitations_email_idx" ON "registration_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "registration_invitations_app_idx" ON "registration_invitations" USING btree ("application_id");