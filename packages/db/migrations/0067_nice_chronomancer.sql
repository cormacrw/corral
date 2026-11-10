ALTER TABLE "runs" DROP CONSTRAINT "runs_ended_at_matches_state";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_outcome_only_when_ended";--> statement-breakpoint
DROP INDEX "runs_active_number_index";