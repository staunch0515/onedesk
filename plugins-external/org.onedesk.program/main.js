// Program book plugin (docs/redesign/book.md §37, D489): a plugin written as a book — the manifest page, code pages
// (explanation, then code), language pages, test pages and the build page. The book's pages make up the plugin's files;
// the kernel checks them as a plugin and builds the signed package (K20), and runs the tests in an empty sandbox (K21).
// Runs in the sandbox: no console, timers or fetch; everything goes through ctx.host.

import { NONE } from "./common.js";
import { embedCode, embedLocale, embedManifest, embedTest, manifestConventions, renderCode, renderLocale, renderManifest, renderTest, testAction } from "./pages.js";
import { buildAction, checkAction, renderBuild, tryAction } from "./build.js";
import { aiTest } from "./ai.js";
import { ROLES } from "./roles.js";

export default {
  activate(host) {
    host.kinds.handle("manifest", { embed: embedManifest });
    host.kinds.handle("code", { embed: embedCode });
    host.kinds.handle("locale", { embed: embedLocale });
    host.kinds.handle("test", { embed: embedTest });

    host.pages.handle("manifest", { render: renderManifest });
    host.pages.handle("code", { render: renderCode });
    host.pages.handle("locale", { render: renderLocale });
    host.pages.handle("test", { render: renderTest });
    host.pages.handle("build", { render: renderBuild });

    host.actions.handle("test", testAction);
    host.actions.handle("check", checkAction);
    host.actions.handle("try", tryAction);
    host.actions.handle("build", buildAction);
    host.actions.handle("aiTest", aiTest);

    // `onedesk.book/1`.
    host.actions.handle("roles", async () => ({ output: NONE, data: ROLES }));
    host.actions.handle("outline", async () => ({ output: NONE, data: { headings: [], figures: [], cites: [], terms: [] } }));
    host.actions.handle("conventions", async (ctx) => ({ output: NONE, data: manifestConventions(ctx) }));
  },
};
