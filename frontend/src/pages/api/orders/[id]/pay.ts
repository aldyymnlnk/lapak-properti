import type { APIRoute } from 'astro';
import {
  getSupabase,
  jsonRes,
  sendWhatsAppReceipt,
  syncOrderToGoogleSheet,
  UUID_RE
} from '../../../../lib/apiServer';

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  try {
    const id = params.id;
    if (!id || !UUID_RE.test(id)) {
      return jsonRes({ error: 'Pesanan tidak ditemukan' }, 404);
    }

    const body = await request.json().catch(() => ({}));
    const chosenMethod = body?.payment_method || 'QRIS_INSTAN';

    const supabase = getSupabase(locals);
    const { data: existingOrder, error: fetchError } = await supabase
      .from('orders')
      .select('*, properties(title, category, price, price_unit, location, block_or_unit)')
      .eq('id', id)
      .single();

    if (fetchError || !existingOrder) {
      return jsonRes({ error: 'Pesanan tidak ditemukan' }, 404);
    }

    if (existingOrder.status !== 'APPROVED') {
      return jsonRes(
        {
          error: 'Pembayaran hanya dapat dilakukan setelah pesanan disetujui (APPROVED) oleh penjual.'
        },
        400
      );
    }

    const { data, error } = await supabase
      .from('orders')
      .update({ status: 'PAID', payment_method: chosenMethod })
      .eq('id', id)
      .eq('status', 'APPROVED')
      .select()
      .single();

    if (error) throw error;

    const prop = Array.isArray(existingOrder.properties)
      ? existingOrder.properties[0]
      : existingOrder.properties;

    if (existingOrder.property_id) {
      await supabase.from('properties').update({ status: 'BOOKED' }).eq('id', existingOrder.property_id);
    }

    await supabase.from('payments').insert([
      {
        order_id: id,
        amount: prop?.price || 0,
        payment_method: chosenMethod,
        status: 'PAID'
      }
    ]);

    await sendWhatsAppReceipt(data, prop, chosenMethod, locals);
    await syncOrderToGoogleSheet(id, 'PAYMENT_PAID', locals);

    return jsonRes(
      {
        message: 'Pembayaran berhasil dikonfirmasi! Bukti transaksi telah diperbarui.',
        order: data
      },
      200
    );
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal memproses pembayaran.' }, 500);
  }
};