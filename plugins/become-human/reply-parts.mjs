// Shared by the Web renderer and delivery adapters. This only chooses display
// boundaries; it does not change the canonical message or generate new text.
const MAX_CHAT_CHARACTERS = 600;
const opening = new Map([['“', '”'], ['「', '」'], ['『', '』'], ['（', '）'], ['(', ')'], ['【', '】'], ['《', '》']]);
const closing = new Set([...opening.values(), '"']);
const sentenceEnd = /[。！？!?]/u;
const commandReceipt = /^(?:\s*\/[\w-]+(?:\s|$)|(?:已暂停|已恢复|已绑定|已解绑|已取消(?:提醒|任务)|当前没有待触发的提醒|本\s*Agent\s*只有一个会话)|(?:(?:自主|本窗口|当前)额度|(?:运行|自主|绑定|配对)状态)[：:。！!\s]|\s*(?:状态|任务\s*ID|会话\s*ID|Session\s*ID)[：:])/iu;

function structured(text) {
  // A code span, link, list or table should retain its original visual unit.
  return /[`~]{3}|`|(?:https?:\/\/|www\.)|\[[^\]\n]+\]\([^\n]*\)|^[ \t]*(?:#{1,6}\s|[-+*]\s|\d+[.)、]\s|>\s|\|)|\n[ \t]*[-:]+[ \t]*\|/imu.test(text)
    || commandReceipt.test(text);
}

function sentenceBoundaries(text) {
  const boundaries = [], stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (stack.at(-1) === c) stack.pop(); else stack.push(c); continue; }
    if (opening.has(c)) { stack.push(opening.get(c)); continue; }
    if (closing.has(c)) { if (stack.at(-1) === c) stack.pop(); continue; }
    if (!sentenceEnd.test(c) && !(c === '.' && /\s/u.test(text[i + 1] ?? ''))) continue;
    let end = i + 1;
    while (end < text.length && sentenceEnd.test(text[end])) end++;
    // A sentence ending inside a quote/aside is only a boundary when that
    // quote/aside also closes here. Never cut in the middle of quoted speech.
    const pending = [...stack];
    while (end < text.length && closing.has(text[end]) && pending.at(-1) === text[end]) { pending.pop(); end++; }
    if (!pending.length && end < text.length && !/[，,、：:；;]/u.test(text[end])) boundaries.push(end);
  }
  return [...new Set(boundaries)];
}

function partition(text, boundaries, maxParts) {
  const cuts = [0, ...boundaries.filter(n => n > 0 && n < text.length && text.slice(n).trim()), text.length];
  if (cuts.length <= maxParts + 1) return cuts.slice(1).map((end, i) => text.slice(cuts[i], end).trim()).filter(Boolean);
  // Merge adjacent complete sentences/paragraphs when there are too many. A
  // balanced choice avoids sending a tiny first bubble and a huge final one.
  const chosen = [0];
  for (let part = 1; part < maxParts; part++) {
    const previous = chosen.at(-1), target = text.length * part / maxParts;
    const candidates = cuts.filter((n, i) => n > previous && i <= cuts.length - 1 - (maxParts - part));
    chosen.push(candidates.reduce((best, n) => Math.abs(n - target) < Math.abs(best - target) ? n : best));
  }
  chosen.push(text.length);
  return chosen.slice(1).map((end, i) => text.slice(chosen[i], end).trim()).filter(Boolean);
}

/** Split a short conversational reply at semantic boundaries, at most 3 parts.
 * All non-whitespace characters remain unchanged and in their original order.
 * Structured/long content and single sentences deliberately stay in one part.
 */
export function replyParts(text, {enabled = true, maxParts = 3} = {}) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return [];
  const limit = Number.isFinite(maxParts) ? Math.max(1, Math.min(3, Math.floor(maxParts))) : 3;
  if (!enabled || limit === 1 || Array.from(value).length > MAX_CHAT_CHARACTERS || structured(value)) return [value];
  const paragraphs = [...value.matchAll(/\r?\n[ \t]*\r?\n+/gu)].map(match => match.index + match[0].length);
  return partition(value, paragraphs.length ? paragraphs : sentenceBoundaries(value), limit);
}
