// What the runbook's kinds are in a book (interface `onedesk.book/1`, docs/redesign/book.md §25.2).
export const ROLES = {
  kinds: [
    { kind: "step", role: "step", part: "body", single: false, container: false, numbering: "level" },
    { kind: "flow", role: "toc", part: "none", single: true, container: false, numbering: "none" },
  ],
};
