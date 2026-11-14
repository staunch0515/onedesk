/** App preferences (`app_settings`): JSON values keyed by string; used by the shell for menu order, theme, etc. */
import type { SqlDriver } from "./contracts";
import type { EventBus } from "./events";
import { OneDeskError } from "../plugin-api";
import { parseJson } from "./util";

export class Prefs {
  constructor(
    private readonly db: SqlDriver,
    private readonly events: EventBus,
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const rows = await this.db.select<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", [key]);
    const row = rows[0];
    return row ? parseJson<T | undefined>(row.value, undefined) : undefined;
  }

  /** `undefined` removes the key. */
  async set(key: string, value: unknown): Promise<void> {
    if (!key) throw new OneDeskError("validation", "设置项的名字不能为空");
    if (value === undefined) {
      await this.db.execute("DELETE FROM app_settings WHERE key = ?", [key]);
    } else {
      await this.db.execute("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
        key,
        JSON.stringify(value),
      ]);
    }
    this.events.emit({ type: "prefs.changed", key });
  }
}
