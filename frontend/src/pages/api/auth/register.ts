import type { APIRoute } from 'astro';
import { getSupabase, hashPassword, jsonRes } from '../../../lib/apiServer';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const { name, username, email, password, phone, role, nik, ktp_image_url } = body || {};

    if (!name || !email || !password) {
      return jsonRes({ error: 'Nama, email, dan password wajib diisi.' }, 400);
    }
    if (String(password).length < 8) {
      return jsonRes({ error: 'Kata sandi minimal 8 karakter.' }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return jsonRes({ error: 'Format email tidak valid.' }, 400);
    }

    const normalizedRole = String(role || 'BUYER').toUpperCase();
    const userRole = normalizedRole === 'AGENT' ? 'AGENT' : 'BUYER';

    if (userRole === 'AGENT') {
      const cleanNik = String(nik || '').trim();
      if (cleanNik.length !== 16) {
        return jsonRes({ error: 'Pendaftaran Agen wajib menyertakan NIK KTP 16 digit.' }, 400);
      }
      if (!ktp_image_url) {
        return jsonRes({ error: 'Pendaftaran Agen wajib mengunggah foto KTP.' }, 400);
      }
    }

    const basePayload: Record<string, any> = {
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      password_hash: await hashPassword(password),
      phone: phone ? String(phone).trim() : '',
      role: userRole,
      is_active: userRole === 'AGENT' ? false : true
    };

    const extraFields: Record<string, any> = {};
    if (username) extraFields.username = String(username).toLowerCase().trim();
    if (userRole === 'AGENT' && nik) extraFields.nik = String(nik).trim();
    if (userRole === 'AGENT' && ktp_image_url) extraFields.ktp_image_url = ktp_image_url;

    const supabase = getSupabase(locals);
    let { data, error } = await supabase
      .from('users')
      .insert([{ ...basePayload, ...extraFields }])
      .select('id, name, email, phone, role, is_active')
      .single();

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
        return jsonRes({ error: 'Email atau username sudah terdaftar. Silakan masuk.' }, 409);
      }
      throw error;
    }

    return jsonRes(
      {
        message:
          userRole === 'AGENT'
            ? 'Pendaftaran Agen berhasil dikirim dan menunggu verifikasi KTP oleh Admin/Super Admin.'
            : 'Registrasi akun Pembeli berhasil!',
        user: data
      },
      201
    );
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal mendaftar akun.' }, 500);
  }
};