import { createContext, useContext, type ReactNode } from "react";
import type { ProtocolClient } from "./client";

const ClientContext = createContext<ProtocolClient | null>(null);

/** Hands the protocol client to the UI. The UI never imports an implementation (mock or real). */
export function ProtocolProvider({ client, children }: { client: ProtocolClient; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useClient(): ProtocolClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useClient must be used inside ProtocolProvider");
  return client;
}
