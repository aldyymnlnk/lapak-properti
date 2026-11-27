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

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const { email, username, identifier, password, access_code } = body || {};
    const env = getEnv(locals);
    const presetAccounts = buildPresetAccounts(locals);
    const superAdminCode = env.SUPERADMIN_ACCESS_CODE || '';
    const adminCode = env.ADMIN_ACCESS_CODE || '';
    const agentCode = env.AGENT_ACCESS_CODE || '';

    if (access_code) {
      const code = String(access_code).trim();
      if (superAdminCode && safeEqual(code, superAdminCode) && presetAccounts['superadmin@infoproperti.web.id']) {
        const { password: _pw, ...user } = presetAccounts['superadmin@infoproperti.web.id'];
        return jsonRes({ message: 'Login Super Admin Berhasil!', user, token: signToken(user, locals) }, 200);
      }
      if (adminCode && safeEqual(code, adminCode) && presetAccounts['admin@infoproperti.web.id']) {
        const { password: _pw, ...user } = presetAccounts['admin@infoproperti.web.id'];
        return jsonRes({ message: 'Login Admin Berhasil!', user, token: signToken(user, locals) }, 200);
      }
      if (agentCode && safeEqual(code, agentCode)) {
        // Akun agen preset: tidak butuh PRESET_AGENT_PASSWORD, cukup AGENT_ACCESS_CODE.
        const preset = presetAccounts['agen@infoproperti.web.id'];
        const agentUser = preset
          ? (({ password: _pw, ...rest }) => rest)(preset)
          : {
              id: 'preset-agen',
              name: 'Agen Mitra InfoProperti',
              username: 'agen',
              email: 'agen@infoproperti.web.id',
              phone: env.PRESET_PHONE || '',
              role: 'AGENT',
              is_active: true
            };
        return jsonRes({ message: 'Login Agen Berhasil!', user: agentUser, token: signToken(agentUser, locals) }, 200);
      }
      return jsonRes({ error: 'Kode akses tidak valid.' }, 401);
    }

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