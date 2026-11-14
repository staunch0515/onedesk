/**
 * Component gallery: every design-system component in its states, with theme and density switches.
 * Phase 1 only (rendered by src/main.tsx); used for visual review and docs/screenshots/gallery-*.png.
 * Demo copy lives here because the gallery is not product UI.
 */
import { useEffect, useState } from "react";
import {
  AppShell,
  Badge,
  Banner,
  Button,
  Checkbox,
  CommandPalette,
  Dialog,
  DialogClose,
  DragHandle,
  Drawer,
  DropdownMenu,
  EmptyState,
  ErrorState,
  FormField,
  IconButton,
  Input,
  Kbd,
  LoadingState,
  Markdown,
  NavGroup,
  NavItem,
  Page,
  PageBody,
  PageHeader,
  Progress,
  SearchTrigger,
  Section,
  Select,
  Sidebar,
  Spinner,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  Tooltip,
  TopBar,
  useTheme,
  useToast,
  type Density,
  type TableColumn,
  type ThemePreference,
} from "../index";
import "./gallery.css";

interface Row {
  id: string;
  name: string;
  kind: string;
  tags: string;
  size: number;
  updated: string;
  disabled?: boolean;
}

const ROWS: Row[] = [
  { id: "r1", name: "内部知识库", kind: "网址", tags: "文档, 团队", size: 12, updated: "2026-11-14 09:12" },
  { id: "r2", name: "周报提示词", kind: "提示词", tags: "写作", size: 1840, updated: "2026-11-13 18:40" },
  { id: "r3", name: "获取用户列表", kind: "HTTP 请求", tags: "接口", size: 326, updated: "2026-11-12 11:05", disabled: true },
  { id: "r4", name: "发布检查清单", kind: "笔记", tags: "流程, 发布", size: 20410, updated: "2026-11-02 08:30" },
];

const MARKDOWN = `## 发布检查清单

发布前逐项确认，**不要跳过**。参考 [发布流程](https://example.com/release)。

- [x] 运行 \`pnpm check\`
- [x] 更新截图
- [ ] 通知相关人员

| 步骤 | 负责人 | 用时 |
| --- | --- | ---: |
| 构建 | 平台组 | 12 分钟 |
| 验收 | 产品组 | 30 分钟 |

> 失败时先回滚，再排查原因。

\`\`\`bash
pnpm tauri build
\`\`\`

<script>alert("原始 HTML 不会被渲染")</script>
`;

const SWATCHES = [
  "bg-app",
  "bg-surface",
  "bg-subtle",
  "bg-hover",
  "bg-active",
  "bg-selected",
  "fg-default",
  "fg-muted",
  "fg-subtle",
  "fg-disabled",
  "border-default",
  "border-strong",
  "accent",
  "accent-subtle",
  "success",
  "warning",
  "danger",
  "info",
] as const;

function ThemeControls() {
  const { theme, density, setTheme, setDensity } = useTheme();
  return (
    <Stack direction="row" gap="sm">
      <Select
        size="sm"
        aria-label="主题"
        value={theme}
        onValueChange={(v) => setTheme(v as ThemePreference)}
        options={[
          { value: "system", label: "跟随系统", icon: "monitor" },
          { value: "light", label: "浅色", icon: "sun" },
          { value: "dark", label: "深色", icon: "moon" },
        ]}
        className="gallery-select"
      />
      <Select
        size="sm"
        aria-label="密度"
        value={density}
        onValueChange={(v) => setDensity(v as Density)}
        options={[
          { value: "comfortable", label: "舒适" },
          { value: "compact", label: "紧凑" },
        ]}
        className="gallery-select"
      />
    </Stack>
  );
}

