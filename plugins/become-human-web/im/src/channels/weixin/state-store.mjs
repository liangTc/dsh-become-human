import { weixinStageError } from './connection-error.mjs';
import { deferredStateAccess, normalizeDeferredState } from '../shared/deferred-state.mjs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { weixinMessageTimestampMs } from './weixin-api.mjs';

const EMPTY_STATE = Object.freeze({
  version: 1,
  sessions: {},
  seenMessageIds: [],
  getUpdatesBuf: '',
  recentOutboundMessages: [],
});

export const WEIXIN_RECENT_OUTBOUND_LIMIT = 200;
export const WEIXIN_RECENT_OUTBOUND_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const WEIXIN_RECENT_OUTBOUND_TEXT_LIMIT = 8_000;
export const WEIXIN_RECENT_OUTBOUND_MATCH_TOLERANCE_MS = 15_000;
const CONTEXT_TOKEN_LIMIT = 1_000;
// UI guidance only. The provider remains the authority on every send attempt.
export const WEIXIN_REPLY_WINDOW_ESTIMATE_MS = 24 * 60 * 60 * 1_000;
const INBOUND_CLOCK_SKEW_MS = 5_000;
const SEND_CODES = new Set(['send-rejected', 'network-error', 'timeout', 'http-error', 'bot-not-connected', 'invalid-target', 'weixin-send-failed', 'aborted']);
const safeSendCode = value => SEND_CODES.has(value) ? value : 'weixin-send-failed';
const safeProviderCode = value => /^-?\d{1,8}$/.test(String(value ?? '')) ? String(value) : null;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function timestamp(value) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function inboundTimestamp(value, receivedAt) {
  const source = timestamp(value);
  if (source === null || source <= 0 || receivedAt === null || source > receivedAt + INBOUND_CLOCK_SKEW_MS) return null;
  // Small provider/local clock skew is real: source IDs can lead reception by
  // milliseconds. Clamp to the original receipt; never extend a window into the
  // future, and never substitute reload time for an old interaction.
  return Math.min(source, receivedAt);
}

function sequence(value) {
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : '';
  return /^\d+$/.test(text) ? BigInt(text).toString() : null;
}

function deliveryState(value = {}) {
  return {
    lastAttemptAt: timestamp(value.lastAttemptAt), lastSuccessAt: timestamp(value.lastSuccessAt),
    lastFailureAt: timestamp(value.lastFailureAt),
    lastFailureCode: value.lastFailureCode ? safeSendCode(value.lastFailureCode) : null,
    lastFailureProviderCode: safeProviderCode(value.lastFailureProviderCode),
    lastOutcome: ['success', 'failure'].includes(value.lastOutcome) ? value.lastOutcome : null,
  };
}

function normalizeContextTokens(value) {
  if (!value || typeof value !== 'object' || !/^[a-f0-9]{64}$/.test(value.credentialHash ?? '')) return undefined;
  const users = Object.create(null);
  for (const [userId, entry] of Object.entries(value.users ?? {}).slice(-CONTEXT_TOKEN_LIMIT)) {
    if (!nonEmptyString(userId) || !entry || typeof entry !== 'object') continue;
    const receivedAt = timestamp(entry.receivedAt), messageTimeMs = timestamp(entry.messageTimeMs);
    // beta.3 discarded slightly-ahead source clocks. Recover only from that
    // event's stored ID and stored receipt, not from the time this file loads.
    const sourceTime = inboundTimestamp(messageTimeMs ?? (receivedAt !== null ? weixinMessageTimestampMs(entry.messageId, { now: receivedAt }) : null), receivedAt);
    users[userId] = {
      token: nonEmptyString(entry.token),
      seq: sequence(entry.seq),
      messageTimeMs: sourceTime, receivedAt,
      messageId: nonEmptyString(entry.messageId)?.slice(0, 256) ?? null,
      lastInboundAt: inboundTimestamp(entry.lastInboundAt, receivedAt) ?? sourceTime,
      contextUpdatedAt: timestamp(entry.contextUpdatedAt) ?? (nonEmptyString(entry.token) ? receivedAt : null),
      delivery: deliveryState(entry.delivery),
    };
  }
  return { credentialHash: value.credentialHash, users };
}

function providerMessageIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((id) => (id === undefined || id === null ? null : nonEmptyString(String(id))))
    .filter(Boolean))];
}

