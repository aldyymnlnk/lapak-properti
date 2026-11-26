import type { APIRoute } from 'astro';
import { checkRole, getEnv, getSupabase, jsonRes, syncOrderToGoogleSheet } from '../../../lib/apiServer';

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = checkRole(request, locals, 'ADMIN', 'SUPER_ADMIN');
  if (denied) return denied;

  try {
    const env = getEnv(locals);
    if (!env.GOOGLE_SHEET_WEBHOOK_URL) {
      return jsonRes({ error: 'URL Webhook Google Sheets belum diatur.' }, 400);
    }

    const supabase = getSupabase(locals);
    const { data: allOrders, error } = await supabase
      .from('orders')
      .select('id')
      .order('created_at', { ascending: true });

    if (error) throw error;

    const list = allOrders || [];
    for (const item of list) {
      await syncOrderToGoogleSheet(item.id, 'BULK_SYNC', locals);
    }

    return jsonRes(
      {
        message: `Berhasil menyinkronkan ${list.length} data pesanan ke Google Sheets!`,
        total: list.length
      },
      200
    );
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal menyinkronkan ke Google Sheets.' }, 500);
  }
};