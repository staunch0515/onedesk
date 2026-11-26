// What the ledger's kinds are in a book (interface `onedesk.book/1`, docs/redesign/book.md §27.2).
export const ROLES = {
  kinds: [
    { kind: "setup", role: "setup", part: "front", single: true, container: false, numbering: "none" },
    { kind: "catalog", role: "toc", part: "none", single: true, container: false, numbering: "none" },
    { kind: "item", role: "account", part: "body", single: false, container: true, numbering: "level" },
    { kind: "sheet", role: "sheet", part: "body", single: false, container: false, numbering: "none" },
    { kind: "receipt", role: "voucher", part: "none", single: false, container: false, numbering: "none" },
    { kind: "issue", role: "voucher", part: "none", single: false, container: false, numbering: "none" },
    { kind: "count", role: "voucher", part: "none", single: false, container: false, numbering: "none" },
    { kind: "vouchers", role: "register", part: "back", single: false, container: false, numbering: "none" },
    { kind: "summary", role: "report", part: "back", single: false, container: false, numbering: "none" },
  ],
};