function truncateText(value) {
  const text = nonEmptyString(value);
  return text ? [...text].slice(0, WEIXIN_RECENT_OUTBOUND_TEXT_LIMIT).join('') : null;
}

function normalizeRecentOutboundMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const toUserId = nonEmptyString(value.toUserId);
  const text = truncateText(value.text);
  const sentAt = timestamp(value.sentAt);
  const completedAt = timestamp(value.completedAt) ?? sentAt;
  if (!toUserId || !text || sentAt === null || completedAt === null) return null;
  return {
    toUserId,
    text,
    sentAt,
    completedAt: Math.max(sentAt, completedAt),
    providerMessageIds: providerMessageIds(value.providerMessageIds),
  };
}

function recentOutboundMessages(value, now = Date.now()) {
  if (!Array.isArray(value)) return [];
  const cutoff = now - WEIXIN_RECENT_OUTBOUND_TTL_MS;
  return value
    .map(normalizeRecentOutboundMessage)
    .filter((entry) => entry && entry.completedAt >= cutoff)
    .slice(-WEIXIN_RECENT_OUTBOUND_LIMIT);
}

function normalizeState(value) {
  if (!value || typeof value !== 'object') return structuredClone(EMPTY_STATE);
  const sessions = {};
  if (value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)) {
    for (const [key, sessionId] of Object.entries(value.sessions)) {
      if (typeof key === 'string' && typeof sessionId === 'string' && sessionId) {
        sessions[key] = sessionId;
      }
    }
  }
  const contextTokens = normalizeContextTokens(value.contextTokens);
  return {
    version: 1,
    sessions,
    ...(value.deferred ? { deferred: normalizeDeferredState(value.deferred) } : {}),
    seenMessageIds: Array.isArray(value.seenMessageIds)
      ? value.seenMessageIds.filter((id) => typeof id === 'string').slice(-1_000)
      : [],
    getUpdatesBuf: typeof value.getUpdatesBuf === 'string' ? value.getUpdatesBuf : '',
    recentOutboundMessages: recentOutboundMessages(value.recentOutboundMessages),
    ...(contextTokens ? { contextTokens } : {}),
  };
}

export class WeixinStateStore {
  #path;
  #state = structuredClone(EMPTY_STATE);
  #writeQueue = Promise.resolve();
  #deferred = deferredStateAccess(() => this.#state, () => this.#persist());

  constructor(path) {
    this.#path = path;
  }

  async load() {
    try {
      this.#state = normalizeState(JSON.parse(await readFile(this.#path, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw weixinStageError('account-state-read-failed', error);
      this.#state = structuredClone(EMPTY_STATE);
      await this.#persist();
    }
    return this;
  }

