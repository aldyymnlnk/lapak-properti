import type { APIRoute } from 'astro';
import { getSupabase, jsonRes, syncOrderToGoogleSheet } from '../../../lib/apiServer';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const { property_id, buyer_name, buyer_nik, buyer_email, buyer_phone, ktp_image_url, notes } = body || {};

    if (!property_id || !buyer_name || !buyer_phone || !buyer_nik) {
      return jsonRes(
        {
          error: 'Data tidak lengkap. Nama sesuai KTP, NIK (16 digit), nomor WhatsApp, dan ID properti wajib diisi.'
        },
        400
      );
    }

    if (!/^\d{16}$/.test(String(buyer_nik).trim())) {
      return jsonRes({ error: 'Nomor Induk Kependudukan (NIK) harus terdiri dari 16 digit angka.' }, 400);
    }

    const supabase = getSupabase(locals);
    const { data: propCheck } = await supabase
      .from('properties')
      .select('status')
      .eq('id', property_id)
      .single();

    if (!propCheck) {
      return jsonRes({ error: 'Properti tidak ditemukan.' }, 404);
    }

    if (propCheck.status === 'BOOKED') {
      return jsonRes({ error: 'Maaf, unit properti ini baru saja terkunci (BOOKED) oleh pembeli lain.' }, 409);
    }

    const { data, error } = await supabase
      .from('orders')
      .insert([
        {
          property_id,
          buyer_name: String(buyer_name).trim(),
          buyer_nik: String(buyer_nik).trim(),
          buyer_email: buyer_email ? String(buyer_email).toLowerCase().trim() : null,
          buyer_phone: String(buyer_phone).trim(),
          ktp_image_url: ktp_image_url || null,
          notes: notes ? String(notes).trim() : '-',
          status: 'PENDING_VERIFICATION'
        }
      ])
      .select()
      .single();

    if (error) throw error;

    syncOrderToGoogleSheet(data.id, 'NEW_BOOKING_KYC', locals).catch(() => {});

    return jsonRes(
      {
        message: 'Pengajuan booking & data KTP berhasil dikirim. Menunggu verifikasi penjual.',
        order: data
      },
      201
    );
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal mengirim pengajuan booking.' }, 500);
  }
};