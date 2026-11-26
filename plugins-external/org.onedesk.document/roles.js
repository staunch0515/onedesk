// What the document kinds are in a book (interface `onedesk.book/1`, docs/redesign/book.md §23.2).
export const ROLES = {
  kinds: [
    { kind: "template", role: "template", part: "none", single: false, container: false, numbering: "none" },
    { kind: "document", role: "document", part: "body", single: false, container: false, numbering: "level" },
    { kind: "series", role: "series", part: "body", single: false, container: true, numbering: "level" },
  ],
};
