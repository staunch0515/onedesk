import { useEffect, useRef, useState } from "react";
import { Banner, Button, Dialog, FormField, Spinner, Stack, Text, Textarea } from "../../design";
import { useI18n } from "../i18n";
import type { Run, ViewField, ViewNode } from "../protocol";
import type { ProtocolClient } from "../protocol/client";
import { useQuery, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";

/**
 * Writing help (D462, docs/redesign/ai-assist.md): the shell is the only place that draws it. A plugin only says,
 * per field, `assist: { off | hint | format }`; the kernel runs the provider's `assist` action (`assist.start`) as an
 * ordinary run; what comes back is a proposal the user accepts or not. Nothing is written before Accept.
 */

export type AssistMode = "field" | "fill";

/** One field as the provider gets it (contract: ai-assist.md §9). `name` is the field's bind. */
export interface AssistField {
  name: string;
  label: string;
  kind: string;
  language?: string;
  hint?: string;
  format?: string;
  value: string;
}

export interface AssistRequest {
  mode: AssistMode;
  /** mode `field`: the bind of the field to write. */
  field?: string;
  fields: AssistField[];
  page: { title: string; kind: string };
}

const ASSIST_KINDS = new Set(["text", "longtext", "code"]);

/** Editable text, longtext and code fields get help unless the plugin said `assist.off`. */
export function assistable(f: ViewField, pageReadOnly: boolean): boolean {
  return !pageReadOnly && !f.readOnly && !f.param && Boolean(f.bind ?? f.name) && ASSIST_KINDS.has(f.kind) && f.assist?.off !== true;
}

/** Every field on the page that can be helped with, in page order. */
export function assistableFields(view: ViewNode[], pageReadOnly: boolean): ViewField[] {
  return view.flatMap((n) => (n.type === "form" && n.layout !== "strip" ? n.fields.filter((f) => assistable(f, pageReadOnly)) : []));
}

/** Whether a provider is installed and enabled (re-asked when plugins change). */
export function useAssistAvailable(): boolean {
  const q = useQuery((c) => (c.assist ? c.assist.provider().then((p) => p.available, () => false) : Promise.resolve(false)), [], ["plugins"]);
  return q.data === true;
}

type Prepared = { step: "prepare"; policy: string; connection: string; model: string; tokens: number; system: string; request: string };
type Answer = { step: "send"; mode: AssistMode; text?: string; values?: Record<string, string>; model?: string };
type Failure = { error: { code: string; message: string } };

const POLL_MS = 400;
const WAIT_MS = 11 * 60 * 1000;

/** Runs one step and returns the provider's JSON answer; throws the words for the user. */
async function runStep(client: ProtocolClient, tab: TabState, request: AssistRequest, instruction: string, step: "prepare" | "send", onRun: (id: string | null) => void): Promise<Prepared | Answer> {
  if (!client.assist) throw new Error("noProvider");
  const input = JSON.parse(JSON.stringify({ step, instruction, ...request })) as Record<string, never>;
  const id = await client.assist.start({ target: tab.target, tabId: tab.id, envId: tab.envId ?? undefined, input });
  onRun(id);
  const until = Date.now() + WAIT_MS;
  let run: Run | null = null;
  try {
    for (;;) {
      run = await client.run.get(id);
      if (!run || run.status !== "running") break;
      if (Date.now() > until) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    onRun(null);
  }
  if (!run) throw new Error("gone");
  if (run.status === "cancelled") throw new Error("cancelled");
  if (run.status !== "success") throw new Error(run.error?.message || run.status);
  const out = run.output;
  if (!out || out.type !== "text") throw new Error("badOutput");
  const data = JSON.parse(out.text) as Prepared | Answer | Failure;
  if ("error" in data) throw new Error(data.error.message || data.error.code);
  return data;
}

type Stage = { kind: "ask" } | { kind: "working" } | { kind: "preview"; prepared: Prepared } | { kind: "proposal"; values: Record<string, string> };

export function AssistDialog({ tab, request, onClose, onAccept }: { tab: TabState; request: AssistRequest | null; onClose: () => void; onAccept: (values: Record<string, string>) => void }) {
  const { client } = useWorkbench();
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "ask" });
  const [error, setError] = useState<string | null>(null);
  const runId = useRef<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    setStage({ kind: "ask" });
    setError(null);
    return () => {
      live.current = false;
    };
  }, [request]);

  const close = () => {
    if (runId.current) void client.run.cancel(runId.current).catch(() => undefined);
    setInstruction("");
    onClose();
  };
  const fail = (e: unknown) => {
    if (!live.current) return;
    setError(e instanceof Error ? e.message : String(e));
    setStage({ kind: "ask" });
  };
  const track = (id: string | null) => (runId.current = id);

  const send = async () => {
    if (!request) return;
    setStage({ kind: "working" });
    setError(null);
    try {
      const a = (await runStep(client, tab, request, instruction, "send", track)) as Answer;
      if (!live.current) return;
      const values = request.mode === "fill" ? (a.values ?? {}) : { [request.field ?? ""]: a.text ?? "" };
      setStage({ kind: "proposal", values });
    } catch (e) {
      fail(e);
    }
  };
  const prepare = async () => {
    if (!request) return;
    setStage({ kind: "working" });
    setError(null);
    try {
      const p = (await runStep(client, tab, request, instruction, "prepare", track)) as Prepared;
      if (!live.current) return;
      // `allow`: a request may go at once; anything else shows what would be sent first (D426).
      if (p.policy === "allow") await send();
      else setStage({ kind: "preview", prepared: p });
    } catch (e) {
      fail(e);
    }
  };

  const labelOf = (name: string) => request?.fields.find((f) => f.name === name)?.label ?? name;
  const title = request?.mode === "fill" ? t("assist.fillTitle") : t("assist.title", { field: request ? labelOf(request.field ?? "") : "" });

  const footer = (() => {
    switch (stage.kind) {
      case "ask":
        return (
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button variant="primary" icon="sparkles" onClick={() => void prepare()}>
              {t("assist.continue")}
            </Button>
          </>
        );
      case "working":
        return <Button onClick={close}>{t("assist.stop")}</Button>;
      case "preview":
        return (
          <>
            <Button onClick={() => setStage({ kind: "ask" })}>{t("assist.back")}</Button>
            <Button variant="primary" icon="send" onClick={() => void send()}>
              {t("assist.send")}
            </Button>
          </>
        );
      case "proposal":
        return (
          <>
            <Button onClick={() => setStage({ kind: "ask" })}>{t("assist.again")}</Button>
            <Button
              variant="primary"
              icon="check"
              onClick={() => {
                onAccept(stage.values);
                setInstruction("");
                onClose();
              }}
            >
              {t("assist.accept")}
            </Button>
          </>
        );
    }
  })();

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && close()} size="lg" title={title} description={t("assist.description")} footer={footer}>
      <Stack gap="md">
        {error && (
          <Banner tone="danger" title={t("assist.failed")}>
            {error}
          </Banner>
        )}
        {stage.kind === "ask" && (
          <FormField label={t("assist.instruction")}>
            <Textarea rows={3} value={instruction} placeholder={t("assist.instructionPlaceholder")} onChange={(e) => setInstruction(e.target.value)} autoFocus />
          </FormField>
        )}
        {stage.kind === "working" && (
          <Stack direction="row" gap="sm" align="center">
            <Spinner size="sm" />
            <Text tone="muted">{t("assist.working")}</Text>
          </Stack>
        )}
        {stage.kind === "preview" && (
          <>
            <Text tone="muted">{t("assist.previewMeta", { connection: stage.prepared.connection, model: stage.prepared.model || "—", tokens: stage.prepared.tokens })}</Text>
            <FormField label={t("assist.previewTitle")}>
              <Textarea rows={12} readOnly value={stage.prepared.request} />
            </FormField>
          </>
        )}
        {stage.kind === "proposal" && (
          <>
            <Text tone="muted">{t("assist.proposal")}</Text>
            {Object.entries(stage.values).map(([name, value]) => (
              <FormField key={name} label={labelOf(name)}>
                <Textarea rows={request?.mode === "fill" ? 4 : 12} value={value} onChange={(e) => setStage({ kind: "proposal", values: { ...stage.values, [name]: e.target.value } })} />
              </FormField>
            ))}
          </>
        )}
      </Stack>
    </Dialog>
  );
}
