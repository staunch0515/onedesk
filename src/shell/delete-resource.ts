import { useCallback } from "react";
import { useToast } from "../design";
import type { Resource } from "../plugin-api";
import { errorInfo } from "./format";
import { t } from "./i18n";
import { useShell } from "./shell-context";

/**
 * Delete flow shared by the resource page and the sidebar: confirm → delete → toast (success or reason);
 * leaves the resource's page when it is the current one. Resolves true when deleted.
 */
export function useDeleteResource(): (resource: Resource) => Promise<boolean> {
  const { kernel, route, navigate, confirm, setLeaveGuard } = useShell();
  const { toast } = useToast();
  return useCallback(
    async (resource: Resource) => {
      const ok = await confirm({
        title: t("resource.deleteTitle", { name: resource.name }),
        description: t("resource.deleteBody"),
        confirmLabel: t("common.delete"),
        danger: true,
      });
      if (!ok) return false;
      try {
        await kernel.resources.delete(resource.id);
      } catch (e) {
        const info = errorInfo(e);
        toast({ title: t("resource.deleteFailed", { name: resource.name }), description: info.hint ? `${info.message}（${info.hint}）` : info.message, tone: "danger" });
        return false;
      }
      toast({ title: t("resource.deleted", { name: resource.name }), tone: "success" });
      if (route.page === "resource" && route.id === resource.id) {
        setLeaveGuard(null);
        await navigate({ page: "all" });
      }
      return true;
    },
    [kernel, route, navigate, confirm, setLeaveGuard, toast],
  );
}
