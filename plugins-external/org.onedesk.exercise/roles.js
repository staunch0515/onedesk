// What the exercise kinds are in a book (interface `onedesk.book/1`, docs/redesign/book.md §19.2).
export const ROLES = {
  kinds: [
    { kind: "question", role: "question", part: "none", single: false, container: false, numbering: "none" },
    { kind: "practice", role: "practice", part: "body", single: false, container: false, numbering: "level" },
    { kind: "test", role: "test", part: "body", single: false, container: false, numbering: "level" },
    { kind: "lessons", role: "toc", part: "none", single: true, container: false, numbering: "none" },
    // D487 §21: at the back, lettered; only in the teacher's edition.
    { kind: "answers", role: "answers", part: "back", single: true, container: false, numbering: "letter", edition: "teacher" },
  ],
};
