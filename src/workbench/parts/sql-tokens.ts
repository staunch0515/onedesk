import type { CodeToken } from "../../design";

const KEYWORDS = new Set(
  "select from where and or join left right inner outer cross on group by order limit offset having as in is not null with insert into values update set delete union all distinct case when then else end interval between like desc asc show exists create table alter drop index using replica status hour day month year".split(
    " ",
  ),
);

/** Colours for code fields whose language is "sql". Good enough for display; it is not a parser. */
export function tokenizeSql(code: string): CodeToken[] {
  const out: CodeToken[] = [];
  const re = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.)*'?|"(?:[^"\\]|\\.)*"?)|(`[^`]*`?)|(::)|(:[A-Za-z_][A-Za-z0-9_]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?|([^\sA-Za-z0-9_'"`:-]+|[-:])|(\s+)/g;
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m.index > last) out.push({ text: code.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[1]) out.push({ text: m[1], kind: "comment" });
    else if (m[2]) out.push({ text: m[2], kind: "string" });
    else if (m[3]) out.push({ text: m[3] });
    else if (m[4]) out.push({ text: m[4], kind: "operator" });
    else if (m[5]) out.push({ text: m[5], kind: "param" });
    else if (m[6]) out.push({ text: m[6], kind: "number" });
    else if (m[7]) {
      const word = m[7];
      if (KEYWORDS.has(word.toLowerCase())) out.push({ text: word, kind: "keyword" });
      else if (m[8]) out.push({ text: word, kind: "function" });
      else out.push({ text: word });
      if (m[8]) out.push({ text: m[8] });
    } else if (m[9]) out.push({ text: m[9], kind: "operator" });
    else out.push({ text: m[0] });
    if (m[0].length === 0) re.lastIndex += 1;
  }
  if (last < code.length) out.push({ text: code.slice(last) });
  return out;
}

const JS_KEYWORDS = new Set(
  "async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield".split(
    " ",
  ),
);

/** D487 §37: colours for code fields whose language is "javascript" (the one language of program books). Not a parser. */
export function tokenizeJs(code: string): CodeToken[] {
  const out: CodeToken[] = [];
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\\n]|\\.)*'?|"(?:[^"\\\n]|\\.)*"?|`(?:[^`\\]|\\.)*`?)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)(\s*\()?|([^\sA-Za-z0-9_$'"`]+)|(\s+)/g;
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m.index > last) out.push({ text: code.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[1]) out.push({ text: m[1], kind: "comment" });
    else if (m[2]) out.push({ text: m[2], kind: "string" });
    else if (m[3]) out.push({ text: m[3], kind: "number" });
    else if (m[4]) {
      if (JS_KEYWORDS.has(m[4])) out.push({ text: m[4], kind: "keyword" });
      else if (m[5]) out.push({ text: m[4], kind: "function" });
      else out.push({ text: m[4] });
      if (m[5]) out.push({ text: m[5] });
    } else if (m[6]) out.push({ text: m[6], kind: "operator" });
    else out.push({ text: m[0] });
    if (m[0].length === 0) re.lastIndex += 1;
  }
  if (last < code.length) out.push({ text: code.slice(last) });
  return out;
}

/** D487 §37: colours for "json": keys, strings, numbers, true/false/null. */
export function tokenizeJson(code: string): CodeToken[] {
  const out: CodeToken[] = [];
  const re = /("(?:[^"\\\n]|\\.)*"?)(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b/g;
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m.index > last) out.push({ text: code.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[1]) {
      out.push({ text: m[1], kind: m[2] ? "param" : "string" });
      if (m[2]) out.push({ text: m[2] });
    } else if (m[3]) out.push({ text: m[3], kind: "number" });
    else if (m[4]) out.push({ text: m[4], kind: "keyword" });
    if (m[0].length === 0) re.lastIndex += 1;
  }
  if (last < code.length) out.push({ text: code.slice(last) });
  return out;
}

export const TOKENIZERS: Record<string, (code: string) => CodeToken[]> = { sql: tokenizeSql, javascript: tokenizeJs, json: tokenizeJson };
