// Letters plugin (docs/redesign/book.md §35, D489): the registers of letters received and sent (收文簿, 发文簿), a
// letter written to send (发件) and a letter received (来件). The kernel signs, addresses and checks letters (K19); what
// can be asked of a page and what comes back is the business of that page's role, through `onedesk.letter/1`.
// Runs in the sandbox: no console, timers or fetch; everything goes through ctx.host.

import { renderInbox, renderOutbox } from "./registers.js";
import { renderSent, sendAction } from "./sent.js";
import { renderLetter, replyAction } from "./letter.js";

export default {
  activate(host) {
    host.pages.handle("inbox", { render: renderInbox });
    host.pages.handle("outbox", { render: renderOutbox });
    host.pages.handle("sent", { render: renderSent });
    host.pages.handle("letter", { render: renderLetter });
    host.actions.handle("send", sendAction);
    host.actions.handle("reply", replyAction);
  },
};
