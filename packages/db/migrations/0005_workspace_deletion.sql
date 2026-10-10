ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
-- Serialize run creation with project deletion, including launches already preparing.
CREATE FUNCTION guard_live_run_project() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE removed_at timestamptz;
BEGIN
  SELECT deleted_at INTO removed_at FROM projects WHERE id = NEW.project_id FOR UPDATE;
  IF removed_at IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'Cannot start or change a deleted workspace run';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER live_run_project BEFORE INSERT OR UPDATE OF status ON runs FOR EACH ROW EXECUTE FUNCTION guard_live_run_project();
