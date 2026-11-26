import type { APIRoute } from 'astro';
import { checkRole, getSupabase, jsonRes } from '../../../../lib/apiServer';

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const denied = checkRole(request, locals, 'SUPER_ADMIN');
  if (denied) return denied;

  try {
    const id = params.id;
    if (!id) return jsonRes({ error: 'ID pengguna tidak valid.' }, 400);

    const body = await request.json();
    const { role, is_active } = body || {};

    const updateData: Record<string, any> = {};
    if (role && ['SUPER_ADMIN', 'ADMIN', 'AGENT', 'BUYER'].includes(role)) {
      updateData.role = role;
    }
    if (typeof is_active === 'boolean') {
      updateData.is_active = is_active;
    }

    if (Object.keys(updateData).length === 0) {
      return jsonRes({ error: 'Tidak ada data yang diubah.' }, 400);
    }

    const supabase = getSupabase(locals);
    const { data, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', id)
      .select('id, name, email, phone, role, is_active')
      .single();

    if (error) throw error;
    return jsonRes({ message: 'Status / role akun berhasil diperbarui!', user: data }, 200);
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal memperbarui akun.' }, 500);
  }
};

export const DELETE: APIRoute = async ({ params, locals, request }) => {
  const denied = checkRole(request, locals, 'SUPER_ADMIN');
  if (denied) return denied;

  try {
    const id = params.id;
    if (!id) return jsonRes({ error: 'ID pengguna tidak valid.' }, 400);

    const supabase = getSupabase(locals);
    const { error } = await supabase.from('users').delete().eq('id', id);
    if (error) throw error;

    return jsonRes({ message: 'Akun berhasil dihapus.' }, 200);
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal menghapus akun.' }, 500);
  }
};