import type { APIRoute } from 'astro';
import { getAuthUser, getSupabase, isEnforceAuth, jsonRes } from '../../../lib/apiServer';

export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    const id = params.id;
    if (!id) return jsonRes({ error: 'ID user tidak valid.' }, 400);

    if (isEnforceAuth(locals)) {
      const authUser = getAuthUser(request, locals);
      if (!authUser) return jsonRes({ error: 'Anda harus login terlebih dahulu.' }, 401);
      const isSelf = String(authUser.id) === String(id);
      const isStaff = ['ADMIN', 'SUPER_ADMIN'].includes(authUser.role);
      if (!isSelf && !isStaff) {
        return jsonRes({ error: 'Anda hanya boleh mengubah profil milik sendiri.' }, 403);
      }
    }

    const body = await request.json();
    const { name, phone } = body || {};
    const updatePayload: Record<string, any> = { phone: phone ? String(phone).trim() : '' };
    if (name) updatePayload.name = String(name).trim();

    const supabase = getSupabase(locals);
    const { data, error } = await supabase
      .from('users')
      .update(updatePayload)
      .eq('id', id)
      .select('id, name, email, phone, role')
      .single();

    if (error) throw error;

    return jsonRes({ message: 'Profil & nomor WhatsApp berhasil diperbarui di database!', user: data }, 200);
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal memperbarui profil.' }, 500);
  }
};