function ButtonsSection() {
  const [loading, setLoading] = useState(false);
  return (
    <Section title="按钮" description="主要、次要、幽灵、危险；两种尺寸；加载中与禁用。">
      <Stack gap="md">
        <Stack direction="row" gap="sm" wrap>
          <Button variant="primary" icon="plus">
            新建资源
          </Button>
          <Button variant="secondary" icon="pencil">
            编辑
          </Button>
          <Button variant="ghost">取消</Button>
          <Button variant="danger" icon="trash-2">
            删除
          </Button>
          <Button
            variant="primary"
            loading={loading}
            onClick={() => {
              setLoading(true);
              window.setTimeout(() => setLoading(false), 1500);
            }}
          >
            {loading ? "发送中" : "发送请求"}
          </Button>
          <Button variant="secondary" loading>
            保存中
          </Button>
          <Button variant="primary" disabled>
            已禁用
          </Button>
          <Button variant="secondary" trailingIcon="chevron-down">
            更多
          </Button>
        </Stack>
        <Stack direction="row" gap="sm" wrap>
          <Button variant="primary" size="sm" icon="play">
            运行
          </Button>
          <Button variant="secondary" size="sm" icon="copy">
            复制
          </Button>
          <Button variant="ghost" size="sm">
            跳过
          </Button>
          <Button variant="danger" size="sm">
            停用
          </Button>
          <Button variant="secondary" size="sm" disabled>
            已禁用
          </Button>
        </Stack>
        <Stack direction="row" gap="xs" align="center">
          <IconButton icon="search" label="搜索" shortcut={["⌘", "K"]} />
          <IconButton icon="refresh-cw" label="刷新" />
          <IconButton icon="settings" label="设置" variant="secondary" />
          <IconButton icon="ellipsis" label="更多操作" size="sm" />
          <IconButton icon="trash-2" label="删除" size="sm" disabled />
          <IconButton icon="loader" label="加载中" loading />
        </Stack>
      </Stack>
    </Section>
  );
}

function FormSection() {
  const [method, setMethod] = useState("GET");
  const [enabled, setEnabled] = useState(true);
  return (
    <Section title="表单" description="标签、说明、错误；输入框、多行文本、下拉、开关、复选框。">
      <div className="gallery-grid-2">
        <FormField label="名称" required requiredMark="*" description="显示在左侧菜单中。">
          <Input placeholder="例如：内部知识库" defaultValue="内部知识库" />
        </FormField>
        <FormField label="网址" error="网址必须以 http:// 或 https:// 开头。">
          <Input icon="link" mono defaultValue="ftp://intranet.local" />
        </FormField>
        <FormField label="请求方法">
          <Select
            value={method}
            onValueChange={setMethod}
            options={[
              { value: "GET", label: "GET" },
              { value: "POST", label: "POST" },
              { value: "PUT", label: "PUT" },
              { value: "DELETE", label: "DELETE", disabled: true },
            ]}
          />
        </FormField>
        <FormField label="分组" description="未选择时放在“未分组”。">
          <Select
            placeholder="选择分组"
            options={[
              { label: "工作", options: [{ value: "docs", label: "文档" }, { value: "api", label: "接口" }] },
              { label: "个人", options: [{ value: "notes", label: "笔记" }] },
            ]}
          />
        </FormField>
        <FormField label="超时" labelAside="秒">
          <Input defaultValue="30" className="od-tabular" trailing={<Kbd keys={["↵"]} />} />
        </FormField>
        <FormField label="只读字段" description="由系统生成，不可修改。">
          <Input readOnly mono defaultValue="res_01HF8Z3K9Q" />
        </FormField>
        <FormField label="已禁用">
          <Input disabled placeholder="不可编辑" />
        </FormField>
        <FormField label="小尺寸">
          <Input size="sm" icon="search" placeholder="筛选" />
        </FormField>
      </div>
      <div className="gallery-spacer" />
      <div className="gallery-grid-2">
        <FormField label="正文" description="支持 {{name}} 占位符。">
          <Textarea mono defaultValue={"请用简洁的语言总结 {{topic}}，\n列出三条要点。"} />
        </FormField>
        <FormField label="备注" error="备注不能超过 200 字。">
          <Textarea placeholder="写点什么" />
        </FormField>
      </div>
      <div className="gallery-spacer" />
      <Stack direction="row" gap="lg" wrap align="start">
        <Switch label="启用插件" description="停用后数据保留。" checked={enabled} onCheckedChange={setEnabled} />
        <Switch label="已禁用" disabled />
        <Switch aria-label="紧凑开关" defaultChecked />
        <Checkbox label="对 AI 可见" defaultChecked />
        <Checkbox label="部分选中" indeterminate />
        <Checkbox label="不可修改" description="内置插件不可卸载。" disabled defaultChecked />
        <Checkbox label="未选中" />
      </Stack>
    </Section>
  );
}

