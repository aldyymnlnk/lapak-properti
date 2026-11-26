require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { promisify } = require('util');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const scrypt = promisify(crypto.scrypt);

const app = express();
const PORT = process.env.PORT || 5000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Render berada di belakang proxy, supaya req.ip benar (dipakai rate limit)
app.set('trust proxy', 1);

// ==========================================
// KONFIGURASI (SEMUA RAHASIA DARI ENVIRONMENT VARIABLE)
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
// Backend sebaiknya memakai service_role key (hanya di server). Fallback ke anon key.
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const GOOGLE_SHEET_WEBHOOK = process.env.GOOGLE_SHEET_WEBHOOK_URL || '';

// Jika true, endpoint admin/superadmin/agen wajib membawa token login (Authorization: Bearer ...)
const ENFORCE_AUTH = String(process.env.ENFORCE_AUTH || 'false').toLowerCase() === 'true';

let APP_SECRET = process.env.APP_SECRET;
if (!APP_SECRET) {
  APP_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('PERINGATAN: APP_SECRET belum diatur. Token login akan tidak valid setiap server restart.');
}

if (!supabaseUrl || !supabaseKey) {
  console.error('FATAL ERROR: SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY (atau SUPABASE_ANON_KEY) belum diatur!');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// CORS
// ==========================================
const defaultOrigins = ['https://infoproperti.web.id', 'https://www.infoproperti.web.id'];
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : defaultOrigins;

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl, server-to-server, health check
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (process.env.ALLOW_PAGES_DEV !== 'false' && /^https:\/\/[a-z0-9-]+\.pages\.dev$/i.test(origin)) {
        return cb(null, true);
      }
      if (!IS_PROD && /^http:\/\/localhost:\d+$/.test(origin)) return cb(null, true);
      return cb(new Error('Origin tidak diizinkan oleh CORS'));
    }
  })
);
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ==========================================
// HELPER KEAMANAN
// ==========================================
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function safeEqual(a, b) {
  const ba = crypto.createHash('sha256').update(String(a)).digest();
  const bb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ba, bb);
}

// Hash baru: scrypt + salt. Hash lama (SHA-256 polos) tetap bisa diverifikasi lalu otomatis di-upgrade saat login.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(String(password), salt, 64);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (!stored) return { ok: false, legacy: false };
  if (stored.startsWith('scrypt$')) {
    const [, salt, hashHex] = stored.split('$');
    const derived = await scrypt(String(password), salt, 64);
    const expected = Buffer.from(hashHex, 'hex');
    const ok = expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
    return { ok, legacy: false };
  }
  return { ok: safeEqual(sha256(String(password)), stored), legacy: true };
}

const b64url = (input) => Buffer.from(input).toString('base64url');

function signToken(user) {
  const payload = {
    id: user.id,
    role: user.role,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  };
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url');
    if (!safeEqual(sig, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Selalu baca token bila ada (supaya req.user terisi)
app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    req.user = verifyToken(header.slice(7));
  }
  next();
});

// Pembatas hak akses. Bila ENFORCE_AUTH=false, middleware ini tidak memblokir (mode transisi).
function requireRole(...roles) {
  return (req, res, next) => {
    if (!ENFORCE_AUTH) return next();
    if (!req.user) return res.status(401).json({ error: 'Anda harus login terlebih dahulu.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Anda tidak memiliki akses ke fitur ini.' });
    }
    next();
  };
}

// Agen hanya boleh mengubah/menghapus properti miliknya sendiri
async function enforcePropertyOwnership(req, res, next) {
  try {
    if (!ENFORCE_AUTH || !req.user || req.user.role !== 'AGENT') return next();

    if (req.method === 'POST') {
      req.body.owner_id = req.user.id;
      req.body.owner_role = 'AGENT';
      return next();
    }

    const { data } = await supabase
      .from('properties')
      .select('owner_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!data || String(data.owner_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Anda hanya boleh mengelola properti milik Anda sendiri.' });
    }
    delete req.body.owner_id;
    delete req.body.owner_role;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// Rate limit sederhana (di memori) untuk login/registrasi
