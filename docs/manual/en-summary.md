# OneDesk 1.0 — English summary (one page)

The full user manual is in Chinese (`README.md` and chapters 1–8 in this folder). This page covers the essentials.

**What it is.** A macOS desktop workbench (macOS 11.3+). Everything — notes, saved SQL, data sources, AI connections — is a plugin. Your data stays on your Mac.

**Install / first launch.** The app is signed only locally (ad-hoc), not notarized. The first time, in Finder **Control-click (right-click) OneDesk → Open → Open**. After that, double-click works. (On newer macOS you may instead need System Settings → Privacy & Security → "Open Anyway" — to be confirmed.)

**Where data lives.** `~/Library/Application Support/onedesk/` — one folder per workspace under `workspaces/<name>/` (`workspace.db` plus up to 7 automatic daily snapshots in `backups/`), plugins in `plugins/`, deleted workspaces in `trash/workspaces/`. Passwords and API keys are only in the macOS Keychain, never in files.

**Backup / restore.** Quit the app and copy the whole `onedesk` folder (does not include Keychain secrets), or use Settings menu → *Export workspace…* (readable JSON, no secret values) and *Import…* (shows a preview first). Deleted items can be restored from "Deleted"; each item also has a history.

**Data sources (PostgreSQL).** Two modes: *direct* (local `psql`; password goes to the Keychain) and *over ssh* (`ssh <host>` then `docker exec <container> psql`; ssh must work without a password). All queries are read-only (one statement, read-only transaction, rolled back). Use a read-only database account. "Back up to this Mac" copies a server database into a new database in a local Docker container.

**Saved SQL and query catalog.** Write `:name` parameters in SQL; values are bound safely. The data source comes from the statement, else the environment parameter `datasource`, else workspace config `datasource.default`. The query catalog indexes `.sql` files (with a YAML header) from a folder you authorize, read-only.

**AI.** Create an *Anthropic* connection (API key → Keychain; default model `claude-haiku-5-5`) or an *Ollama* connection (default `http://127.0.0.1:11434`). Pick a default connection. "Analyze" first shows a preview of everything to be sent; nothing leaves your Mac until you press Send. Data goes only to the connection's host (api.anthropic.com or your Ollama). Rows are limited (default 20), sensitive columns masked. Environment parameter `ai.policy`: `off`, `preview` (default), `allow`. Anthropic bills by tokens to your key's account; OneDesk shows token counts, not money.

**MCP (Claude Desktop).** Off by default. Settings menu → *AI access*: master switch, calls per minute (30), rows per result (200), free queries (off), environment for AI runs. Mark each resource *Visible to AI*. Then add the output of `onedesk-mcp --print-config` (`{"mcpServers":{"onedesk":{"command":"<path>"}}}`) to Claude Desktop's `claude_desktop_config.json` and restart it. AI can only read, never sees secrets, and every call is audited.

**Items still to be confirmed** are listed in `docs/handoff/round20-docs-done.md`.
