// Finds `:name` parameters, skipping strings, quoted identifiers, comments and `::` casts.
export function tokenizeParams(sql) {
  const out = [];
  const seen = new Set();
  const n = sql.length;
  let i = 0;
  const isStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95;
  const isPart = (c) => isStart(c) || (c >= 48 && c <= 57);
  while (i < n) {
    const c = sql.charCodeAt(i);
    if (c === 39 || c === 34) {
      i++;
      while (i < n) {
        if (sql.charCodeAt(i) === c) { if (sql.charCodeAt(i + 1) === c) { i += 2; continue; } break; }
        i++;
      }
      i++;
    } else if (c === 45 && sql.charCodeAt(i + 1) === 45) {
      while (i < n && sql.charCodeAt(i) !== 10) i++;
    } else if (c === 47 && sql.charCodeAt(i + 1) === 42) {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === 58) {
      if (sql.charCodeAt(i + 1) === 58) { i += 2; continue; }
      let j = i + 1;
      if (j < n && isStart(sql.charCodeAt(j))) {
        while (j < n && isPart(sql.charCodeAt(j))) j++;
        const name = sql.slice(i + 1, j);
        if (!seen.has(name)) { seen.add(name); out.push(name); }
        i = j;
      } else i++;
    } else i++;
  }
  return out;
}
