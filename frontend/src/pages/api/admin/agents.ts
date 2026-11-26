import type { APIRoute } from 'astro';
import { checkRole, getSupabase, jsonRes, sanitizeUser } from '../../../lib/apiServer';

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = checkRole(request, locals, 'ADMIN', 'SUPER_ADMIN');
  if (denied) return denied;

  try {
    const supabase = getSupabase(locals);
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('role', 'AGENT')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return jsonRes((data || []).map(sanitizeUser), 200);
  } catch (err: any) {
    return jsonRes({ error: err?.message || 'Gagal memuat daftar agen.' }, 500);
  }
};