const attempts = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const rec = attempts.get(key);
    if (!rec || rec.reset < now) {
      attempts.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    rec.count += 1;
    if (rec.count > max) {
      return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of attempts) if (rec.reset < now) attempts.delete(key);
}, 10 * 60 * 1000).unref();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ==========================================
// AKUN BAWAAN & KODE AKSES (HANYA AKTIF JIKA DIISI DI ENV)
// ==========================================
function buildPresetAccounts() {
  const defs = [
    { env: 'PRESET_SUPERADMIN_PASSWORD', id: 'preset-superadmin', name: 'Super Admin InfoProperti', username: 'superadmin', email: 'superadmin@infoproperti.web.id', role: 'SUPER_ADMIN' },
    { env: 'PRESET_ADMIN_PASSWORD', id: 'preset-admin', name: 'Admin Operasional InfoProperti', username: 'admin', email: 'admin@infoproperti.web.id', role: 'ADMIN' },
    { env: 'PRESET_AGENT_PASSWORD', id: 'preset-agen', name: 'Agen Mitra InfoProperti', username: 'agen', email: 'agen@infoproperti.web.id', role: 'AGENT' }
  ];
  const accounts = {};
  for (const d of defs) {
    const password = process.env[d.env];
    if (!password) continue;
    accounts[d.email] = {
      id: d.id,
      name: d.name,
      username: d.username,
      email: d.email,
      phone: process.env.PRESET_PHONE || '',
      password,
      role: d.role,
      is_active: true
    };
  }
  return accounts;
}
const PRESET_ACCOUNTS = buildPresetAccounts();

const SUPERADMIN_ACCESS_CODE = process.env.SUPERADMIN_ACCESS_CODE || '';
const ADMIN_ACCESS_CODE = process.env.ADMIN_ACCESS_CODE || '';

function stripPassword(account) {
  const { password: _pw, ...safe } = account;
  return safe;
}

const sanitizeUser = (u) => {
  const { password_hash, ...rest } = u;
  return rest;
};

// ==========================================
// HELPER KIRIM E-RECEIPT KE EMAIL & WHATSAPP
// ==========================================
let mailTransporter = null;
function getTransporter() {
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_APP_PASSWORD }
    });
  }
  return mailTransporter;
}

async function sendDigitalReceipt(order, property, paymentMethod) {
  const shortId = String(order.id).slice(0, 8).toUpperCase();
  const formattedPrice = `Rp ${Number(property?.price || 0).toLocaleString('id-ID')}`;
  const paidTime = new Date().toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Jakarta' });

  if (order.buyer_email && process.env.SMTP_EMAIL && process.env.SMTP_APP_PASSWORD) {
    try {
      const cell = 'padding: 8px; border-bottom: 1px solid #f1f5f9;';
      const htmlReceipt = `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: auto; border: 1px solid #e2e8f0; border-radius: 14px; overflow: hidden;">
          <div style="background: #0F172A; color: #ffffff; padding: 20px 24px;">
            <h2 style="margin: 0; font-size: 18px;">InfoProperti — E-Receipt Resmi</h2>
            <p style="margin: 4px 0 0; font-size: 12px; color: #34d399;">Status: LUNAS (PAID) &amp; UNIT TERKUNCI (BOOKED)</p>
          </div>
          <div style="padding: 24px; color: #1e293b; font-size: 13px; line-height: 1.6;">
            <p>Halo <strong>${escapeHtml(order.buyer_name)}</strong>,</p>
            <p>Pembayaran booking properti Anda telah berhasil dikonfirmasi. Berikut rincian bukti transaksi Anda:</p>
            <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 12px;">
              <tr><td style="${cell} color: #64748b;">ID Transaksi</td><td style="${cell} font-weight: bold;">#${escapeHtml(shortId)}</td></tr>
              <tr><td style="${cell} color: #64748b;">Unit Properti</td><td style="${cell} font-weight: bold;">${escapeHtml(property?.title || '-')} (${escapeHtml(property?.block_or_unit || '-')})</td></tr>
              <tr><td style="${cell} color: #64748b;">Lokasi</td><td style="${cell}">${escapeHtml(property?.location || '-')}</td></tr>
              <tr><td style="${cell} color: #64748b;">NIK Pemesan</td><td style="${cell}">${escapeHtml(maskNik(order.buyer_nik))}</td></tr>
              <tr><td style="${cell} color: #64748b;">Metode Bayar</td><td style="${cell} font-weight: bold;">${escapeHtml(paymentMethod)}</td></tr>
              <tr><td style="${cell} color: #64748b;">Waktu Lunas</td><td style="${cell}">${escapeHtml(paidTime)}</td></tr>
              <tr><td style="padding: 10px 8px; color: #059669; font-weight: bold;">Total Dibayar</td><td style="padding: 10px 8px; color: #059669; font-size: 15px; font-weight: bold;">${escapeHtml(formattedPrice)}</td></tr>
            </table>
            <p style="font-size: 11px; color: #64748b;">Simpan email ini sebagai bukti sah pemesanan unit Anda di InfoProperti (infoproperti.web.id).</p>
          </div>
        </div>
      `;

      await getTransporter().sendMail({
        from: `"InfoProperti Official" <${process.env.SMTP_EMAIL}>`,
        to: order.buyer_email,
        subject: `[LUNAS] Bukti Pembayaran Booking #${shortId} - ${property?.title || 'InfoProperti'}`,
        html: htmlReceipt
      });
      console.log(`E-Receipt terkirim ke email: ${order.buyer_email}`);
    } catch (emailErr) {
      console.error('Gagal kirim email e-receipt:', emailErr.message);
    }
  }

  if (order.buyer_phone && process.env.FONNTE_TOKEN) {
    try {
      const waMessage =
        `*BUKTI PEMBAYARAN LUNAS - INFOPROPERTI*\n\n` +
        `ID Order: *#${shortId}*\n` +
        `Nama: *${order.buyer_name}*\n` +
        `Unit: *${property?.title || '-'}* (${property?.block_or_unit || '-'})\n` +
        `Metode: *${paymentMethod}*\n` +
        `Total Lunas: *${formattedPrice}*\n` +
        `Status Unit: *BOOKED (Terkunci Atas Nama Anda)*\n\n` +
        `Terima kasih telah bertransaksi di InfoProperti.`;

      await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: { Authorization: process.env.FONNTE_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: order.buyer_phone, message: waMessage })
      });
    } catch (waErr) {
      console.error('Gagal kirim WA Gateway:', waErr.message);
    }
  }
}

