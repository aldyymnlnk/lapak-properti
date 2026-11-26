import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const scrypt = promisify(crypto.scrypt);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getEnv(locals?: any): Record<string, string | undefined> {
  const cfEnv = locals?.runtime?.env || {};
  const metaEnv = ((import.meta as any).env || {}) as Record<string, string | undefined>;
  const nodeEnv = typeof process !== 'undefined' && process.env ? process.env : {};
  return {
    ...metaEnv,
    ...nodeEnv,
    ...cfEnv
  };
}

let cachedSupabase: SupabaseClient | null = null;
let cachedKey = '';

export function getSupabase(locals?: any): SupabaseClient {
  const env = getEnv(locals);
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY (atau SUPABASE_ANON_KEY) belum diatur.');
  }

  if (!cachedSupabase || cachedKey !== `${url}::${key}`) {
    cachedSupabase = createClient(url, key);
    cachedKey = `${url}::${key}`;
  }
  return cachedSupabase;
}

export function getAppSecret(locals?: any): string {
  const env = getEnv(locals);
  return env.APP_SECRET || 'dev-fallback-secret-change-in-production';
}

export function isEnforceAuth(locals?: any): boolean {
  const env = getEnv(locals);
  return String(env.ENFORCE_AUTH || 'false').toLowerCase() === 'true';
}

export function jsonRes(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });
}

export const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

export function safeEqual(a: string, b: string) {
  const ba = crypto.createHash('sha256').update(String(a)).digest();
  const bb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ba, bb);
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await scrypt(String(password), salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored?: string | null) {
  if (!stored) return { ok: false, legacy: false };
  if (stored.startsWith('scrypt$')) {
    const [, salt, hashHex] = stored.split('$');
    const derived = (await scrypt(String(password), salt, 64)) as Buffer;
    const expected = Buffer.from(hashHex, 'hex');
    const ok = expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
    return { ok, legacy: false };
  }
  return { ok: safeEqual(sha256(String(password)), stored), legacy: true };
}

const b64url = (input: string) => Buffer.from(input).toString('base64url');

export function signToken(user: { id: string; role: string }, locals?: any) {
  const secret = getAppSecret(locals);
  const payload = {
    id: user.id,
    role: user.role,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  };
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token: string | undefined | null, locals?: any) {
  try {
    const secret = getAppSecret(locals);
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (!safeEqual(sig, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload as { id: string; role: string; exp: number };
  } catch {
    return null;
  }
}

export function getAuthUser(request: Request, locals?: any) {
  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Bearer ')) {
    return verifyToken(header.slice(7).trim(), locals);
  }
  return null;
}

export function checkRole(request: Request, locals: any, ...roles: string[]) {
  if (!isEnforceAuth(locals)) return null;
  const user = getAuthUser(request, locals);
  if (!user) return jsonRes({ error: 'Anda harus login terlebih dahulu.' }, 401);
  if (!roles.includes(user.role)) {
    return jsonRes({ error: 'Anda tidak memiliki akses ke fitur ini.' }, 403);
  }
  return null;
}

export function buildPresetAccounts(locals?: any) {
  const env = getEnv(locals);
  const defs = [
    { env: 'PRESET_SUPERADMIN_PASSWORD', id: 'preset-superadmin', name: 'Super Admin InfoProperti', username: 'superadmin', email: 'superadmin@infoproperti.web.id', role: 'SUPER_ADMIN' },
    { env: 'PRESET_ADMIN_PASSWORD', id: 'preset-admin', name: 'Admin Operasional InfoProperti', username: 'admin', email: 'admin@infoproperti.web.id', role: 'ADMIN' },
    { env: 'PRESET_AGENT_PASSWORD', id: 'preset-agen', name: 'Agen Mitra InfoProperti', username: 'agen', email: 'agen@infoproperti.web.id', role: 'AGENT' }
  ];
  const accounts: Record<string, any> = {};
  for (const d of defs) {
    const password = env[d.env];
    if (!password) continue;
    accounts[d.email] = {
      id: d.id,
      name: d.name,
      username: d.username,
      email: d.email,
      phone: env.PRESET_PHONE || '',
      password,
      role: d.role,
      is_active: true
    };
  }
  return accounts;
}

export function sanitizeUser(u: any) {
  const { password_hash: _pw, ...rest } = u;
  return rest;
}

export async function sendWhatsAppReceipt(order: any, property: any, paymentMethod: string, locals?: any) {
  const env = getEnv(locals);
  if (!order?.buyer_phone || !env.FONNTE_TOKEN) return;

  const shortId = String(order.id).slice(0, 8).toUpperCase();
  const formattedPrice = `Rp ${Number(property?.price || 0).toLocaleString('id-ID')}`;
  const waMessage =
    `*BUKTI PEMBAYARAN LUNAS - INFOPROPERTI*\n\n` +
    `ID Order: *#${shortId}*\n` +
    `Nama: *${order.buyer_name}*\n` +
    `Unit: *${property?.title || '-'}* (${property?.block_or_unit || '-'})\n` +
    `Metode: *${paymentMethod}*\n` +
    `Total Lunas: *${formattedPrice}*\n` +
    `Status Unit: *BOOKED (Terkunci Atas Nama Anda)*\n\n` +
    `Terima kasih telah bertransaksi di InfoProperti.`;

  try {
    await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { Authorization: env.FONNTE_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: order.buyer_phone, message: waMessage })
    });
  } catch (err) {
    console.error('Gagal kirim WA Gateway:', err);
  }
}

export async function syncOrderToGoogleSheet(orderId: string, eventName = 'SYNC', locals?: any) {
  const env = getEnv(locals);
  const webhook = env.GOOGLE_SHEET_WEBHOOK_URL || '';
  if (!webhook) {
    return { skipped: true, reason: 'URL Webhook Google Sheets belum diatur' };
  }

  try {
    const supabase = getSupabase(locals);
    const { data: order, error } = await supabase
      .from('orders')
      .select('*, properties(title, category, price, block_or_unit)')
      .eq('id', orderId)
      .single();

    if (error || !order) {
      return { skipped: true, reason: 'Order tidak ditemukan' };
    }

    const prop = Array.isArray(order.properties) ? order.properties[0] : order.properties;
    const payload = {
      event: eventName,
      order_id: order.id,
      property_title: prop?.title || 'Unit Properti',
      category: prop?.category || '-',
      block_or_unit: prop?.block_or_unit || '-',
      price: prop?.price || 0,
      buyer_name: order.buyer_name,
      buyer_nik: order.buyer_nik || '-',
      buyer_email: order.buyer_email || '-',
      buyer_phone: order.buyer_phone,
      payment_method: order.payment_method || '-',
      notes: order.notes || '-',
      status: order.status
    };

    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: response.ok, raw: text.slice(0, 200) };
    }
  } catch (err: any) {
    console.error('Gagal sync ke Google Sheets:', err?.message || err);
    return { error: err?.message || 'Gagal sync Google Sheets' };
  }
}