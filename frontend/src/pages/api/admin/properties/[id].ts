import type { APIRoute } from "astro";
import {
  checkRole,
  getAuthUser,
  getSupabase,
  isEnforceAuth,
  jsonRes,
} from "../../../../lib/apiServer";

async function canModifyProperty(
  request: Request,
  locals: any,
  propertyId: string,
  supabase: any,
) {
  if (!isEnforceAuth(locals)) return null;
  const authUser = getAuthUser(request, locals);
  if (!authUser || authUser.role !== "AGENT") return null;

  const { data } = await supabase
    .from("properties")
    .select("owner_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (!data || String(data.owner_id) !== String(authUser.id)) {
    return jsonRes(
      { error: "Anda hanya boleh mengelola properti milik Anda sendiri." },
      403,
    );
  }
  return null;
}

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const denied = checkRole(request, locals, "ADMIN", "SUPER_ADMIN", "AGENT");
  if (denied) return denied;

  try {
    const id = params.id;
    if (!id) return jsonRes({ error: "ID properti wajib diisi." }, 400);

    const supabase = getSupabase(locals);
    const forbidden = await canModifyProperty(request, locals, id, supabase);
    if (forbidden) return forbidden;

    const body = await request.json();
    const {
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

    const updatePayload: Record<string, any> = {};
    if (title !== undefined) updatePayload.title = String(title).trim();
    if (category !== undefined)
      updatePayload.category = String(category).toLowerCase();
    if (price !== undefined) updatePayload.price = Number(price);
    if (price_unit !== undefined) updatePayload.price_unit = price_unit;
    if (location !== undefined)
      updatePayload.location = String(location).trim();
    if (block_or_unit !== undefined)
      updatePayload.block_or_unit = String(block_or_unit).trim();
    if (description !== undefined)
      updatePayload.description = String(description).trim();
    if (specifications !== undefined)
      updatePayload.specifications = specifications;
    if (image_url !== undefined)
      updatePayload.image_url = String(image_url).trim();
    if (status !== undefined) updatePayload.status = status;

    const authUser = getAuthUser(request, locals);
    if (!(isEnforceAuth(locals) && authUser?.role === "AGENT")) {
      if (owner_id !== undefined) updatePayload.owner_id = owner_id;
      if (owner_role !== undefined) updatePayload.owner_role = owner_role;
    }

    const { data, error } = await supabase
      .from("properties")
      .update(updatePayload)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;

    return jsonRes(
      { message: "Data properti berhasil diperbarui!", property: data },
      200,
    );
  } catch (err: any) {
    return jsonRes(
      { error: err?.message || "Gagal memperbarui properti." },
      500,
    );
  }
};

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const denied = checkRole(request, locals, "ADMIN", "SUPER_ADMIN", "AGENT");
  if (denied) return denied;

  try {
    const id = params.id;
    if (!id) return jsonRes({ error: "ID properti wajib diisi." }, 400);

    const supabase = getSupabase(locals);
    const forbidden = await canModifyProperty(request, locals, id, supabase);
    if (forbidden) return forbidden;

    const { error } = await supabase.from("properties").delete().eq("id", id);
    if (error) throw error;

    return jsonRes(
      { message: "Unit properti berhasil dihapus dari katalog." },
      200,
    );
  } catch (err: any) {
    return jsonRes({ error: err?.message || "Gagal menghapus properti." }, 500);
  }
};
