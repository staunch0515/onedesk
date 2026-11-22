-- 0014: round 19 (D448). `ai_visible` meant "an AI client may see this resource"; 0001 gave it the
-- default 1, but nothing used it. The design says off by default, so: every existing row goes to
-- 0, and a trigger turns every new row off (SQLite cannot change a column default; 0001 stays).
-- Only `resource.setAiVisible` turns it on.

UPDATE resources SET ai_visible = 0;

CREATE TRIGGER IF NOT EXISTS resources_ai_visible_off AFTER INSERT ON resources
WHEN NEW.ai_visible <> 0
BEGIN
  UPDATE resources SET ai_visible = 0 WHERE id = NEW.id;
END;
