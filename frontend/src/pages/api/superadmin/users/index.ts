import type { APIRoute } from 'astro';
import { checkRole, getSupabase, hashPassword, jsonRes, sanitizeUser } from '../../../../lib/apiServer';

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = checkRole(request, locals, 'SUPER_ADMIN');
  if (denied) return denied;

  try {
    const supabase = getSupabase(locals);
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return jsonRes((data || []).map(sanitizeUser), 200);
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal memuat daftar pengguna.' }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = checkRole(request, locals, 'SUPER_ADMIN');
  if (denied) return denied;

  try {
    const body = await request.json();
    const { name, username, email, password, phone, role } = body || {};

    if (!name || !email || !password || !role) {
      return jsonRes({ error: 'Nama, email, kata sandi, dan role wajib diisi.' }, 400);
    }
    if (String(password).length < 8) {
      return jsonRes({ error: 'Kata sandi minimal 8 karakter.' }, 400);
    }

    const allowedRoles = ['SUPER_ADMIN', 'ADMIN', 'AGENT', 'BUYER'];
    if (!allowedRoles.includes(role)) {
      return jsonRes({ error: 'Role tidak valid.' }, 400);
    }

    const payload: Record<string, any> = {
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      password_hash: await hashPassword(password),
      phone: phone ? String(phone).trim() : '',
      role,
      is_active: true
    };
    if (username) payload.username = String(username).toLowerCase().trim();

    const supabase = getSupabase(locals);
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
        return jsonRes({ error: 'Email atau username sudah terdaftar.' }, 409);
      }
      throw error;
    }

    return jsonRes({ message: `Akun ${role} (${data.name}) berhasil dibuat!`, user: data }, 201);
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal membuat akun pengguna.' }, 500);
  }
};