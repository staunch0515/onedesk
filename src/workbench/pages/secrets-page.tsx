import { useState } from "react";
import { Banner, Button, DataGrid, Dialog, EmptyState, FormField, Input, LoadingState, Pane, Section, Text, type DataGridColumn } from "../../design";
import { useI18n } from "../i18n";
import type { PageDescriptor, SecretInfo } from "../protocol";
import { useQuery, useWorkbench } from "../state/context";
import type { TabState } from "../state/store";
import { Frame } from "../parts/frame";

export const SECRETS_TARGET = "shell:secrets";

/** The frame wants a descriptor; this page belongs to the shell, so it makes its own. */
export function secretsDescriptor(title: string): PageDescriptor {
  return {
    target: SECRETS_TARGET,
    title,
    icon: "key-round",
    found: true,
    state: "ok",
    breadcrumb: [{ label: title, icon: "key-round" }],
    page: "view",
    view: [],
    actions: [],
    resultTabs: [],
    usesEnv: false,
    hasInfo: false,
    readOnly: false,
    recompute: false,
    values: {},
    autosave: false,
  } as PageDescriptor;
}

type Ask = { kind: "change"; name: string } | { kind: "delete"; name: string };

/**
 * Secrets (round 4 §6): names, when they were written and what uses them. A value can be written,
 * never read: it goes to the system keychain and the field is emptied the moment it is sent.
 */
export function SecretsPage({ tab }: { tab: TabState }) {
  const { client, actions } = useWorkbench();
  const { t, dateTime } = useI18n();
  const list = useQuery((c) => (c.secrets ? c.secrets.list() : Promise.resolve([] as SecretInfo[])), [], ["secrets", "plugins"]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [ask, setAsk] = useState<Ask | null>(null);
  const [fresh, setFresh] = useState("");
  const descriptor = secretsDescriptor(t("secrets.title"));

  const save = async (secretName: string, secretValue: string) => {
    try {
      await client.secrets?.set(secretName, secretValue);
      list.reload();
    } catch (error) {
      actions.fail(error);
    }
  };

  const columns: Array<DataGridColumn<SecretInfo>> = [
    { key: "name", header: t("secrets.name"), width: 180, mono: true, value: (s) => s.name },
    { key: "updated", header: t("secrets.updated"), width: 150, value: (s) => s.updatedAt, render: (s) => dateTime(s.updatedAt) },
    { key: "usedBy", header: t("secrets.usedBy"), width: 200, value: (s) => s.usedBy.join(", ") },
    {
      key: "actions",
      header: "",
      width: 170,
      sortable: false,
      resizable: false,
      render: (s) => (
        <Pane direction="row" gap="xs" justify="end">
          <Button size="sm" icon="pencil" onClick={() => setAsk({ kind: "change", name: s.name })}>
            {t("secrets.change")}
          </Button>
          <Button size="sm" variant="ghost" icon="trash-2" onClick={() => setAsk({ kind: "delete", name: s.name })}>
            {t("secrets.delete")}
          </Button>
        </Pane>
      ),
    },
  ];

  const add = () => {
    const n = name.trim();
    if (!n || !value) return;
    const v = value;
    setName("");
    setValue("");
    void save(n, v);
  };

  return (
    <Frame tab={tab} descriptor={descriptor}>
      <Pane grow scroll pad="md" gap="md">
        <Banner tone="info" title={t("secrets.hintTitle")}>
          {t("secrets.hint")}
        </Banner>
        <Section title={t("secrets.add")}>
          <Pane direction="row" gap="sm" align="end" wrap>
            <FormField label={t("secrets.name")}>
              <Input mono value={name} onChange={(e) => setName(e.target.value)} placeholder="api-token" />
            </FormField>
            <FormField label={t("secrets.value")}>
              <Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
            </FormField>
            <Button variant="primary" icon="plus" disabled={!name.trim() || !value} onClick={add}>
              {t("secrets.save")}
            </Button>
          </Pane>
        </Section>
        <Section title={t("secrets.list")}>
          {list.data === undefined ? (
            <LoadingState layout="inline" label={t("common.loading")} />
          ) : list.data.length === 0 ? (
            <EmptyState layout="inline" icon="key-round" message={t("secrets.empty")} />
          ) : (
            <DataGrid label={t("secrets.list")} size="regular" framed autoHeight columns={columns} rows={list.data} getRowKey={(s) => s.name} nullText="" />
          )}
        </Section>
      </Pane>

      <Dialog
        open={ask !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAsk(null);
            setFresh("");
          }
        }}
        size="sm"
        title={ask?.kind === "delete" ? t("secrets.deleteTitle", { name: ask.name }) : t("secrets.changeTitle", { name: ask?.name ?? "" })}
        description={ask?.kind === "delete" ? t("secrets.deleteBody") : t("secrets.changeBody")}
        footer={
          <>
            <Button
              onClick={() => {
                setAsk(null);
                setFresh("");
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant={ask?.kind === "delete" ? "danger" : "primary"}
              disabled={ask?.kind === "change" && !fresh}
              onClick={() => {
                const current = ask;
                const next = fresh;
                setAsk(null);
                setFresh("");
                if (!current) return;
                if (current.kind === "delete") void client.secrets?.delete(current.name).then(() => list.reload(), actions.fail);
                else void save(current.name, next);
              }}
            >
              {ask?.kind === "delete" ? t("secrets.delete") : t("secrets.save")}
            </Button>
          </>
        }
      >
        {ask?.kind === "change" && (
          <FormField label={t("secrets.value")}>
            <Input type="password" autoComplete="off" value={fresh} onChange={(e) => setFresh(e.target.value)} autoFocus />
          </FormField>
        )}
        {ask?.kind === "delete" && <Text size="sm">{ask.name}</Text>}
      </Dialog>
    </Frame>
  );
}
