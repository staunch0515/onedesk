-- Round 10: "does this node have children" looks up by parent alone. The only index on parents
-- also starts with the tree, so each look-up scanned the table: with 20 000 resources in one level,
-- one batch of 200 nodes took seconds and held the reader for every other request.
CREATE INDEX IF NOT EXISTS resources_parent ON resources (parent_id) WHERE deleted_at IS NULL;
