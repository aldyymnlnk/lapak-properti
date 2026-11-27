import type { APIRoute } from 'astro';
import {
  buildPresetAccounts,
  getEnv,
  getSupabase,
  hashPassword,
  jsonRes,
  safeEqual,
  signToken,
  verifyPassword
} from '../../../lib/apiServer';

type AccessRole = 'SUPER_ADMIN' | 'ADMIN' | 'AGENT';

const ACCESS_USERS: Record<AccessRole, { id: string; name: string; username: string; email: string }> = {
  SUPER_ADMIN: {
    id: 'preset-superadmin',
    name: 'Super Admin InfoProperti',
    username: 'superadmin',
    email: 'superadmin@infoproperti.web.id'
  },
  ADMIN: {
    id: 'preset-admin',
    name: 'Admin Operasional InfoProperti',
    username: 'admin',
    email: 'admin@infoproperti.web.id'
  },
  AGENT: {
    id: 'preset-agen',
    name: 'Agen Mitra InfoProperti',
    username: 'agen',
    email: 'agen@infoproperti.web.id'
  }
};

/**
 * Akun untuk login kode akses. Kalau PRESET_*_PASSWORD diisi, pakai akun preset itu.
 * Kalau tidak, dibuat akun bawaan, jadi cukup *_ACCESS_CODE saja yang perlu diisi.
 */
function buildAccessUser(role: AccessRole, presetAccounts: Record<string, any>, env: Record<string, string | undefined>) {
  const base = ACCESS_USERS[role];
  const preset = presetAccounts[base.email];
  if (preset) {
    const { password: _pw, ...rest } = preset;
    return rest;
  }
  return { ...base, phone: env.PRESET_PHONE || '', role, is_active: true };
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const { email, username, identifier, password, access_code } = body || {};
    const env = getEnv(locals);
    const presetAccounts = buildPresetAccounts(locals);

    // ---------- LOGIN DENGAN KODE AKSES (Super Admin / Admin / Agen) ----------
    if (access_code) {
      const code = String(access_code).trim();
      const checks: Array<{ role: AccessRole; expected: string; message: string }> = [
        { role: 'SUPER_ADMIN', expected: env.SUPERADMIN_ACCESS_CODE || '', message: 'Login Super Admin Berhasil!' },
        { role: 'ADMIN', expected: env.ADMIN_ACCESS_CODE || '', message: 'Login Admin Berhasil!' },
        { role: 'AGENT', expected: env.AGENT_ACCESS_CODE || '', message: 'Login Agen Berhasil!' }
      ];

      for (const check of checks) {
        if (check.expected && safeEqual(code, check.expected)) {
          const user = buildAccessUser(check.role, presetAccounts, env);
          return jsonRes({ message: check.message, user, token: signToken(user, locals) }, 200);
        }
      }
      return jsonRes({ error: 'Kode akses tidak valid.' }, 401);
    }

    // ---------- LOGIN EMAIL/USERNAME + PASSWORD ----------
    const loginId = String(email || username || identifier || '').toLowerCase().trim();
    if (!loginId || !password) {
      return jsonRes({ error: 'Email/username dan kata sandi wajib diisi.' }, 400);
    }

    const presetMatch = Object.values(presetAccounts).find(
      (acc: any) => acc.email.toLowerCase() === loginId || acc.username.toLowerCase() === loginId
    );
    if (presetMatch && safeEqual(presetMatch.password, password)) {
      const { password: _pw, ...user } = presetMatch;
      return jsonRes({ message: 'Login berhasil!', user, token: signToken(user, locals) }, 200);
    }

    const supabase = getSupabase(locals);
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
      return jsonRes({ error: 'Email/username atau kata sandi tidak sesuai.' }, 401);
    }

    const check = await verifyPassword(password, user.password_hash);
    if (!check.ok) {
      return jsonRes({ error: 'Email/username atau kata sandi tidak sesuai.' }, 401);
    }

    if (user.is_active === false) {
      return jsonRes(
        {
          error:
            user.role === 'AGENT'
              ? 'Akun Agen Anda masih menunggu verifikasi KTP oleh Admin/Super Admin.'
              : 'Akun Anda sedang dinonaktifkan.'
        },
        403
      );
    }

    if (check.legacy) {
      try {
        await supabase.from('users').update({ password_hash: await hashPassword(password) }).eq('id', user.id);
      } catch (e) {
        console.error('Gagal upgrade hash password:', e);
      }
    }

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone || '',
      role: user.role || 'BUYER'
    };
    return jsonRes({ message: 'Login berhasil!', user: safeUser, token: signToken(safeUser, locals) }, 200);
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal melakukan login.' }, 500);
  }
};