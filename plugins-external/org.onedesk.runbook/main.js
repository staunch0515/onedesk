// Runbook plugin (docs/redesign/book.md §25, D487): steps (what to do, what to run, what should be seen), the flow
// contents (a contents whose reading is carrying the steps out, one after another) and run logs (what happened, as a
// report). Its kinds play roles in books through the interface `onedesk.book/1`.
// Runs in the sandbox: no console, timers or fetch; everything goes through ctx.host.

import { NONE, say } from "./common.js";
import { continueAction, flowEntries, flowEvent, renderFlow, runAction } from "./flow.js";
import { embedStep, renderStep, runOneAction } from "./step.js";
import { exportAction, renderLog } from "./log.js";
import { ROLES } from "./roles.js";

export default {
  activate(host) {
    host.kinds.handle("step", { embed: embedStep });

    host.pages.handle("step", { render: renderStep });
    host.pages.handle("flow", { render: renderFlow, onEvent: flowEvent });
    host.pages.handle("log", { render: renderLog });
    host.pages.handle("logs", { render: async (ctx) => ({ view: [{ type: "text", id: "hint", text: say(ctx, "logs.hint"), tone: "muted" }] }) });

    host.actions.handle("run", runAction);
    host.actions.handle("continue", continueAction);
    host.actions.handle("runOne", runOneAction);
    host.actions.handle("export", exportAction);

    // `onedesk.book/1`.
    host.actions.handle("roles", async () => ({ output: NONE, data: ROLES }));
    host.actions.handle("outline", async () => ({ output: NONE, data: { headings: [], figures: [], cites: [], terms: [] } }));
    host.actions.handle("entries", async (ctx, input) => ({ output: NONE, data: await flowEntries(ctx, input) }));
  },
};
