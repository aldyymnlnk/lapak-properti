import type { APIRoute } from 'astro';
import { checkRole, getSupabase, jsonRes } from '../../../../../lib/apiServer';

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const denied = checkRole(request, locals, 'ADMIN', 'SUPER_ADMIN');
  if (denied) return denied;

  try {
    const id = params.id;
    if (!id) return jsonRes({ error: 'ID agen tidak valid.' }, 400);

    const body = await request.json();
    const { is_active } = body || {};

    const supabase = getSupabase(locals);
    const { data, error } = await supabase
      .from('users')
      .update({ is_active: Boolean(is_active) })
      .eq('id', id)
      .eq('role', 'AGENT')
      .select('id, name, email, phone, role, is_active')
      .single();

    if (error) throw error;

    return jsonRes(
      {
        message: `Status akun agen ${data.name} berhasil diubah menjadi ${data.is_active ? 'AKTIF' : 'NONAKTIF'}.`,
        agent: data
      },
      200
    );
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal memperbarui status agen.' }, 500);
  }
};