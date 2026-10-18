'use strict';
/** Match a prospect's objection to a configured response (product.objectionResponses map). */
const STOP = new Set(['i', 'a', 'an', 'the', 'to', 'it', 'is', 'my', 'me', 'you', 'your', 'do', 'can', 'of', 'for', 'and', 'or', 'in', 'on', 'this', 'that', 'what', 'will', 'with', 'be', 'if', 'have', 'just', 'so', 'are']);
const tokens = s => (String(s).toLowerCase().match(/[a-z0-9$']+/g) || []).map(w => w.replace(/'/g, '')).filter(w => w && !STOP.has(w));

/** Returns {objection, response, score} for the best match, or null below minScore (Jaccard). */
function matchObjection(map, text, { minScore = 0.25 } = {}) {
  const q = new Set(tokens(text));
  if (!q.size || !map) return null;
  let best = null;
  for (const [objection, response] of Object.entries(map)) {
    const t = new Set(tokens(objection));
    const inter = [...t].filter(w => q.has(w)).length;
    const score = inter / (new Set([...t, ...q]).size || 1);
    if (!best || score > best.score) best = { objection, response, score: Math.round(score * 100) / 100 };
  }
  return best && best.score >= minScore ? best : null;
}

module.exports = { matchObjection };
