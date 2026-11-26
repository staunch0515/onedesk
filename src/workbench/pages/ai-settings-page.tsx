import { useEffect, useState } from "react";
import { Banner, Button, FormField, Input, LoadingState, Pane, Section, Select, Switch, Text, Textarea, useToast } from "../../design";
import { useI18n } from "../i18n";
import type { PageDescriptor } from "../protocol";
import { useQuery, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { Frame } from "../parts/frame";

export const AI_SETTINGS_TARGET = "shell:ai";
const NONE = "__none__";
/** Where the application bundle puts the program, shown until the main process says where it really is. */
const FALLBACK_COMMAND = "/Applications/OneDesk.app/Contents/MacOS/onedesk-mcp";

/** The frame wants a descriptor; this page belongs to the shell, so it makes its own. */
export function aiSettingsDescriptor(title: string): PageDescriptor {
  return { target: AI_SETTINGS_TARGET, title, icon: "bot", found: true, state: "ok", breadcrumb: [{ label: title, icon: "bot" }], page: "view", view: [], actions: [], resultTabs: [], usesEnv: false, hasInfo: false, readOnly: false, recompute: false, values: {}, autosave: false } as PageDescriptor;
}

/** The text a user pastes into Claude Desktop's configuration (`claude_desktop_config.json`). */
export function claudeDesktopSnippet(command: string): string {
  return JSON.stringify({ mcpServers: { onedesk: { command, args: [] } } }, null, 2);
}

/** A whole number field that saves when it loses focus; an out-of-range or non-numeric entry goes back to what is stored. */
function NumberSetting({ label, description, name, stored, min, max }: { label: string; description: string; name: string; stored: string; min: number; max: number }) {
  const { client, actions } = useWorkbench();
  const { t } = useI18n();
  const [text, setText] = useState(stored);
  useEffect(() => setText(stored), [stored]);
  const n = Number(text);
  const valid = text.trim() !== "" && Number.isInteger(n) && n >= min && n <= max;
  return (
    <FormField label={label} description={description} error={valid ? undefined : t("ai.range", { min, max })}>
      <Input
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => (valid ? n !== Number(stored) && void client.workspace.setConfig(name, String(n)).catch(actions.fail) : setText(stored))}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    </FormField>
  );
}

/**
 * Round 19 (D448): what AI clients connected through MCP may do in this workspace — the `mcp.policy` parameters —
 * and how to connect Claude Desktop. Everything starts off.
 */
export function AiSettingsPage({ tab }: { tab: TabState }) {
  const { client, actions } = useWorkbench();
  const { t } = useI18n();
  const { toast } = useToast();
  const topics = ["config", "mcp"];
  const status = useQuery((c) => c.mcp.status(), [], topics);
  const raw = useQuery(
    async (c) => {
      const names = ["mcp.enabled", "mcp.rate_per_minute", "mcp.max_rows", "mcp.allow_free_query", "mcp.allow_proposals", "mcp.env"];
      const values = await Promise.all(names.map((n) => c.workspace.getConfig(n)));
      return Object.fromEntries(names.map((n, i) => [n, values[i] ?? ""])) as Record<string, string>;
    },
    [],
    topics,
  );
  const envs = useQuery((c) => c.params.envOptions(), [], ["env", "tree:environments"]);
  const info = useQuery((c) => (c.app?.mcpInfo ? c.app.mcpInfo().catch(() => null) : Promise.resolve(null)), [], []);
  const command = { data: info.data?.path ?? null };
  const descriptor = aiSettingsDescriptor(t("ai.title"));
  const set = (name: string, value: string) => void client.workspace.setConfig(name, value).catch(actions.fail);

  const snippet = info.data?.config ?? claudeDesktopSnippet(FALLBACK_COMMAND);
  const copy = (text: string, done: string) => navigator.clipboard.writeText(text).then(() => toast({ tone: "success", title: done }), actions.fail);

  const body = !raw.data || !status.data ? (
    <LoadingState layout="inline" label={t("common.loading")} />
  ) : (
    <>
      <Section title={t("ai.policy")}>
        <Pane gap="md">
          <Switch checked={raw.data["mcp.enabled"] === "true"} label={t("ai.enabled")} description={t("ai.enabledHint")} onCheckedChange={(on) => set("mcp.enabled", String(on))} />
          <NumberSetting label={t("ai.rate")} description={t("ai.rateHint")} name="mcp.rate_per_minute" stored={String(status.data.ratePerMinute)} min={1} max={600} />
          <NumberSetting label={t("ai.rows")} description={t("ai.rowsHint")} name="mcp.max_rows" stored={String(status.data.maxRows)} min={1} max={2000} />
          <Switch checked={raw.data["mcp.allow_free_query"] === "true"} label={t("ai.freeQuery")} description={t("ai.freeQueryHint")} onCheckedChange={(on) => set("mcp.allow_free_query", String(on))} />
          <Switch checked={raw.data["mcp.allow_proposals"] === "true"} label={t("ai.proposals")} description={t("ai.proposalsHint")} onCheckedChange={(on) => set("mcp.allow_proposals", String(on))} />
          <FormField label={t("ai.env")} description={t("ai.envHint")}>
            <Select
              aria-label={t("ai.env")}
              value={raw.data["mcp.env"] || NONE}
              onValueChange={(v) => set("mcp.env", v === NONE ? "" : v)}
              options={[{ value: NONE, label: t("ai.envNone") }, ...(envs.data ?? []).map((e) => ({ value: e.id, label: e.name, depth: e.depth }))]}
            />
          </FormField>
          <Text size="sm" tone="muted">{t("ai.toolCount", { count: status.data.tools })}</Text>
        </Pane>
      </Section>
      <Section title={t("ai.connect")}>
        <Pane gap="sm">
          <Text size="sm">{t("ai.connectBody")}</Text>
          <FormField label={t("ai.programPath")}>
            <Input mono readOnly value={command.data ?? FALLBACK_COMMAND} aria-label={t("ai.programPath")} />
          </FormField>
          <Pane direction="row" gap="sm">
            <Button icon="copy" onClick={() => void copy(command.data ?? FALLBACK_COMMAND, t("ai.copiedPath"))}>{t("ai.copyPath")}</Button>
          </Pane>
          <FormField label={t("ai.configSnippet")} description={t("ai.configHint")}>
            <Textarea mono readOnly rows={9} value={snippet} aria-label={t("ai.configSnippet")} />
          </FormField>
          <Pane direction="row" gap="sm">
            <Button icon="copy" onClick={() => void copy(snippet, t("ai.copiedConfig"))}>{t("ai.copyConfig")}</Button>
          </Pane>
          {info.data === undefined ? null : info.data === null ? <Text size="sm" tone="muted">{t("ai.pathGuess")}</Text> : !info.data.exists && <Text size="sm" tone="muted">{t("ai.pathMissing")}</Text>}
        </Pane>
      </Section>
    </>
  );

  return (
    <Frame tab={tab} descriptor={descriptor}>
      <Pane grow scroll pad="md" gap="md">
        <Banner tone="info" title={t("ai.hintTitle")}>{t("ai.hint")}</Banner>
        {body}
      </Pane>
    </Frame>
  );
}
