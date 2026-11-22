/**
 * Round 19 (MCP: external AI clients use OneDesk read-only; docs/redesign/ai-interface.md, D415/D447/D448) against the real kernel.
 * PHASE 1 (this file): scaffold + `test.fixme` placeholders; each one says what it must assert. Phase 2 (after the merge, when the
 * coordinator says so): fill them, using the names in docs/handoff/round19-protocol.md.
 *
 * How it talks: `e2e/_mcp/mcp-client.ts` (a fake MCP client, JSON-RPC lines over stdio).
 *   - "headless" connection: the client spawns `onedesk-mcp --workspace <name>` while NO app is running → it starts its own
 *     windowless worker, answers, and exits when stdin closes.
 *   - "app" connection: devhost (the real kernel) is running and `onedesk-mcp` connects to it as a second connection with operator `ai`.
 * Nothing real is contacted (no network, no AI provider; MCP itself never calls one); secrets only in the in-memory store.
 *
 * Tool names below are the generic ones of ai-interface.md §4 (`search`, `describe`, `run`, `get_run`); plugin tools carry the plugin's
 * prefix. The names/params of everything else (policy command, audit filter, error codes) come from round19-protocol.md — TODO(phase 2).
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { connectMcp, type SpawnSpec, type StdioMcpClient } from "./_mcp/mcp-client";
import { DEVHOST, ROOT, rpc, startHost, stopHost, type Host } from "./kernel-host";

test.use({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let host: Host;
let base: string;
let dataDir: string;

/** TODO(phase 2): the built binary (r19-mcp decides where; default next to the devhost). */
const MCP_BIN = process.env.ONEDESK_MCP_BIN ?? path.join(ROOT, "target/debug/onedesk-mcp");

