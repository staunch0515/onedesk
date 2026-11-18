import type { EventMessage, Response } from "../generated";
import { KernelError, toKernelError } from "../errors";
import type { Transport } from "./transport";

/** Browser against `onedesk-devhost` (D266): `?kernel=ws://127.0.0.1:<port>&token=<token>`. */
export function createWsTransport(base: string, token: string, client: string, workspace?: string | null): Promise<Transport> {
  // `workspace`: this tab was opened for a workspace ("new window", D403); the main process binds the connection to it.
  const url = `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}&client=${encodeURIComponent(client)}${workspace ? `&workspace=${encodeURIComponent(workspace)}` : ""}`;
  let socket: WebSocket;
  let nextId = 1;
  let closed = false;
  let retry = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: KernelError) => void }>();
  const handlers = new Set<(event: EventMessage) => void>();
  const emit = (topic: string, payload: unknown) => handlers.forEach((h) => h({ topic, payload } as EventMessage));

  const failPending = () => {
    for (const p of pending.values()) p.reject(new KernelError("workerGone", {}, "connection to the main process closed"));
    pending.clear();
  };

  const open = (first: boolean) =>
    new Promise<void>((resolve, reject) => {
      socket = new WebSocket(url);
      socket.onopen = () => {
        retry = 0;
        if (!first) emit("connection", "restored");
        resolve();
      };
      socket.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as Partial<Response> & Partial<EventMessage>;
        if (typeof msg.id === "number") {
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          if (msg.error) p.reject(toKernelError(msg.error));
          else p.resolve(msg.result ?? null);
        } else if (msg.topic) {
          if (msg.client && msg.client !== client) return;
          handlers.forEach((h) => h(msg as EventMessage));
        }
      };
      socket.onerror = () => {
        if (first) reject(new KernelError("workerGone", {}, "cannot reach the dev host"));
      };
      socket.onclose = () => {
        failPending();
        if (closed || first) return;
        emit("connection", "lost");
        retry += 1;
        setTimeout(() => void open(false).catch(() => undefined), Math.min(500 * retry, 5000));
      };
    });

  return open(true).then(() => ({
    request(method, params) {
      return new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) return reject(new KernelError("workerGone", {}, "not connected"));
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params: params ?? null }));
      });
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      closed = true;
      socket.close();
    },
  }));
}
