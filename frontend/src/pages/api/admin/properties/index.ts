import type { APIRoute } from "astro";
import {
  UUID_RE,
  checkRole,
  getAuthUser,
  getSupabase,
  isEnforceAuth,
  jsonRes,
} from "../../../../lib/apiServer";

const ALLOWED_CATEGORIES = ["kos", "rumah", "tanah"];
const ALLOWED_OWNER_ROLES = ["SUPER_ADMIN", "ADMIN", "SELLER", "AGENT"];

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = checkRole(request, locals, "ADMIN", "SUPER_ADMIN", "SELLER", "AGENT");
  if (denied) return denied;

  try {
    const body = await request.json();
    let {
      title,
      category,
      price,
      price_unit,
      location,
      block_or_unit,
      description,
      specifications,
      gallery,
      image_url,
      status,
      owner_id,
      owner_role,
    } = body || {};

    if (!title || !category || !price || !location) {
      return jsonRes(
        { error: "Judul, kategori, harga, dan lokasi wajib diisi." },
        400,
      );
    }

    const cat = String(category).toLowerCase();
    if (!ALLOWED_CATEGORIES.includes(cat)) {
      return jsonRes({ error: "Kategori harus kos, rumah, atau tanah." }, 400);
    }

    const authUser = getAuthUser(request, locals);
    const enforce = isEnforceAuth(locals);

    // Spesifikasi: salin supaya aman dimodifikasi
    const specs: Record<string, any> =
      specifications && typeof specifications === "object" && !Array.isArray(specifications)
        ? { ...specifications }
        : {};

    // Foto pendukung ikut disimpan di specifications.gallery (kolom gallery tidak dipakai)
    if (Array.isArray(gallery) && !Array.isArray(specs.gallery)) {
      specs.gallery = gallery;
    }

    // Agen: pemilik ditentukan dari token, tidak bisa dipalsukan dari client
    if (enforce && authUser?.role === "AGENT") {
      owner_id = authUser.id;
      owner_role = "AGENT";
      specs.agent_id = authUser.id;
    }

    const insertPayload: Record<string, any> = {
      title: String(title).trim(),
      category: cat,
      price: Number(price),
      price_unit: price_unit || "bulan",
      location: String(location).trim(),
      block_or_unit: block_or_unit ? String(block_or_unit).trim() : "-",
      description: description
        ? String(description).trim()
        : "Fasilitas lengkap, lokasi strategis, dan siap huni.",
      specifications: specs,
      status: status || "AVAILABLE",
      image_url:
        image_url && String(image_url).trim() !== ""
          ? String(image_url).trim()
          : "https://images.unsplash.com/photo-1560518883-ce09059eeffa?auto=format&fit=crop&w=800&q=80",
    };

    // owner_id hanya disimpan kalau berupa UUID akun di tabel users.
    // Akun preset / kode akses (mis. "preset-agen") tidak punya baris di tabel users.
    if (owner_id && UUID_RE.test(String(owner_id))) {
      insertPayload.owner_id = owner_id;
    }
    if (owner_role && ALLOWED_OWNER_ROLES.includes(String(owner_role).toUpperCase())) {
      insertPayload.owner_role = String(owner_role).toUpperCase();
    }

    const supabase = getSupabase(locals);
    const { data, error } = await supabase
      .from("properties")
      .insert([insertPayload])
      .select()
      .single();
    if (error) throw error;

    return jsonRes(
      {
        message: "Unit properti berhasil diposting ke katalog publik!",
        property: data,
      },
      201,
    );
  } catch (err: any) {
    return jsonRes({ error: err?.message || "Gagal menambah properti." }, 500);
  }
};