function DisplaySection() {
  return (
    <Section title="徽标、快捷键、进度" description="语义色只用于小面积提示。">
      <Stack gap="md">
        <Stack direction="row" gap="sm" wrap>
          <Badge>默认</Badge>
          <Badge tone="accent">内置</Badge>
          <Badge tone="success" dot>
            已启用
          </Badge>
          <Badge tone="warning" icon="triangle-alert">
            字段不合法
          </Badge>
          <Badge tone="danger" dot>
            加载失败
          </Badge>
          <Badge tone="info" icon="info">
            外部插件
          </Badge>
          <Badge>
            <span className="od-tabular">v1.2.0</span>
          </Badge>
        </Stack>
        <Stack direction="row" gap="lg" align="center" wrap>
          <Stack direction="row" gap="sm">
            <Text tone="muted">命令面板</Text>
            <Kbd keys={["⌘", "K"]} />
          </Stack>
          <Stack direction="row" gap="sm">
            <Text tone="muted">新建</Text>
            <Kbd keys={["⌘", "N"]} />
          </Stack>
          <Stack direction="row" gap="sm">
            <Spinner size="sm" />
            <Spinner />
            <Spinner size="lg" label="加载中" />
          </Stack>
          <Progress value={64} label="导出进度" />
          <Progress label="执行中" />
        </Stack>
      </Stack>
    </Section>
  );
}

function BannersSection() {
  const [visible, setVisible] = useState(true);
  return (
    <Section title="提示条" variant="plain">
      <Stack gap="sm">
        <Banner tone="info" title="插件已停用">
          “HTTP 请求”插件已停用，保留了 3 个资源。启用后恢复显示。
        </Banner>
        <Banner tone="success">导出完成：已写入 128 个资源。</Banner>
        <Banner
          tone="warning"
          title="2 个资源不符合字段定义"
          actions={
            <Button size="sm" variant="secondary">
              查看
            </Button>
          }
        >
          插件更新后字段发生变化，请检查并修正。
        </Banner>
        {visible && (
          <Banner tone="danger" title="迁移失败" onDismiss={() => setVisible(false)} dismissLabel="关闭">
            数据库升级到版本 3 时出错，已回滚。请导出日志后重试。
          </Banner>
        )}
      </Stack>
    </Section>
  );
}

function TableSection({ selected, onSelect }: { selected: string; onSelect: (id: string) => void }) {
  const columns: Array<TableColumn<Row>> = [
    {
      key: "name",
      header: "名称",
      render: (r) => (
        <Stack direction="row" gap="sm">
          <span>{r.name}</span>
          {r.disabled && <Badge>插件已停用</Badge>}
        </Stack>
      ),
    },
    { key: "kind", header: "类型", shrink: true },
    { key: "tags", header: "标签", muted: true },
    { key: "size", header: "大小（字节）", numeric: true, shrink: true, render: (r) => r.size.toLocaleString("zh-CN") },
    { key: "updated", header: "更新时间", shrink: true, muted: true, render: (r) => <span className="od-tabular">{r.updated}</span> },
    {
      key: "actions",
      header: <span className="od-visually-hidden">操作</span>,
      shrink: true,
      render: (r) => (
        <DropdownMenu
          align="end"
          trigger={<IconButton icon="ellipsis" label={`${r.name} 的操作`} size="sm" onClick={(e) => e.stopPropagation()} />}
          items={[
            { key: "open", label: "打开", icon: "arrow-up-right", onSelect: () => onSelect(r.id) },
            { key: "dup", label: "复制一份", icon: "copy", onSelect: () => undefined },
            { key: "sep", type: "separator" },
            { key: "del", label: "删除", icon: "trash-2", danger: true, onSelect: () => undefined },
          ]}
        />
      ),
    },
  ];
  return (
    <Section title="表格" description="表头、数字列右对齐、行悬停、选中、停用行灰色、空态。" variant="plain">
      <Stack gap="md">
        <Table
          label="资源"
          columns={columns}
          rows={ROWS}
          getRowKey={(r) => r.id}
          selectedKeys={[selected]}
          isRowMuted={(r) => Boolean(r.disabled)}
          onRowActivate={(r) => onSelect(r.id)}
        />
        <Table
          label="空表格"
          columns={columns.slice(0, 5)}
          rows={[]}
          getRowKey={(r) => r.id}
          empty={<EmptyState layout="inline" message="还没有资源。点击“新建资源”添加第一个。" />}
        />
      </Stack>
    </Section>
  );
}

