import type { APIRoute } from 'astro';
import { checkRole, getSupabase, jsonRes, syncOrderToGoogleSheet, UUID_RE } from '../../../../../lib/apiServer';

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const denied = checkRole(request, locals, 'ADMIN', 'SUPER_ADMIN');
  if (denied) return denied;

  try {
    const id = params.id;
    if (!id || !UUID_RE.test(id)) {
      return jsonRes({ error: 'ID pesanan tidak valid.' }, 400);
    }

    const body = await request.json();
    const { status, action, note } = body || {};

    let newStatus = status;
    if (!newStatus && action) {
      newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
    }

    const allowedStatuses = ['APPROVED', 'REJECTED', 'PENDING_VERIFICATION', 'PAID'];
    if (!allowedStatuses.includes(newStatus)) {
      return jsonRes({ error: 'Status verifikasi tidak valid.' }, 400);
    }

    const supabase = getSupabase(locals);
    const { data, error } = await supabase
      .from('orders')
      .update({ status: newStatus })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    if (newStatus === 'APPROVED' || newStatus === 'REJECTED') {
      await supabase.from('verification_logs').insert([
        {
          order_id: id,
          action: newStatus,
          note:
            note ||
            (newStatus === 'APPROVED'
              ? 'KTP valid & unit tersedia, disetujui penjual'
              : 'Ditolak oleh penjual')
        }
      ]);
    }

    await syncOrderToGoogleSheet(id, `VERIFIED_${newStatus}`, locals);

    return jsonRes(
      {
        message: `Pesanan #${String(id).slice(0, 8)} berhasil diubah statusnya menjadi ${newStatus}`,
        order: data
      },
      200
    );
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal memverifikasi pesanan.' }, 500);
  }
};