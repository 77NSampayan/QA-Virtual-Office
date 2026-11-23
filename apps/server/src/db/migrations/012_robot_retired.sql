-- A person can retire a robot they no longer want in the office. It is hidden, never deleted (its sessions keep their
-- history), and it comes back by itself if its session sends a new event.
ALTER TABLE robots ADD COLUMN retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1));