function maskNik(nik) {
  const s = String(nik || '');
  if (s.length < 8) return s || '-';
  return `${s.slice(0, 4)}${'*'.repeat(s.length - 8)}${s.slice(-4)}`;
}

// ==========================================
// HELPER SINKRONISASI KE GOOGLE SHEETS
// ==========================================
async function syncOrderToGoogleSheet(orderId, eventName = 'SYNC') {
  if (!GOOGLE_SHEET_WEBHOOK) {
    return { skipped: true, reason: 'URL Webhook Google Sheets belum diatur' };
  }

  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select('*, properties(title, category, price, block_or_unit)')
      .eq('id', orderId)
      .single();

    if (error || !order) {
      return { skipped: true, reason: 'Order tidak ditemukan' };
    }

    const payload = {
      event: eventName,
      order_id: order.id,
      property_title: order.properties?.title || 'Unit Properti',
      category: order.properties?.category || '-',
      block_or_unit: order.properties?.block_or_unit || '-',
      price: order.properties?.price || 0,
      buyer_name: order.buyer_name,
      buyer_nik: order.buyer_nik || '-',
      buyer_email: order.buyer_email || '-',
      buyer_phone: order.buyer_phone,
      payment_method: order.payment_method || '-',
      notes: order.notes || '-',
      status: order.status
    };

    const response = await fetch(GOOGLE_SHEET_WEBHOOK, {
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
  } catch (err) {
    console.error('Gagal sync ke Google Sheets:', err.message);
    return { error: err.message };
  }
}

// ==========================================
// 1. ROUTE TES KONEKSI
// ==========================================
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Server InfoProperti & Supabase Berhasil Terhubung!',
    google_sheets_connected: Boolean(GOOGLE_SHEET_WEBHOOK),
    auth_enforced: ENFORCE_AUTH
  });
});

app.get('/health', (req, res) => res.json({ status: 'OK' }));

