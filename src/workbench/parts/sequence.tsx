import { createContext, useCallback, useContext } from "react";
import { Button, SequenceView, Text } from "../../design";
import { useI18n } from "../i18n";
import type { ViewNode } from "../protocol";
import { useQuery } from "../state/context";
import { EmbedBody, useTabEnv } from "./embeds";
import { useOpenHere } from "./view-nodes";

type SequenceNode = Extract<ViewNode, { type: "sequence" }>;

/** Sequences inside sequences (a book embedded in a book) go at most this deep; deeper ones list only their titles. */
export const MAX_SEQUENCE_DEPTH = 3;
const Depth = createContext(0);

/**
 * D487 §13 (K-d): a `sequence` view node — each item's resource shown as its embed view (with the item's `args`),
 * under the item's title, loaded only when near the view; the position event tells the page where the reader stopped.
 */
export function SequenceNodeView({ node, onEvent }: { node: SequenceNode; onEvent?: (event: string, row: string) => void }) {
  const { t } = useI18n();
  const depth = useContext(Depth);
  const openHere = useOpenHere();
  const byKey = new Map(node.items.map((x) => [x.key, x]));
  const renderContent = useCallback(
    (key: string) => {
      const it = byKey.get(key);
      return it?.resource ? <ItemContent id={it.resource} args={it.args} level={it.level} /> : null;
    },
    // The items decide; the map is rebuilt with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node.items],
  );
  const renderActions = useCallback(
    (key: string) => {
      const id = byKey.get(key)?.resource;
      return id ? (
        <Button size="sm" variant="ghost" icon="arrow-up-right" onClick={() => openHere(`resource:${id}`)}>
          {t("sequence.open")}
        </Button>
      ) : null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node.items, openHere, t],
  );
  const event = node.positionEvent;
  const onPosition = useCallback((key: string) => (event && onEvent ? onEvent(event, key) : undefined), [event, onEvent]);
  if (depth >= MAX_SEQUENCE_DEPTH) {
    return (
      <>
        {node.items.map((x) => (
          <Text key={x.key} tone="muted">
            {x.title}
          </Text>
        ))}
      </>
    );
  }
  return (
    <Depth.Provider value={depth + 1}>
      <SequenceView
        label={node.id}
        items={node.items.map((x) => ({ key: x.key, title: x.title, level: x.level, book: x.book ?? undefined }))}
        toc={(node.toc ?? false) && depth === 0}
        mode={depth === 0 ? (node.mode ?? "scroll") : "scroll"}
        startKey={node.start ?? null}
        renderContent={renderContent}
        renderActions={renderActions}
        onPosition={event && onEvent && depth === 0 ? onPosition : undefined}
        labels={{
          toc: t("sequence.toc"),
          previous: t("sequence.previous"),
          next: t("sequence.next"),
          page: (n, total) => t("sequence.page", { n: String(n), total: String(total) }),
        }}
      />
    </Depth.Provider>
  );
}

/** One item's content: the resource's embed view, without the frame an embed has elsewhere. */
function ItemContent({ id, args, level }: { id: string; args?: unknown; level: number }) {
  const { t } = useI18n();
  const envId = useTabEnv();
  const q = useQuery((c) => (c.refs.embed ? c.refs.embed({ id, envId, args }) : Promise.resolve(null)), [id, envId, JSON.stringify(args ?? null)], [`resource:${id}`]);
  const e = q.data;
  if (!e) return <Text tone="muted">{q.error ? t("embed.failed") : t("common.loading")}</Text>;
  return <EmbedBody e={e} args={args} headingShift={level} place={{ refs: e.refs, envId, depth: 1, chain: [e.id] }} />;
}
