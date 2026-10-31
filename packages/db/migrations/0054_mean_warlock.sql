CREATE INDEX "plan_messages_run_id_index" ON "plan_messages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "plan_tasks_task_id_index" ON "plan_tasks" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "evidence_run_id_index" ON "evidence" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "evidence_criterion_id_index" ON "evidence" USING btree ("criterion_id");--> statement-breakpoint
CREATE INDEX "reviews_run_id_index" ON "reviews" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_agent_id_queued_at_index" ON "runs" USING btree ("agent_id","queued_at");--> statement-breakpoint
CREATE INDEX "runs_plan_session_id_index" ON "runs" USING btree ("plan_session_id");--> statement-breakpoint
CREATE INDEX "runs_project_id_index" ON "runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "runs_active_number_index" ON "runs" USING btree ("number") WHERE "runs"."state" in ('queued', 'starting', 'running', 'waiting_for_input', 'stopping');--> statement-breakpoint
CREATE INDEX "audit_log_action_created_at_id_index" ON "audit_log" USING btree ("action","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_log_inbox_history_index" ON "audit_log" USING btree ("created_at","id") WHERE "audit_log"."action" in ('task.transition', 'review.recorded', 'task.deleted');--> statement-breakpoint
CREATE INDEX "tasks_epic_id_index" ON "tasks" USING btree ("epic_id");--> statement-breakpoint
CREATE INDEX "tasks_lease_run_id_index" ON "tasks" USING btree ("lease_run_id");