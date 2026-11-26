import type { APIRoute } from 'astro';
import { checkRole, getSupabase, jsonRes } from '../../../lib/apiServer';

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = checkRole(request, locals, 'ADMIN', 'SUPER_ADMIN');
  if (denied) return denied;

  try {
    const supabase = getSupabase(locals);
    const { data, error } = await supabase
      .from('orders')
      .select('*, properties(title, category, price, price_unit, block_or_unit)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return jsonRes(data || [], 200);
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal memuat daftar pesanan.' }, 500);
  }
};