  deferredEntries() { return this.#deferred.entries(); }
  putDeferred(entry) { return this.#deferred.put(entry); }
  patchDeferred(id, patch) { return this.#deferred.patch(id, patch); }
  removeDeferred(id) { return this.#deferred.remove(id); }

  // Context belongs to this bot login, not to a Harness session or workspace.
  async bindContextTokens(token) {
    const credentialHash = createHash('sha256').update(token).digest('hex');
    if (this.#state.contextTokens?.credentialHash === credentialHash) return;
    this.#state.contextTokens = { credentialHash, users: Object.create(null) };
    await this.#persist();
  }

  contextTokenFor(userId) {
    return this.#state.contextTokens?.users?.[userId]?.token ?? undefined;
  }

  async rememberContextToken({ userId, contextToken, seq, messageTimeMs, messageId }) {
    if (!nonEmptyString(userId) || !this.#state.contextTokens) return false;
    const users = this.#state.contextTokens.users;
    const previous = users[userId];
    const receivedAt = Date.now(), sourceTime = inboundTimestamp(messageTimeMs, receivedAt), sourceId = nonEmptyString(messageId)?.slice(0, 256) ?? null;
    const next = { token: nonEmptyString(contextToken) ?? previous?.token ?? null, seq: sequence(seq), messageTimeMs: sourceTime, receivedAt,
      messageId: sourceId, lastInboundAt: sourceTime,
      contextUpdatedAt: nonEmptyString(contextToken) ? receivedAt : previous?.contextUpdatedAt ?? null,
      delivery: deliveryState(previous?.delivery) };
    // Late/duplicate batches must not replace a newer conversation capability.
    if (previous) {
      if (sourceId && previous.messageId === sourceId) return false;
      if (previous.seq !== null && next.seq !== null && BigInt(next.seq) <= BigInt(previous.seq)) return false;
      if (previous.messageTimeMs !== null && next.messageTimeMs !== null
        && next.messageTimeMs < previous.messageTimeMs) return false;
      if (!sourceId && next.seq === null && next.messageTimeMs === null) return false;
      if (!sourceId && next.seq === null && next.messageTimeMs === previous.messageTimeMs) return false;
    }
    delete users[userId];
    users[userId] = next;
    const keys = Object.keys(users);
    if (keys.length > CONTEXT_TOKEN_LIMIT) delete users[keys[0]];
    await this.#persist();
    return true;
  }

  async recordSend({ userId, phase, at = Date.now(), code, providerCode }) {
    if (!nonEmptyString(userId) || !this.#state.contextTokens || !['attempt', 'success', 'failure'].includes(phase)) return;
    const users = this.#state.contextTokens.users, entry = users[userId] ??= {
      token: null, seq: null, messageTimeMs: null, receivedAt: null, messageId: null,
      lastInboundAt: null, contextUpdatedAt: null, delivery: deliveryState(),
    };
    const value = Math.min(timestamp(at) ?? Date.now(), Date.now());
    entry.delivery ??= deliveryState();
    if (phase === 'attempt') entry.delivery.lastAttemptAt = Math.max(entry.delivery.lastAttemptAt ?? 0, value);
    if (phase === 'success') { entry.delivery.lastSuccessAt = Math.max(entry.delivery.lastSuccessAt ?? 0, value); entry.delivery.lastOutcome = 'success'; }
    if (phase === 'failure') {
      entry.delivery.lastFailureAt = Math.max(entry.delivery.lastFailureAt ?? 0, value);
      entry.delivery.lastFailureCode = safeSendCode(code);
      entry.delivery.lastFailureProviderCode = safeProviderCode(providerCode);
      entry.delivery.lastOutcome = 'failure';
    }
    const keys = Object.keys(users); if (keys.length > CONTEXT_TOKEN_LIMIT) delete users[keys[0]];
    await this.#persist();
  }

  deliveryHealthFor(userId, { now = Date.now(), scope = 'bound-owner' } = {}) {
    if (scope !== 'bound-owner') userId = null;
    const entry = userId ? this.#state.contextTokens?.users?.[userId] : null;
    const lastInboundAt = entry?.lastInboundAt > 0 && entry.lastInboundAt <= now ? entry.lastInboundAt : null;
    const expires = lastInboundAt === null ? null : lastInboundAt + WEIXIN_REPLY_WINDOW_ESTIMATE_MS;
    const windowEstimate = expires === null ? 'unknown' : now < expires ? 'within' : 'outside';
    const delivery = deliveryState(entry?.delivery);
    // Old versions recorded successful outbound completion, but no attempt log.
    const oldSuccess = userId ? Math.max(0, ...this.#state.recentOutboundMessages.filter(row => row.toUserId === userId).map(row => row.completedAt)) : 0;
    const lastSuccessAt = Math.max(delivery.lastSuccessAt ?? 0, oldSuccess) || null;
    const failureOutstanding = delivery.lastFailureAt !== null && (delivery.lastFailureAt > (lastSuccessAt ?? 0)
      || delivery.lastFailureAt === lastSuccessAt && delivery.lastOutcome === 'failure');
    let sendability = lastSuccessAt ? 'available' : 'unknown';
    if (failureOutstanding) sendability = lastInboundAt !== null && lastInboundAt > delivery.lastFailureAt ? 'unknown'
      : delivery.lastFailureProviderCode === '-2' ? 'refresh-needed' : 'failed';
    else if (windowEstimate === 'outside') sendability = 'refresh-needed';
    return {
      scope: userId && scope === 'bound-owner' ? 'bound-owner' : 'unknown', lastInboundAt,
      contextUpdatedAt: entry?.contextUpdatedAt ?? null, estimatedWindowExpiresAt: expires,
      estimatedWindowMs: WEIXIN_REPLY_WINDOW_ESTIMATE_MS, windowEstimate, sendability,
      lastSendAttemptAt: delivery.lastAttemptAt, lastSendSuccessAt: lastSuccessAt,
      lastSendFailureAt: delivery.lastFailureAt, lastSendFailureCode: delivery.lastFailureCode,
      lastSendFailureProviderCode: delivery.lastFailureProviderCode, windowIsEstimate: true,
    };
  }

  hasSendFailureFor(userId) {
    const d = this.deliveryHealthFor(userId), entry = this.#state.contextTokens?.users?.[userId];
    return d.lastSendFailureAt !== null && (d.lastSendFailureAt > (d.lastSendSuccessAt ?? 0)
      || d.lastSendFailureAt === d.lastSendSuccessAt && entry?.delivery?.lastOutcome === 'failure');
  }

  sessionFor(key) {
    return this.#state.sessions[key] ?? null;
  }

  async setSession(key, sessionId) {
    this.#state.sessions[key] = sessionId;
    await this.#persist();
  }

  async clearSession(key) {
    delete this.#state.sessions[key];
    await this.#persist();
  }

  async clearSessions() {
    this.#state.sessions = {};
    await this.#persist();
  }

  hasSeen(messageId) {
    return this.#state.seenMessageIds.includes(messageId);
  }

  async markSeen(messageId) {
    if (this.hasSeen(messageId)) return;
    this.#state.seenMessageIds.push(messageId);
    if (this.#state.seenMessageIds.length > 1_000) {
      this.#state.seenMessageIds.splice(0, this.#state.seenMessageIds.length - 1_000);
    }
    await this.#persist();
  }

  getUpdatesBuf() {
    return this.#state.getUpdatesBuf;
  }

  async setGetUpdatesBuf(value) {
    if (typeof value !== 'string' || value === this.#state.getUpdatesBuf) return;
    this.#state.getUpdatesBuf = value;
    await this.#persist();
  }

  async rememberOutboundMessage({
    toUserId,
    text,
    sentAt = Date.now(),
    completedAt = Date.now(),
    providerMessageIds: messageIds = [],
  } = {}) {
    const entry = normalizeRecentOutboundMessage({
      toUserId,
      text,
      sentAt,
      completedAt,
      providerMessageIds: messageIds,
    });
    if (!entry) throw new TypeError('Invalid Weixin outbound message');
    this.#state.recentOutboundMessages = recentOutboundMessages([
      ...this.#state.recentOutboundMessages,
      entry,
    ]);
    await this.#persist();
  }

  recentOutboundTextFor({
    toUserId,
    messageId,
    createTimeMs,
    updateTimeMs,
    now = Date.now(),
  } = {}) {
    const recipient = nonEmptyString(toUserId);
    if (!recipient) return null;
    const active = recentOutboundMessages(this.#state.recentOutboundMessages, now)
      .filter((entry) => entry.toUserId === recipient);
    const quotedMessageId = messageId === undefined || messageId === null
      ? null
      : nonEmptyString(String(messageId));
    if (quotedMessageId) {
      const exact = active.filter((entry) => entry.providerMessageIds.includes(quotedMessageId));
      if (exact.length === 1) return exact[0].text;
      if (exact.length > 1) return null;
    }
    const quotedTimes = [
      timestamp(createTimeMs),
      timestamp(updateTimeMs),
      weixinMessageTimestampMs(quotedMessageId, { now }),
    ]
      .filter((value) => value !== null);
    if (quotedTimes.length === 0) return null;
    const candidates = active.filter((entry) => quotedTimes.some((quotedAt) => (
      quotedAt >= entry.sentAt - WEIXIN_RECENT_OUTBOUND_MATCH_TOLERANCE_MS
        && quotedAt <= entry.completedAt + WEIXIN_RECENT_OUTBOUND_MATCH_TOLERANCE_MS
    )));
    return candidates.length === 1 ? candidates[0].text : null;
  }

  snapshot() {
    const { contextTokens, ...state } = this.#state;
    return structuredClone(state);
  }

  async remove() {
    try {
      await unlink(this.#path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw weixinStageError('account-state-cleanup-failed', error);
    }
    this.#state = structuredClone(EMPTY_STATE);
  }

  async #persist() {
    const snapshot = `${JSON.stringify(this.#state, null, 2)}\n`;
    const operation = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#path);
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    await operation.catch(error => { throw weixinStageError('account-state-write-failed', error); });
  }
}
