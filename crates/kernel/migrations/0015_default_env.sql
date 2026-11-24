-- 0015 (D473): a resource, group or tree may name the environment its pages open in by default;
-- NULL = follow the place above (the group, then the tree, then the workspace).
ALTER TABLE resources ADD COLUMN default_env TEXT;
