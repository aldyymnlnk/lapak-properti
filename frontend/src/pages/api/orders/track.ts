import type { APIRoute } from 'astro';
import { getSupabase, jsonRes, UUID_RE } from '../../../lib/apiServer';

const TRACK_FIELDS =
  'id, status, buyer_name, buyer_phone, created_at, properties(title, category, price, price_unit, block_or_unit)';

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const supabase = getSupabase(locals);
    const idsParam = url.searchParams.get('ids');
    const queryParam = url.searchParams.get('query');

    if (idsParam) {
      const idList = String(idsParam)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => UUID_RE.test(s))
        .slice(0, 50);

      if (idList.length === 0) return jsonRes([], 200);

      const { data, error } = await supabase
        .from('orders')
        .select(TRACK_FIELDS)
        .in('id', idList)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return jsonRes(data || [], 200);
    }

    if (queryParam) {
      const clean = String(queryParam).trim().replace(/[^0-9+]/g, '');
      if (clean.length < 6) return jsonRes([], 200);

      const [byPhone, byNik] = await Promise.all([
        supabase.from('orders').select(TRACK_FIELDS).eq('buyer_phone', clean).order('created_at', { ascending: false }),
        supabase.from('orders').select(TRACK_FIELDS).eq('buyer_nik', clean).order('created_at', { ascending: false })
      ]);

      if (byPhone.error) throw byPhone.error;
      if (byNik.error) throw byNik.error;

      const merged = new Map<string, any>();
      [...(byPhone.data || []), ...(byNik.data || [])].forEach((o) => merged.set(o.id, o));
      const result = [...merged.values()].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      return jsonRes(result, 200);
    }

    return jsonRes([], 200);
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal melacak pesanan.' }, 500);
  }
};