// ==========================================
// 2. AUTENTIKASI PEMBELI / AGEN / ADMIN / SUPER ADMIN
// ==========================================
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { name, username, email, password, phone, role, nik, ktp_image_url } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nama, email, dan password wajib diisi.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Kata sandi minimal 8 karakter.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ error: 'Format email tidak valid.' });
    }

    const normalizedRole = String(role || 'BUYER').toUpperCase();
    const userRole = normalizedRole === 'AGENT' ? 'AGENT' : 'BUYER';

    if (userRole === 'AGENT') {
      const cleanNik = String(nik || '').trim();
      if (cleanNik.length !== 16) {
        return res.status(400).json({ error: 'Pendaftaran Agen wajib menyertakan NIK KTP 16 digit.' });
      }
      if (!ktp_image_url) {
        return res.status(400).json({ error: 'Pendaftaran Agen wajib mengunggah foto KTP.' });
      }
    }

    const basePayload = {
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      password_hash: await hashPassword(password),
      phone: phone ? String(phone).trim() : '',
      role: userRole,
      is_active: userRole === 'AGENT' ? false : true
    };

    const extraFields = {};
    if (username) extraFields.username = String(username).toLowerCase().trim();
    if (userRole === 'AGENT' && nik) extraFields.nik = String(nik).trim();
    if (userRole === 'AGENT' && ktp_image_url) extraFields.ktp_image_url = ktp_image_url;

    let { data, error } = await supabase
      .from('users')
      .insert([{ ...basePayload, ...extraFields }])
      .select('id, name, email, phone, role, is_active')
      .single();

    // Fallback jika kolom opsional (username/nik/ktp_image_url) belum ada di tabel users
    if (error && (error.code === '42703' || String(error.message || '').includes('column'))) {
      const fallback = await supabase
        .from('users')
        .insert([basePayload])
        .select('id, name, email, phone, role, is_active')
        .single();
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Email atau username sudah terdaftar. Silakan masuk.' });
      }
      throw error;
    }

    res.status(201).json({
      message:
        userRole === 'AGENT'
          ? 'Pendaftaran Agen berhasil dikirim dan menunggu verifikasi KTP oleh Admin/Super Admin.'
          : 'Registrasi akun Pembeli berhasil!',
      user: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, username, identifier, password, access_code } = req.body;

    // Login memakai kode akses (hanya aktif bila kode diisi di environment)
    if (access_code) {
      const code = String(access_code).trim();
      if (SUPERADMIN_ACCESS_CODE && safeEqual(code, SUPERADMIN_ACCESS_CODE) && PRESET_ACCOUNTS['superadmin@infoproperti.web.id']) {
        const user = stripPassword(PRESET_ACCOUNTS['superadmin@infoproperti.web.id']);
        return res.json({ message: 'Login Super Admin Berhasil!', user, token: signToken(user) });
      }
      if (ADMIN_ACCESS_CODE && safeEqual(code, ADMIN_ACCESS_CODE) && PRESET_ACCOUNTS['admin@infoproperti.web.id']) {
        const user = stripPassword(PRESET_ACCOUNTS['admin@infoproperti.web.id']);
        return res.json({ message: 'Login Admin Berhasil!', user, token: signToken(user) });
      }
      return res.status(401).json({ error: 'Kode akses tidak valid.' });
    }

    const loginId = String(email || username || identifier || '').toLowerCase().trim();
    if (!loginId || !password) {
      return res.status(400).json({ error: 'Email/username dan kata sandi wajib diisi.' });
    }

    // Akun bawaan (hanya yang password-nya diisi di environment)
    const presetMatch = Object.values(PRESET_ACCOUNTS).find(
      (acc) => acc.email.toLowerCase() === loginId || acc.username.toLowerCase() === loginId
    );
    if (presetMatch && safeEqual(presetMatch.password, password)) {
      const user = stripPassword(presetMatch);
      return res.json({ message: 'Login berhasil!', user, token: signToken(user) });
    }

    // Cek ke database Supabase berdasarkan email (atau username bila kolom tersedia)
    let { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', loginId)
      .maybeSingle();

    if (!user && !error && !loginId.includes('@')) {
      const byUsername = await supabase.from('users').select('*').eq('username', loginId).maybeSingle();
      if (!byUsername.error) user = byUsername.data;
    }

    if (error || !user) {
      return res.status(401).json({ error: 'Email/username atau kata sandi tidak sesuai.' });
    }

    const check = await verifyPassword(password, user.password_hash);
    if (!check.ok) {
      return res.status(401).json({ error: 'Email/username atau kata sandi tidak sesuai.' });
    }

    if (user.is_active === false) {
      return res.status(403).json({
        error:
          user.role === 'AGENT'
            ? 'Akun Agen Anda masih menunggu verifikasi KTP oleh Admin/Super Admin.'
            : 'Akun Anda sedang dinonaktifkan.'
      });
    }

    // Upgrade otomatis hash lama (SHA-256) ke scrypt
    if (check.legacy) {
      try {
        await supabase.from('users').update({ password_hash: await hashPassword(password) }).eq('id', user.id);
      } catch (e) {
        console.error('Gagal upgrade hash password:', e.message);
      }
    }

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone || '',
      role: user.role || 'BUYER'
    };
    res.json({ message: 'Login berhasil!', user: safeUser, token: signToken(safeUser) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (ENFORCE_AUTH) {
      if (!req.user) return res.status(401).json({ error: 'Anda harus login terlebih dahulu.' });
      const isSelf = String(req.user.id) === String(id);
      const isStaff = ['ADMIN', 'SUPER_ADMIN'].includes(req.user.role);
      if (!isSelf && !isStaff) {
        return res.status(403).json({ error: 'Anda hanya boleh mengubah profil milik sendiri.' });
      }
    }

    const { name, phone } = req.body;
    const updatePayload = { phone: phone ? String(phone).trim() : '' };
    if (name) updatePayload.name = String(name).trim();

    const { data, error } = await supabase
      .from('users')
      .update(updatePayload)
      .eq('id', id)
      .select('id, name, email, phone, role')
      .single();

    if (error) throw error;

    res.json({ message: 'Profil & nomor WhatsApp berhasil diperbarui di database!', user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ENDPOINT SUPER ADMIN (KELOLA ADMIN & AGEN)
// ==========================================
app.get('/api/superadmin/users', requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json((data || []).map(sanitizeUser));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/superadmin/users', requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const { name, username, email, password, phone, role } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Nama, email, kata sandi, dan role wajib diisi.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Kata sandi minimal 8 karakter.' });
    }

    const allowedRoles = ['SUPER_ADMIN', 'ADMIN', 'AGENT', 'BUYER'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ error: 'Role tidak valid.' });
    }

    const payload = {
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      password_hash: await hashPassword(password),
      phone: phone ? String(phone).trim() : '',
      role,
      is_active: true
    };
    if (username) payload.username = String(username).toLowerCase().trim();

    let { data, error } = await supabase
      .from('users')
      .insert([payload])
      .select('id, name, email, phone, role, is_active, created_at')
      .single();

    if (error && (error.code === '42703' || String(error.message || '').includes('column'))) {
      delete payload.username;
      const fallback = await supabase
        .from('users')
        .insert([payload])
        .select('id, name, email, phone, role, is_active, created_at')
        .single();
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Email atau username sudah terdaftar.' });
      }
      throw error;
    }

    res.status(201).json({ message: `Akun ${role} (${data.name}) berhasil dibuat!`, user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/superadmin/users/:id', requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;
    const { role, is_active } = req.body;

    const updateData = {};
    if (role && ['SUPER_ADMIN', 'ADMIN', 'AGENT', 'BUYER'].includes(role)) updateData.role = role;
    if (typeof is_active === 'boolean') updateData.is_active = is_active;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'Tidak ada data yang diubah.' });
    }

    const { data, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', id)
      .select('id, name, email, phone, role, is_active')
      .single();

    if (error) throw error;
    res.json({ message: 'Status / role akun berhasil diperbarui!', user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/superadmin/users/:id', requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('users').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Akun berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/agents', requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('role', 'AGENT')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json((data || []).map(sanitizeUser));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/agents/:id/status', requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    const { data, error } = await supabase
      .from('users')
      .update({ is_active: Boolean(is_active) })
      .eq('id', id)
      .eq('role', 'AGENT')
      .select('id, name, email, phone, role, is_active')
      .single();

    if (error) throw error;

    res.json({
      message: `Status akun agen ${data.name} berhasil diubah menjadi ${data.is_active ? 'AKTIF' : 'NONAKTIF'}.`,
      agent: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. SEED DATA KATALOG PROPERTI (HANYA SUPER ADMIN)
// ==========================================
app.get('/api/seed', requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    if (IS_PROD && !ENFORCE_AUTH) {
      return res.status(403).json({ error: 'Endpoint seed dinonaktifkan di production tanpa ENFORCE_AUTH=true.' });
    }

    const { count, error: countError } = await supabase
      .from('properties')
      .select('*', { count: 'exact', head: true });

    if (countError) throw countError;

    if (count > 0 && req.query.force !== 'true') {
      return res.json({
        message: `Katalog sudah memiliki ${count} properti. Tambahkan ?force=true di URL jika tetap ingin menambah data.`,
        total: count
      });
    }

    const dummyProperties = [
      {
        title: 'Kos Exclusive Soekarno Hatta Malang',
        category: 'kos',
        price: 1500000,
        price_unit: 'bulan',
        block_or_unit: 'Kamar A-01',
        description: 'Kos eksklusif kamar mandi dalam, AC, WiFi kencang, parkir motor luas, 5 menit ke kampus UB & Polinema.',
        specifications: {
          kos_type: 'Campur (Putra & Putri)',
          room_size: '3.5 x 4 Meter',
          bathroom: 'Kamar Mandi Dalam + Water Heater',
          electricity: 'Token Listrik Masing-masing',
          facilities: 'AC, WiFi 100Mbps, Kasur Springbed, Lemari, Meja Belajar, Parkir Motor'
        },
        status: 'AVAILABLE',
        location: 'Jl. Soekarno Hatta No. 45, Kota Malang',
        image_url: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=800&q=80'
      },
      {
        title: 'Rumah Minimalis Modern Araya Batu',
        category: 'rumah',
        price: 45000000,
        price_unit: 'tahun',
        block_or_unit: 'Blok B2 No. 10',
        description: 'Rumah 2 lantai siap huni, 3 kamar tidur, carport mobil, lingkungan aman one-gate system dengan udara sejuk pegunungan.',
        specifications: {
          land_area: '120 m2',
          building_area: '95 m2 (2 Lantai)',
          bedrooms: '3 Kamar Tidur',
          bathrooms: '2 Kamar Mandi',
          utilities: 'Listrik 2200W • Air PDAM',
          legality: 'SHM • Carport 2 Mobil'
        },
        status: 'AVAILABLE',
        location: 'Kawasan Araya, Kota Batu',
        image_url: 'https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&w=800&q=80'
      },
      {
        title: 'Kavling Tanah Siap Bangun Malang City',
        category: 'tanah',
        price: 250000000,
        price_unit: 'unit',
        block_or_unit: 'Kavling K-05',
        description: 'Tanah kavling SHM rata siap bangun, akses jalan paving 6 meter, bebas banjir, dekat kawasan kampus Lowokwaru.',
        specifications: {
          land_area: '120 m2',
          dimensions: '8 x 15 Meter',
          certificate: 'SHM (Sertifikat Hak Milik)',
          zoning: 'Zona Kuning (Perumahan)',
          road_access: 'Jalan Paving 6 Meter (2 Mobil Papasan)'
        },
        status: 'AVAILABLE',
        location: 'Lowokwaru, Kota Malang',
        image_url: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=800&q=80'
      }
    ];

    const { data, error } = await supabase.from('properties').insert(dummyProperties).select();
    if (error) throw error;
    res.json({ message: 'Berhasil menambahkan seed data produk properti!', total: data.length, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. REST API KATALOG PROPERTI (PUBLIK & CMS CRUD)
// ==========================================
app.get('/api/properties', async (req, res) => {
  try {
    const { category, owner_id } = req.query;
    let query = supabase.from('properties').select('*').order('created_at', { ascending: false });

    if (category && category !== 'all') {
      query = query.eq('category', String(category).toLowerCase());
    }
    if (owner_id) {
      query = query.eq('owner_id', String(owner_id));
    }

    const { data, error } = await query;
    if (error) throw error;

    res.set('Cache-Control', 'no-store');
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/properties/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('properties').select('*').eq('id', id).single();

    if (error || !data) {
      return res.status(404).json({ error: 'Properti tidak ditemukan' });
    }

    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(
  '/api/admin/properties',
  requireRole('ADMIN', 'SUPER_ADMIN', 'AGENT'),
  enforcePropertyOwnership,
  async (req, res) => {
    try {
      const {
        title, category, price, price_unit, location,
        block_or_unit, description, specifications, image_url, status,
        owner_id, owner_role
      } = req.body;

      if (!title || !category || !price || !location) {
        return res.status(400).json({ error: 'Judul, kategori, harga, dan lokasi wajib diisi.' });
      }

      const insertPayload = {
        title: String(title).trim(),
        category: String(category).toLowerCase(),
        price: Number(price),
        price_unit: price_unit || 'bulan',
        location: String(location).trim(),
        block_or_unit: block_or_unit ? String(block_or_unit).trim() : '-',
        description: description ? String(description).trim() : 'Fasilitas lengkap, lokasi strategis, dan siap huni.',
        specifications: specifications && typeof specifications === 'object' ? specifications : {},
        status: status || 'AVAILABLE',
        image_url:
          image_url && String(image_url).trim() !== ''
            ? String(image_url).trim()
            : 'https://images.unsplash.com/photo-1560518883-ce09059eeffa?auto=format&fit=crop&w=800&q=80'
      };

      if (owner_id) insertPayload.owner_id = owner_id;
      if (owner_role) insertPayload.owner_role = owner_role;

      const { data, error } = await supabase.from('properties').insert([insertPayload]).select().single();
      if (error) throw error;

      res.status(201).json({ message: 'Unit properti berhasil diposting ke katalog publik!', property: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.put(
  '/api/admin/properties/:id',
  requireRole('ADMIN', 'SUPER_ADMIN', 'AGENT'),
  enforcePropertyOwnership,
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        title, category, price, price_unit, location,
        block_or_unit, description, specifications, image_url, status,
        owner_id, owner_role
      } = req.body;

      const updatePayload = {};
      if (title !== undefined) updatePayload.title = String(title).trim();
      if (category !== undefined) updatePayload.category = String(category).toLowerCase();
      if (price !== undefined) updatePayload.price = Number(price);
      if (price_unit !== undefined) updatePayload.price_unit = price_unit;
      if (location !== undefined) updatePayload.location = String(location).trim();
      if (block_or_unit !== undefined) updatePayload.block_or_unit = String(block_or_unit).trim();
      if (description !== undefined) updatePayload.description = String(description).trim();
      if (specifications !== undefined) updatePayload.specifications = specifications;
      if (image_url !== undefined) updatePayload.image_url = String(image_url).trim();
      if (status !== undefined) updatePayload.status = status;
      if (owner_id !== undefined) updatePayload.owner_id = owner_id;
      if (owner_role !== undefined) updatePayload.owner_role = owner_role;

      const { data, error } = await supabase.from('properties').update(updatePayload).eq('id', id).select().single();
      if (error) throw error;

      res.json({ message: 'Data properti berhasil diperbarui!', property: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.delete(
  '/api/admin/properties/:id',
  requireRole('ADMIN', 'SUPER_ADMIN', 'AGENT'),
  enforcePropertyOwnership,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { error } = await supabase.from('properties').delete().eq('id', id);
      if (error) throw error;
      res.json({ message: 'Unit properti berhasil dihapus dari katalog.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ==========================================
// 5. ENGINE BOOKING (KYC KTP + EMAIL), LACAK & PEMBAYARAN
// ==========================================
app.post('/api/orders', async (req, res) => {
  try {
    const { property_id, buyer_name, buyer_nik, buyer_email, buyer_phone, ktp_image_url, notes } = req.body;

    if (!property_id || !buyer_name || !buyer_phone || !buyer_nik) {
      return res.status(400).json({
        error: 'Data tidak lengkap. Nama sesuai KTP, NIK (16 digit), nomor WhatsApp, dan ID properti wajib diisi.'
      });
    }

    if (!/^\d{16}$/.test(String(buyer_nik).trim())) {
      return res.status(400).json({ error: 'Nomor Induk Kependudukan (NIK) harus terdiri dari 16 digit angka.' });
    }

    const { data: propCheck } = await supabase
      .from('properties')
      .select('status')
      .eq('id', property_id)
      .single();

    if (!propCheck) {
      return res.status(404).json({ error: 'Properti tidak ditemukan.' });
    }

    if (propCheck.status === 'BOOKED') {
      return res.status(409).json({ error: 'Maaf, unit properti ini baru saja terkunci (BOOKED) oleh pembeli lain.' });
    }

    const { data, error } = await supabase
      .from('orders')
      .insert([
        {
          property_id,
          buyer_name: String(buyer_name).trim(),
          buyer_nik: String(buyer_nik).trim(),
          buyer_email: buyer_email ? String(buyer_email).toLowerCase().trim() : null,
          buyer_phone: String(buyer_phone).trim(),
          ktp_image_url: ktp_image_url || null,
          notes: notes ? String(notes).trim() : '-',
          status: 'PENDING_VERIFICATION'
        }
      ])
      .select()
      .single();

    if (error) throw error;

    // Jalankan di latar belakang agar respons ke pembeli tidak menunggu Google Sheets
    syncOrderToGoogleSheet(data.id, 'NEW_BOOKING_KYC').catch(() => {});

    res.status(201).json({
      message: 'Pengajuan booking & data KTP berhasil dikirim. Menunggu verifikasi penjual.',
      order: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const TRACK_FIELDS =
  'id, status, buyer_name, buyer_phone, created_at, properties(title, category, price, price_unit, block_or_unit)';

app.get('/api/orders/track', async (req, res) => {
  try {
    const { query, ids } = req.query;

    if (ids) {
      const idList = String(ids)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => UUID_RE.test(s))
        .slice(0, 50);
      if (idList.length === 0) return res.json([]);

      const { data, error } = await supabase
        .from('orders')
        .select(TRACK_FIELDS)
        .in('id', idList)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return res.json(data || []);
    }

    if (query) {
      // Hanya angka dan tanda + (nomor telepon / NIK). Mencegah injeksi filter PostgREST.
      const clean = String(query).trim().replace(/[^0-9+]/g, '');
      if (clean.length < 6) return res.json([]);

      const [byPhone, byNik] = await Promise.all([
        supabase.from('orders').select(TRACK_FIELDS).eq('buyer_phone', clean).order('created_at', { ascending: false }),
        supabase.from('orders').select(TRACK_FIELDS).eq('buyer_nik', clean).order('created_at', { ascending: false })
      ]);

      if (byPhone.error) throw byPhone.error;
      if (byNik.error) throw byNik.error;

      const merged = new Map();
      [...(byPhone.data || []), ...(byNik.data || [])].forEach((o) => merged.set(o.id, o));
      const result = [...merged.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return res.json(result);
    }

    res.json([]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    }

    const { data, error } = await supabase
      .from('orders')
      .select('*, properties(title, category, price, price_unit, location, block_or_unit, image_url)')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    }

    res.json({ ...data, total_price: data.total_price || data.properties?.price || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/orders/:id/pay', async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_method } = req.body;
    const chosenMethod = payment_method || 'QRIS_INSTAN';

    const { data: existingOrder, error: fetchError } = await supabase
      .from('orders')
      .select('*, properties(title, category, price, price_unit, location, block_or_unit)')
      .eq('id', id)
      .single();

    if (fetchError || !existingOrder) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
    }

    if (existingOrder.status !== 'APPROVED') {
      return res.status(400).json({
        error: 'Pembayaran hanya dapat dilakukan setelah pesanan disetujui (APPROVED) oleh penjual.'
      });
    }

    const { data, error } = await supabase
      .from('orders')
      .update({ status: 'PAID', payment_method: chosenMethod })
      .eq('id', id)
      .eq('status', 'APPROVED') // cegah pembayaran ganda
      .select()
      .single();

    if (error) throw error;

    if (existingOrder.property_id) {
      await supabase.from('properties').update({ status: 'BOOKED' }).eq('id', existingOrder.property_id);
    }

    await supabase.from('payments').insert([
      {
        order_id: id,
        amount: existingOrder.properties?.price || 0,
        payment_method: chosenMethod,
        status: 'PAID'
      }
    ]);

    await sendDigitalReceipt(data, existingOrder.properties, chosenMethod);
    await syncOrderToGoogleSheet(id, 'PAYMENT_PAID');

    res.json({
      message: 'Pembayaran berhasil dikonfirmasi! Struk resmi telah dikirim ke Email & WhatsApp Anda.',
      order: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. DASHBOARD & VERIFIKASI CMS PENJUAL
// ==========================================
app.get('/api/admin/orders', requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*, properties(title, category, price, price_unit, block_or_unit)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/orders/:id/verify', requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, action, note } = req.body;

    let newStatus = status;
    if (!newStatus && action) {
      newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
    }

    const allowedStatuses = ['APPROVED', 'REJECTED', 'PENDING_VERIFICATION', 'PAID'];
    if (!allowedStatuses.includes(newStatus)) {
      return res.status(400).json({ error: 'Status verifikasi tidak valid.' });
    }

    const { data, error } = await supabase.from('orders').update({ status: newStatus }).eq('id', id).select().single();
    if (error) throw error;

    if (newStatus === 'APPROVED' || newStatus === 'REJECTED') {
      await supabase.from('verification_logs').insert([
        {
          order_id: id,
          action: newStatus,
          note: note || (newStatus === 'APPROVED' ? 'KTP valid & unit tersedia, disetujui penjual' : 'Ditolak oleh penjual')
        }
      ]);
    }

    await syncOrderToGoogleSheet(id, `VERIFIED_${newStatus}`);

    res.json({
      message: `Pesanan #${String(id).slice(0, 8)} berhasil diubah statusnya menjadi ${newStatus}`,
      order: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/sync-sheets', requireRole('ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  try {
    if (!GOOGLE_SHEET_WEBHOOK) {
      return res.status(400).json({ error: 'URL Webhook Google Sheets belum diatur.' });
    }

    const { data: allOrders, error } = await supabase
      .from('orders')
      .select('id')
      .order('created_at', { ascending: true });

    if (error) throw error;

    for (const item of allOrders) {
      await syncOrderToGoogleSheet(item.id, 'BULK_SYNC');
    }

    res.json({
      message: `Berhasil menyinkronkan ${allOrders.length} data pesanan ke Google Sheets!`,
      total: allOrders.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// PENANGANAN ERROR UMUM
// ==========================================
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
});

app.use((err, req, res, next) => {
  if (err && err.message === 'Origin tidak diizinkan oleh CORS') {
    return res.status(403).json({ error: err.message });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Ukuran data terlalu besar.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
});

app.listen(PORT, () => {
  console.log(`Backend InfoProperti running di port ${PORT} (auth enforced: ${ENFORCE_AUTH})`);
});