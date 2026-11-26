import type { APIRoute } from 'astro';
import { getSupabase, jsonRes, UUID_RE } from '../../../lib/apiServer';

export const GET: APIRoute = async ({ params, locals }) => {
  try {
    const id = params.id;
    if (!id || !UUID_RE.test(id)) {
      return jsonRes({ error: 'Pesanan tidak ditemukan' }, 404);
    }

    const supabase = getSupabase(locals);
    const { data, error } = await supabase
      .from('orders')
      .select('*, properties(title, category, price, price_unit, location, block_or_unit, image_url)')
      .eq('id', id)
      .single();

    if (error || !data) {
      return jsonRes({ error: 'Pesanan tidak ditemukan' }, 404);
    }

    const prop = Array.isArray(data.properties) ? data.properties[0] : data.properties;
    return jsonRes({ ...data, total_price: data.total_price || prop?.price || 0 }, 200);
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal memuat detail pesanan.' }, 500);
  }
};