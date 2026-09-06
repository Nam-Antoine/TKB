/**
 * Outbound notifications: ntfy (phone push), Discord, Telegram, generic webhook.
 * Every sender returns { target, ok, error? } and never throws.
 *
 * HTTP goes through an injectable fetch (the Tauri build routes it through the
 * Rust side so the webview's CORS rules do not apply).
 */
import { hmacSha256Hex } from './usth-api.js';

const TIMEOUT_MS = 15000;
let fetchImpl = (...args) => globalThis.fetch(...args);

/** @param {(url: string, init: object) => Promise<{status: number, text: () => Promise<string>}>} fn */
export function setFetch(fn) { fetchImpl = fn; }

async function request(url, init) {
  const res = await fetchImpl(url, { ...init, timeoutMs: TIMEOUT_MS });
  const text = await res.text().catch(() => '');
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return text;
}

export function chunk(text, max) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

export async function sendNtfy(cfg, msg) {
  const server = (cfg.server || 'https://ntfy.sh').replace(/\/+$/, '');
  if (!cfg.topic) throw new Error('ntfy topic is empty');
  const headers = { 'content-type': 'application/json' };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const body = {
    topic: cfg.topic,
    title: msg.title,
    message: msg.text || msg.title,
    priority: msg.priority === 'high' ? 4 : 3,
    tags: msg.tags || ['calendar'],
  };
  if (msg.click) body.click = msg.click;
  await request(server + '/', { method: 'POST', headers, body: JSON.stringify(body) });
}

export async function sendDiscord(cfg, msg) {
  if (!cfg.url) throw new Error('Discord webhook URL is empty');
  const full = `**${msg.title}**\n${msg.text || ''}`.trim();
  for (const part of chunk(full, 1900)) {
    await request(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: part }) });
  }
}

export async function sendTelegram(cfg, msg) {
  if (!cfg.botToken || !cfg.chatId) throw new Error('Telegram bot token or chat id is empty');
  const full = `${msg.title}\n${msg.text || ''}`.trim();
  for (const part of chunk(full, 4000)) {
    await request(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text: part, disable_web_page_preview: true }),
    });
  }
}

export async function sendGeneric(cfg, msg, payload) {
  if (!cfg.url) throw new Error('Webhook URL is empty');
  const body = JSON.stringify({ event: msg.event || 'timetable.changed', title: msg.title, text: msg.text, sentAt: new Date().toISOString(), ...payload });
  const headers = { 'content-type': 'application/json', 'user-agent': 'usth-timetable-desktop' };
  if (cfg.secret) headers['x-tkb-signature'] = await hmacSha256Hex(cfg.secret, body);
  await request(cfg.url, { method: 'POST', headers, body });
}

const SENDERS = { ntfy: sendNtfy, discord: sendDiscord, telegram: sendTelegram, generic: sendGeneric };

/**
 * @param {object} webhooks  config.webhooks
 * @param {{title:string,text:string,event?:string,priority?:string,click?:string}} msg
 * @param {object} payload   extra JSON for the generic webhook
 * @param {{force?:boolean}} opts  force = send even to disabled targets that are configured (used by "test")
 */
export async function dispatch(webhooks, msg, payload = {}, opts = {}) {
  const results = [];
  for (const [target, sender] of Object.entries(SENDERS)) {
    const cfg = (webhooks && webhooks[target]) || {};
    const configured = target === 'ntfy' ? !!cfg.topic : target === 'telegram' ? !!(cfg.botToken && cfg.chatId) : !!cfg.url;
    if (!(cfg.enabled || (opts.force && configured))) continue;
    try {
      await sender(cfg, msg, payload);
      results.push({ target, ok: true });
    } catch (e) {
      results.push({ target, ok: false, error: e.message });
    }
  }
  return results;
}