function StatesSection() {
  const [retrying, setRetrying] = useState(false);
  return (
    <Section title="页面状态" description="加载中、空状态（一句话 + 可选动作，无插图）、错误（原因 + 处理方式 + 重试）。" variant="plain">
      <div className="gallery-grid-3">
        <div className="gallery-frame">
          <LoadingState label="正在加载资源…" layout="inline" />
        </div>
        <div className="gallery-frame">
          <EmptyState
            layout="inline"
            icon="inbox"
            message="这个集合还是空的。把资源拖到这里，或新建一个。"
            action={
              <Button variant="primary" size="sm" icon="plus">
                新建资源
              </Button>
            }
          />
        </div>
        <div className="gallery-frame">
          <ErrorState
            layout="inline"
            title="无法加载插件"
            reason="清单中的 apiVersion 为 “2”，当前只支持 “1”。"
            resolution="更新插件或联系插件作者。"
            onRetry={() => {
              setRetrying(true);
              window.setTimeout(() => setRetrying(false), 1200);
            }}
            retrying={retrying}
            retryLabel="重试"
          />
        </div>
      </div>
    </Section>
  );
}

function OverlaysSection({ onOpenPalette }: { onOpenPalette: () => void }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiVisible, setAiVisible] = useState(true);
  const { toast } = useToast();
  return (
    <Section title="浮层" description="对话框、抽屉、菜单、工具提示、吐司、命令面板。全部可用键盘操作。">
      <Stack direction="row" gap="sm" wrap>
        <Dialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          trigger={<Button icon="square-plus">打开对话框</Button>}
          title="删除资源"
          description="“周报提示词”将被永久删除，此操作无法撤销。"
          closeLabel="关闭"
          size="sm"
          dismissible={!saving}
          footer={
            <>
              <DialogClose>
                <Button variant="secondary" disabled={saving}>
                  取消
                </Button>
              </DialogClose>
              <Button
                variant="danger"
                loading={saving}
                onClick={() => {
                  setSaving(true);
                  window.setTimeout(() => {
                    setSaving(false);
                    setDialogOpen(false);
                    toast({ title: "已删除“周报提示词”", tone: "success" });
                  }, 900);
                }}
              >
                删除
              </Button>
            </>
          }
        />
        <Drawer
          trigger={<Button icon="panel-right">打开抽屉</Button>}
          title="资源详情"
          description="内部知识库 · 网址"
          closeLabel="关闭"
          footer={
            <>
              <DialogClose>
                <Button variant="secondary">取消</Button>
              </DialogClose>
              <Button variant="primary">保存</Button>
            </>
          }
        >
          <Stack gap="md">
            <FormField label="名称">
              <Input defaultValue="内部知识库" />
            </FormField>
            <FormField label="网址">
              <Input mono defaultValue="https://wiki.example.com" />
            </FormField>
            <FormField label="描述">
              <Textarea defaultValue="团队文档入口。" />
            </FormField>
          </Stack>
        </Drawer>
        <DropdownMenu
          trigger={<Button trailingIcon="chevron-down">菜单</Button>}
          items={[
            { key: "l", type: "label", label: "资源" },
            { key: "new", label: "新建", icon: "plus", shortcut: ["⌘", "N"], onSelect: () => undefined },
            { key: "dup", label: "复制一份", icon: "copy", shortcut: ["⌘", "D"], onSelect: () => undefined },
            { key: "ai", type: "checkbox", label: "对 AI 可见", checked: aiVisible, onCheckedChange: setAiVisible },
            { key: "exp", label: "导出（不可用）", icon: "download", disabled: true, onSelect: () => undefined },
            { key: "s", type: "separator" },
            { key: "del", label: "删除", icon: "trash-2", danger: true, onSelect: () => undefined },
          ]}
        />
        <Tooltip content="复制到剪贴板" shortcut={["⌘", "C"]}>
          <Button icon="copy">悬停查看提示</Button>
        </Tooltip>
        <Button icon="bell" onClick={() => toast({ title: "已复制到剪贴板", description: "参数已替换。", tone: "success" })}>
          成功吐司
        </Button>
        <Button
          icon="bell"
          onClick={() =>
            toast({
              title: "请求失败",
              description: "连接 api.example.com 超时（30 秒）。",
              tone: "danger",
              action: { label: "重试", altText: "在资源页重新发送请求", onClick: () => undefined },
            })
          }
        >
          错误吐司
        </Button>
        <Button icon="command" onClick={onOpenPalette}>
          命令面板
        </Button>
      </Stack>
    </Section>
  );
}