test.beforeAll(async () => {
  if (process.env.ONEDESK_E2E_REQUIRE_DEVHOST === "1") expect(existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`).toBe(true);
  else test.skip(!existsSync(DEVHOST), `onedesk-devhost not built at ${DEVHOST}`);
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "od-round19-")));
  dataDir = path.join(base, "data");
  host = await startHost(dataDir, { ONEDESK_TEST_HOOKS: "1" }, path.join(ROOT, "plugins"));
});
test.afterAll(async () => {
  if (host) await stopHost(host);
  if (base) rmSync(base, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ helpers */

const call = <T = unknown>(page: Page, method: string, params: unknown = null) => rpc<T>(page, host, method, params);
/** spawn spec for onedesk-mcp against this test's data dir; `ws` = workspace name (default workspace when omitted) */
const mcpSpec = (extraArgs: string[] = [], env: Record<string, string> = {}): SpawnSpec => ({
  command: MCP_BIN,
  args: ["--data-dir", dataDir, ...extraArgs], // TODO(phase 2): real flag names from round19-mcp-done.md
  env: { ONEDESK_DATA_DIR: dataDir, ...env },
});
const open = (spec: SpawnSpec = mcpSpec()): Promise<StdioMcpClient> => connectMcp(spec);
void [call, open, mcpSpec]; // used once the placeholders are filled

/* ------------------------------------------------- 0. setup: nothing is open by default */

test.describe("default is all off", () => {
  test.fixme("总开关默认关：tools/list 仍列出通用工具，但每个 tools/call 返回 isError，错误码为“策略关闭”（协议里的 code）；审计里记一条失败调用", async () => {
    /* assert: fresh workspace → mcp policy master switch off; `search` etc. all isError with the disabled code (params has no data);
       the audit row exists with operator ai, ok=false */
  });
  test.fixme("资源默认对 AI 不可见：新建资源 ai_visible=0，开了总开关后 search 也找不到、describe 返回“找不到”", async () => {});
  test.fixme("动作默认不可用：资源可见但清单没声明 ai 的动作，run 被拒（错误码“动作不对 AI 开放”）", async () => {});
});

/* ------------------------------------------------- 1. tools (each one) */

test.describe("tools", () => {
  test.fixme("initialize + tools/list：serverInfo 名称、capabilities.tools，列出 search/describe/run/get_run + 各插件 aiTools（名字带插件前缀、inputSchema 是 JSON Schema）；没有任何写入类工具", async () => {});
  test.fixme("search：只返回 ai_visible 的资源；任一词命中、可按类型过滤；结果不含 body 里的密钥引用原文值", async () => {});
  test.fixme("describe：返回名称、类型、说明与参数（名字、类型、必填、说明、可选值）；不可见的资源与不存在的同一个错误（不泄露存在性）", async () => {});
  test.fixme("run：用“AI 用的环境”运行声明为 AI 可用的只读动作，给参数，拿到表格结果（列与行）；参数缺必填/类型错 → 错误码，不运行", async () => {});
  test.fixme("run：AI 不能选别的环境（传 environment/env 参数被忽略或被拒，二者之一以协议为准），实际用的是工作区里设的环境（用插件回显连接名断言）", async () => {});
  test.fixme("get_run：读 run 的结果；长结果分页（cursor/offset 以协议为准），拼起来等于完整结果；别人（别的操作者）的 run id 读不到", async () => {});
  test.fixme("插件 aiTools：工具名 = 插件前缀 + 名字；参数不符合 JSON Schema → 内核在交给插件前拒绝（插件没被调用，用审计/计数断言）；符合则返回插件结果", async () => {});
  test.fixme("自由查询工具默认关：未开“允许自由查询”时 tools/call 被拒；开了之后只读执行，写语句（INSERT/DELETE/多条）被拒绝，不改数据（回读断言）", async () => {});
});

/* ------------------------------------------------- 2. refusals (kernel, not plugin) */

test.describe("refusals: the ai operator can never ...", () => {
  // Each uses the kernel's own protocol connection with operator ai (the same path onedesk-mcp uses), so a refusal here is the
  // kernel's, not a missing tool. Assert: error code (协议) + the data is unchanged afterwards + an audit row with ok=false.
  test.fixme("写入：resource.create / resource.update / page.save 被拒，回读资源未变", async () => {});
  test.fixme("删除：resource.delete / 移到回收站 / 清空回收站被拒，资源仍在", async () => {});
  test.fixme("安装：插件安装、卸载、启停被拒，插件列表未变", async () => {});
  test.fixme("改设置：settings 写入、mcp policy 写入（AI 不能自己打开总开关或提高上限）、ai_visible 写入（AI 不能把资源标成对自己可见）被拒，值未变", async () => {});
  test.fixme("读密钥值：secrets 读取被拒；run 的结果与 get_run 与审计的全文里都不含测试密钥字符串（grep 整个数据目录也没有明文）", async () => {});
  test.fixme("经 tools/call 绕路也不行：run 一个声明了写入的动作（或没声明 ai.readOnly）被拒，数据未变", async () => {});
});

/* ------------------------------------------------- 3. limits */

test.describe("limits", () => {
  test.fixme("每分钟上限：上限设 3，连调 4 次，第 4 次 isError 且错误码为“限流”（params 带 retry 秒数）；等窗口过后恢复；被限流的调用也进审计", async () => {});
  test.fixme("行数上限：上限设 5，查询返回 20 行 → 结果 5 行 + 截断标志（truncated=true，总行数/返回行数以协议为准）；get_run 同样受上限", async () => {});
  test.fixme("上限不对 AI 可调：mcp policy 值在 AI 调用间保持，非法值（0、负数、非数）被拒", async () => {});
});

/* ------------------------------------------------- 4. audit */

test.describe("audit", () => {
  test.fixme("每次调用一条审计：工具名、参数摘要、结果行数、耗时、成败；操作者为 ai", async () => {});
  test.fixme("审计可按操作者 ai 过滤（协议里的过滤参数）：只剩 ai 的行，窗口（user）操作不在其中，反之亦然", async () => {});
  test.fixme("审计里没有参数全文里的密钥、结果内容；参数摘要有长度上限", async () => {});
});

/* ------------------------------------------------- 5. ai_visible */

test.describe("ai_visible", () => {
  test.fixme("ai_visible=0：search 搜不到、describe/run/get_run 读不到、aiTools 列表里也不出现该资源的数据；改成 1 立即可见；再改回 0 立即不可见", async () => {});
  test.fixme("分组“含下级”：在分组上开 → 其下所有资源（含之后新建的）可见；关 → 全部不可见；单条的开关优先级以协议为准", async () => {});
  test.fixme("外壳：信息面板“对 AI 可见”开关切换后，kernel 里的字段随之变化（界面操作 → rpc 回读）；截图存 docs/screenshots/round19-*.png", async () => {});
});

/* ------------------------------------------------- 6. the two connection modes */

test.describe("connection: app open / app closed", () => {
  test.fixme("应用开着：onedesk-mcp 连到运行中的内核（devhost），操作者是 ai；界面改了 ai_visible，MCP 立即看得到；MCP 的调用在审计页可见", async () => {});
  test.fixme("应用没开：先停掉 devhost，onedesk-mcp 自己起无界面工作进程，同一个数据目录，tools/call 正常；stdin 关闭后进程退出码 0 且工作进程不残留（用 ps 断言无遗留）", async () => {});
  test.fixme("应用没开时起的工作进程持有工作区锁：此时再起 devhost 会等锁或明确报错（按协议），MCP 退出后能正常启动", async () => {});
  test.fixme("onedesk-mcp 不开网络端口：运行期间用 lsof 断言它没有 LISTEN；标准输出里只有 JSON-RPC 行（strayStdout 为空），日志只走标准错误", async () => {});
  test.fixme("启动参数指定工作区：另建一个工作区，--workspace 指它 → 看到的是那个工作区的资源；不指定 → 默认工作区；不存在的名字 → 启动失败并给出明确标准错误、非零退出码", async () => {});
});

/* ------------------------------------------------- 7. shell: settings page and copy-able config */

test.describe("shell", () => {
  test.fixme("工作区 AI 设置页：总开关、每分钟上限、行数上限、允许自由查询、AI 用的环境；改动后 rpc 回读 mcp policy 一致（截图）", async () => {});
  test.fixme("一段给用户复制到 Claude Desktop 配置里的说明：JSON 可解析，command 指向 .app 内 onedesk-mcp 的路径（路径来自应用本身），点复制后剪贴板内容与显示一致", async () => {});
});
