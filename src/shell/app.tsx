/** The application shell: layout, routing, dialogs, global shortcuts, notifications. */
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AppShell,
  Button,
  Dialog,
  DialogClose,
  ErrorState,
  ThemeProvider,
  ToastProvider,
  useToast,
  type Density,
  type ThemePreference,
} from "../design";
import type { Kernel } from "../kernel/contracts";
import type { ActionResult, Resource } from "../plugin-api";
import { ActionInputDialog, type ActionInputRequest } from "./action-ui";
import { errorInfo } from "./format";
import { t } from "./i18n";
import { NewResourceDialog } from "./new-resource-dialog";
import { AllResourcesPage } from "./pages/all-resources-page";
import { CollectionsPage } from "./pages/collections-page";
import { PluginsPage } from "./pages/plugins-page";
import { ResourcePage } from "./pages/resource-page";
import { SearchPage } from "./pages/search-page";
import { SettingsPage } from "./pages/settings-page";
import { ShellPalette } from "./palette";
import type { ShellServices } from "./services";
import { ShellContext, sameRoute, type ConfirmOptions, type LeaveGuard, type Route, type ShellApi } from "./shell-context";
import { SidebarMenu } from "./sidebar-menu";
import { ShellTopBar } from "./top-bar";

export const THEME_PREF = "shell.theme";
export const DENSITY_PREF = "shell.density";

export function readTheme(v: unknown): ThemePreference {
  return v === "light" || v === "dark" ? v : "system";
}
export function readDensity(v: unknown): Density {
  return v === "compact" ? "compact" : "comfortable";
}

class PageBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: unknown; key: string }> {
  state = { error: null as unknown, key: this.props.resetKey };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: unknown; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  render() {
    if (this.state.error) {
      const info = errorInfo(this.state.error);
      return (
        <ErrorState
          title={t("state.pageError")}
          reason={info.message}
          resolution={t("state.pageErrorResolution")}
          onRetry={() => this.setState({ error: null })}
          retryLabel={t("common.retry")}
        />
      );
    }
    return this.props.children;
  }
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

function ShellRoot({ kernel, services, initialRoute }: { kernel: Kernel; services: ShellServices; initialRoute: Route }) {
  const { toast } = useToast();
  const [route, setRoute] = useState<Route>(initialRoute);
  const routeRef = useRef(route);
  routeRef.current = route;
  const guardRef = useRef<LeaveGuard | null>(null);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newPreset, setNewPreset] = useState<{ kind?: string; group?: string } | undefined>(undefined);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inputRequest, setInputRequest] = useState<ActionInputRequest | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...options, resolve });
      }),
    [],
  );
  const closeConfirm = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const navigate = useCallback(
    async (next: Route) => {
      if (sameRoute(next, routeRef.current)) return true;
      const dirty = guardRef.current?.();
      if (dirty) {
        const ok = await confirm({
          title: t("edit.leaveTitle"),
          description: t("edit.leaveBody", { name: dirty }),
          confirmLabel: t("common.discard"),
          cancelLabel: t("common.keepEditing"),
          danger: true,
        });
        if (!ok) return false;
      }
      guardRef.current = null;
      setRoute(next);
      return true;
    },
    [confirm],
  );

  const openExternal = useCallback(
    (url: string) => {
      services.openExternal(url).catch((e: unknown) => {
        const info = errorInfo(e);
        toast({ title: info.message, description: info.hint, tone: "danger" });
      });
    },
    [services, toast],
  );

  const execute = useCallback(
    (key: string, resource: Resource | undefined, input?: Record<string, unknown>) => {
      const args: { resourceId?: string; input?: Record<string, unknown>; source: "manual" } = { source: "manual" };
      if (resource) args.resourceId = resource.id;
      if (input) args.input = input;
      void kernel.actions.run(key, args).then((result: ActionResult) => {
        // Resource actions show their result on the resource page; global ones (plugin menu items) as a toast.
        if (resource) return;
        const label = kernel.registry.action(key)?.label ?? key;
        if (result.status === "success") toast({ title: t("action.success", { label }), description: result.output?.message, tone: "success" });
        else if (result.status === "error") toast({ title: t("action.error", { label }), description: result.error?.message, tone: "danger" });
        else toast({ title: t("action.cancelled", { label }), tone: "warning" });
      });
    },
    [kernel, toast],
  );

  const runAction = useCallback(
    (key: string, resource?: Resource) => {
      const fields = kernel.actions.inputFields(key, resource);
      if (fields.length > 0) {
        const req: ActionInputRequest = { key, label: kernel.registry.action(key)?.label ?? key, fields };
        if (resource) req.resource = resource;
        setInputRequest(req);
      } else execute(key, resource);
    },
    [kernel, execute],
  );

  const openNewResource = useCallback((preset?: { kind?: string; group?: string }) => {
    setNewPreset(preset);
    setNewOpen(true);
  }, []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const setLeaveGuard = useCallback((guard: LeaveGuard | null) => {
    guardRef.current = guard;
  }, []);

  // Plugin notifications → toasts.
  useEffect(
    () =>
      kernel.events.on("notify", (e) => {
        const tone = e.message.tone ?? "info";
        toast({ title: e.message.title, description: e.message.description, tone });
      }),
    [kernel, toast],
  );

  // Global shortcuts: ⌘K palette, ⌘N new resource. (⌘↵ and ⌘S live on the resource page.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (key === "n") {
        e.preventDefault();
        if (!document.querySelector("[role=dialog]")) openNewResource();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openNewResource]);

  // Warn before closing the window with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (guardRef.current?.()) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const api = useMemo<ShellApi>(
    () => ({ kernel, services, route, navigate, setLeaveGuard, confirm, openNewResource, openPalette, runAction, openExternal }),
    [kernel, services, route, navigate, setLeaveGuard, confirm, openNewResource, openPalette, runAction, openExternal],
  );

  let page: ReactNode;
  switch (route.page) {
    case "resource":
      page = <ResourcePage key={route.id} id={route.id} tab={route.tab} />;
      break;
    case "collections":
      page = <CollectionsPage id={route.id} />;
      break;
    case "plugins":
      page = <PluginsPage />;
      break;
    case "settings":
      page = <SettingsPage />;
      break;
    case "search":
      page = <SearchPage query={route.query} />;
      break;
    default:
      page = <AllResourcesPage />;
  }

  return (
    <ShellContext.Provider value={api}>
      <AppShell sidebar={<SidebarMenu />} topbar={<ShellTopBar />} mainLabel={t("app.mainLabel")}>
        <PageBoundary resetKey={JSON.stringify(route)}>{page}</PageBoundary>
      </AppShell>
      <NewResourceDialog open={newOpen} onOpenChange={setNewOpen} preset={newPreset} />
      <ShellPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ActionInputDialog request={inputRequest} onClose={() => setInputRequest(null)} onRun={(req, input) => execute(req.key, req.resource, input)} />
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => !open && closeConfirm(false)}
        title={pending?.title ?? ""}
        description={pending?.description}
        size="sm"
        footer={
          <>
            <DialogClose>
              <Button>{pending?.cancelLabel ?? t("common.cancel")}</Button>
            </DialogClose>
            <Button variant={pending?.danger ? "danger" : "primary"} onClick={() => closeConfirm(true)}>
              {pending?.confirmLabel ?? t("common.confirm")}
            </Button>
          </>
        }
      />
    </ShellContext.Provider>
  );
}

export interface AppProps {
  kernel: Kernel;
  services: ShellServices;
  initialTheme: ThemePreference;
  initialDensity: Density;
  initialRoute?: Route;
}

export function App({ kernel, services, initialTheme, initialDensity, initialRoute = { page: "all" } }: AppProps) {
  const [theme, setTheme] = useState(initialTheme);
  const [density, setDensity] = useState(initialDensity);
  return (
    <ThemeProvider
      theme={theme}
      density={density}
      onThemeChange={(v) => {
        setTheme(v);
        void kernel.prefs.set(THEME_PREF, v);
      }}
      onDensityChange={(v) => {
        setDensity(v);
        void kernel.prefs.set(DENSITY_PREF, v);
      }}
    >
      <ToastProvider closeLabel={t("common.close")} viewportLabel={t("common.toastRegion")}>
        <ShellRoot kernel={kernel} services={services} initialRoute={initialRoute} />
      </ToastProvider>
    </ThemeProvider>
  );
}
