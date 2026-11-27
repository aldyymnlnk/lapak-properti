import { getSupabase } from './apiServer';

/**
 * Ambil semua properti langsung dari Supabase (dipakai di frontmatter halaman .astro).
 *
 * Kenapa tidak fetch('/api/properties')? Di server (SSR) URL relatif tidak valid,
 * jadi fetch gagal dan halaman jatuh ke data demo / daftar kosong.
 * Query langsung ke Supabase sama seperti yang sudah dilakukan property/[id].astro.
 */
export async function getAllProperties(locals?: any): Promise<any[]> {
  try {
    const supabase = getSupabase(locals);

    const sorted = await supabase
      .from('properties')
      .select('*')
      .order('created_at', { ascending: false });

    if (!sorted.error && Array.isArray(sorted.data)) {
      return sorted.data;
    }

    // Kolom created_at mungkin tidak ada: ulangi tanpa pengurutan
    const plain = await supabase.from('properties').select('*');
    if (!plain.error && Array.isArray(plain.data)) {
      return plain.data;
    }
    return [];
  } catch (err) {
    console.error('Gagal memuat properti dari Supabase:', err);
    return [];
  }
}