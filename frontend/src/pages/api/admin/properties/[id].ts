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

/**
 * Agen hanya boleh mengubah/menghapus properti miliknya.
 * Kepemilikan dikenali dari owner_id ATAU specifications.agent_id
 * (unit yang dibuat saat ENFORCE_AUTH masih mati tidak punya owner_id).
 * Admin / Super Admin / Seller boleh mengelola semua unit.
 */
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
    .select("owner_id, specifications")
    .eq("id", propertyId)
    .maybeSingle();

  const ownerId = data?.owner_id ? String(data.owner_id) : "";
  const specAgentId = data?.specifications?.agent_id ? String(data.specifications.agent_id) : "";
  const me = String(authUser.id);

  if (!data || (ownerId !== me && specAgentId !== me)) {
    return jsonRes(
      { error: "Anda hanya boleh mengelola properti milik Anda sendiri." },
      403,
    );
  }
  return null;
}

function checkId(id: string | undefined) {
  if (!id) return jsonRes({ error: "ID properti wajib diisi." }, 400);
  if (!UUID_RE.test(id)) {
    return jsonRes({ error: "Unit contoh (demo) tidak bisa diubah atau dihapus." }, 400);
  }
  return null;
}

// PUT dan PATCH memakai logika yang sama (dashboard admin memakai PATCH, dashboard agen memakai PUT)
const updateHandler: APIRoute = async ({ params, request, locals }) => {
  const denied = checkRole(request, locals, "ADMIN", "SUPER_ADMIN", "SELLER", "AGENT");
  if (denied) return denied;

  try {
    const id = params.id;
    const badId = checkId(id);
    if (badId) return badId;

    const supabase = getSupabase(locals);
    const forbidden = await canModifyProperty(request, locals, id as string, supabase);
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
    if (category !== undefined) {
      const cat = String(category).toLowerCase();
      if (!ALLOWED_CATEGORIES.includes(cat)) {
        return jsonRes({ error: "Kategori harus kos, rumah, atau tanah." }, 400);
      }
      updatePayload.category = cat;
    }
    if (price !== undefined) updatePayload.price = Number(price);
    if (price_unit !== undefined) updatePayload.price_unit = price_unit;
    if (location !== undefined) updatePayload.location = String(location).trim();
    if (block_or_unit !== undefined) updatePayload.block_or_unit = String(block_or_unit).trim();
    if (description !== undefined) updatePayload.description = String(description).trim();
    if (image_url !== undefined) updatePayload.image_url = String(image_url).trim();
    if (status !== undefined) updatePayload.status = status;

    const authUser = getAuthUser(request, locals);
    const agentEnforced = isEnforceAuth(locals) && authUser?.role === "AGENT";

    if (specifications !== undefined) {
      const specs: Record<string, any> =
        specifications && typeof specifications === "object" && !Array.isArray(specifications)
          ? { ...specifications }
          : {};
      // Agen tidak boleh memindahkan kepemilikan lewat specifications
      if (agentEnforced && authUser) specs.agent_id = authUser.id;
      updatePayload.specifications = specs;
    }

    // Hanya admin/superadmin yang boleh memindahkan pemilik unit
    if (!agentEnforced) {
      if (owner_id !== undefined) {
        if (owner_id === null || owner_id === "") {
          updatePayload.owner_id = null;
        } else if (UUID_RE.test(String(owner_id))) {
          updatePayload.owner_id = owner_id;
        }
      }
      if (owner_role !== undefined) updatePayload.owner_role = owner_role;
    }

    if (Object.keys(updatePayload).length === 0) {
      return jsonRes({ error: "Tidak ada data yang diubah." }, 400);
    }

    const { data, error } = await supabase
      .from("properties")
      .update(updatePayload)
      .eq("id", id as string)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return jsonRes({ error: "Properti tidak ditemukan." }, 404);

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

export const PUT: APIRoute = updateHandler;
export const PATCH: APIRoute = updateHandler;

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const denied = checkRole(request, locals, "ADMIN", "SUPER_ADMIN", "SELLER", "AGENT");
  if (denied) return denied;

  try {
    const id = params.id;
    const badId = checkId(id);
    if (badId) return badId;

    const supabase = getSupabase(locals);
    const forbidden = await canModifyProperty(request, locals, id as string, supabase);
    if (forbidden) return forbidden;

    const { error } = await supabase.from("properties").delete().eq("id", id as string);
    if (error) throw error;

    return jsonRes(
      { message: "Unit properti berhasil dihapus dari katalog." },
      200,
    );
  } catch (err: any) {
    return jsonRes({ error: err?.message || "Gagal menghapus properti." }, 500);
  }
};