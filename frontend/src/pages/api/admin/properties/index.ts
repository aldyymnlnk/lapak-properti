import type { APIRoute } from "astro";
import {
  checkRole,
  getAuthUser,
  getSupabase,
  isEnforceAuth,
  jsonRes,
} from "../../../../lib/apiServer";

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = checkRole(request, locals, "ADMIN", "SUPER_ADMIN", "AGENT");
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

    const authUser = getAuthUser(request, locals);
    if (isEnforceAuth(locals) && authUser?.role === "AGENT") {
      owner_id = authUser.id;
      owner_role = "AGENT";
    }

    const insertPayload: Record<string, any> = {
      title: String(title).trim(),
      category: String(category).toLowerCase(),
      price: Number(price),
      price_unit: price_unit || "bulan",
      location: String(location).trim(),
      block_or_unit: block_or_unit ? String(block_or_unit).trim() : "-",
      description: description
        ? String(description).trim()
        : "Fasilitas lengkap, lokasi strategis, dan siap huni.",
      specifications:
        specifications && typeof specifications === "object"
          ? specifications
          : {},
      status: status || "AVAILABLE",
      image_url:
        image_url && String(image_url).trim() !== ""
          ? String(image_url).trim()
          : "https://images.unsplash.com/photo-1560518883-ce09059eeffa?auto=format&fit=crop&w=800&q=80",
    };

    if (owner_id) insertPayload.owner_id = owner_id;
    if (owner_role) insertPayload.owner_role = owner_role;

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
