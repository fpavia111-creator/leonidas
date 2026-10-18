'use strict';
const COLS = ['id', 'email', 'name', 'title', 'company', 'industry', 'employees', 'location', 'score', 'qualified', 'status', 'source'];
const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
function toCsv(leads, cols = COLS) { return [cols.join(','), ...leads.map(l => cols.map(c => esc(l[c])).join(','))].join('\n') + '\n'; }
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [h, ...rest] = rows.filter(r => r.some(x => x !== ''));
  return rest.map(r => Object.fromEntries(h.map((k, i) => [k.trim(), r[i]])));
}
module.exports = { toCsv, parseCsv, COLS };
