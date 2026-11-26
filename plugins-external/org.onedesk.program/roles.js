// What the program book's kinds are in a book (interface `onedesk.book/1`, docs/redesign/book.md §37.2). A book with a
// manifest page is a program book; the book itself is not told.
export const ROLES = {
  kinds: [
    { kind: "manifest", role: "manifest", part: "front", single: true, container: false, numbering: "none" },
    { kind: "build", role: "build", part: "front", single: true, container: false, numbering: "none" },
    { kind: "code", role: "body", part: "body", single: false, container: false, numbering: "level" },
    { kind: "locale", role: "locale", part: "back", single: false, container: false, numbering: "none" },
    { kind: "test", role: "tests", part: "back", single: false, container: false, numbering: "none" },
  ],
};