function TokensSection() {
  return (
    <Section title="颜色与字号" description="全部来自 tokens.css。">
      <Stack gap="lg">
        <div className="gallery-swatches">
          {SWATCHES.map((name) => (
            <div key={name} className="gallery-swatch">
              <span className={`gallery-swatch__chip gallery-swatch__chip--${name}`} />
              <Text size="xs" tone="muted" mono>
                --{name}
              </Text>
            </div>
          ))}
        </div>
        <Stack gap="xs">
          <Text size="xl" weight="semibold">
            20 页面标题 OneDesk
          </Text>
          <Text size="lg" weight="semibold">
            16 区块标题 OneDesk
          </Text>
          <Text>14 正文：统一的桌面工作入口，资源、插件、视图。</Text>
          <Text size="sm" tone="muted">
            13 次要文字：最后更新于 2026-11-14 09:12
          </Text>
          <Text size="xs" tone="subtle">
            12 辅助文字与表头
          </Text>
          <Text tabular>表格数字 0123456789 · 1,234,567.89</Text>
        </Stack>
      </Stack>
    </Section>
  );
}

export function Gallery() {
  const [selected, setSelected] = useState("r2");
  const [navSelected, setNavSelected] = useState("all");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tab, setTab] = useState("overview");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const nav = (id: string) => ({ selected: navSelected === id, onSelect: () => setNavSelected(id) });

  return (
    <AppShell
      mainLabel="组件展示"
      sidebar={
        <Sidebar
          label="资源目录"
          header={
            <Stack direction="row" gap="sm" justify="between" className="gallery-brand">
              <Text weight="semibold">OneDesk</Text>
              <IconButton icon="plus" label="新建资源" size="sm" shortcut={["⌘", "N"]} />
            </Stack>
          }
          footer={
            <NavGroup>
              <NavItem icon="puzzle" label="插件" meta="4" {...nav("plugins")} />
              <NavItem icon="settings" label="设置" {...nav("settings")} />
            </NavGroup>
          }
        >
          <NavGroup>
            <NavItem icon="layout-grid" label="全部资源" meta="128" {...nav("all")} />
            <NavItem icon="library" label="集合" {...nav("collections")} />
          </NavGroup>
          <NavGroup label="工作" actions={<IconButton icon="plus" label="在“工作”中新建" size="sm" />}>
            <NavItem icon="link" label="内部知识库" dragHandle={<DragHandle label="拖动排序" />} {...nav("r1")} />
            <NavItem icon="message-square-text" label="周报提示词" dragHandle={<DragHandle label="拖动排序" />} {...nav("r2")} />
            <NavItem icon="send" label="获取用户列表" disabled dragHandle={<DragHandle label="拖动排序" />} {...nav("r3")} />
            <NavItem icon="sticky-note" label="发布检查清单" warning="正文不符合字段定义" dragHandle={<DragHandle label="拖动排序" />} {...nav("r4")} />
          </NavGroup>
          <NavGroup label="个人" defaultOpen={false}>
            <NavItem icon="link" label="个人博客" {...nav("p1")} />
          </NavGroup>
        </Sidebar>
      }
      topbar={
        <TopBar
          start={<Text tone="muted">设计系统 / 组件展示</Text>}
          center={<SearchTrigger placeholder="搜索资源、动作、页面" shortcut={["⌘", "K"]} onClick={() => setPaletteOpen(true)} />}
          end={<ThemeControls />}
        />
      }
    >
      <Page>
        <PageHeader
          icon="palette"
          title="组件展示"
          meta={<Badge tone="accent">第一阶段</Badge>}
          description="所有基础组件及其状态。顶部可切换主题和密度。"
          actions={
            <>
              <Button icon="external-link" variant="ghost">
                查看规范
              </Button>
              <Button variant="primary" icon="plus">
                新建资源
              </Button>
            </>
          }
        >
          <Tabs
            label="展示分区"
            value={tab}
            onValueChange={setTab}
            items={[
              { value: "overview", label: "概览", content: null },
              { value: "components", label: "组件", count: 28, content: null },
              { value: "tokens", label: "设计 token", content: null },
              { value: "disabled", label: "不可用", disabled: true, content: null },
            ]}
          />
        </PageHeader>
        <PageBody>
          <Stack gap="lg">
            <ButtonsSection />
            <FormSection />
            <DisplaySection />
            <BannersSection />
            <TableSection selected={selected} onSelect={setSelected} />
            <StatesSection />
            <OverlaysSection onOpenPalette={() => setPaletteOpen(true)} />
            <Section title="Markdown 阅读态" description="GFM 表格、任务列表、代码；原始 HTML 不渲染。">
              <Markdown onLinkClick={() => undefined}>{MARKDOWN}</Markdown>
            </Section>
            <TokensSection />
          </Stack>
        </PageBody>
      </Page>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        label="命令面板"
        placeholder="搜索资源、动作、页面"
        emptyText="没有匹配的结果。换个关键词试试。"
        footer={
          <>
            <Stack direction="row" gap="xs">
              <Kbd keys={["↑", "↓"]} /> <span>选择</span>
            </Stack>
            <Stack direction="row" gap="xs">
              <Kbd keys={["↵"]} /> <span>打开</span>
            </Stack>
            <Stack direction="row" gap="xs">
              <Kbd keys={["esc"]} /> <span>关闭</span>
            </Stack>
          </>
        }
        groups={[
          {
            id: "resources",
            heading: "资源",
            items: ROWS.map((r) => ({
              id: r.id,
              label: r.name,
              description: r.kind,
              icon: "file-text",
              keywords: r.tags.split(", "),
              onSelect: () => setSelected(r.id),
            })),
          },
          {
            id: "actions",
            heading: "动作",
            items: [
              { id: "new", label: "新建资源", icon: "plus", shortcut: ["⌘", "N"], onSelect: () => undefined },
              { id: "copy", label: "复制提示词", description: "周报提示词", icon: "copy", onSelect: () => undefined },
            ],
          },
          {
            id: "pages",
            heading: "页面",
            items: [
              { id: "plugins", label: "插件", icon: "puzzle", onSelect: () => setNavSelected("plugins") },
              { id: "settings", label: "设置", icon: "settings", shortcut: ["⌘", ","], onSelect: () => setNavSelected("settings") },
            ],
          },
        ]}
      />
    </AppShell>
  );
}
