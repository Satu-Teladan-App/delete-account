import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Database } from "@/types/database.types";

async function authorizeAdmin(request: NextRequest) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const supabase = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: roles, error: roleError } = await supabase.from("admin_roles").select("role_id").eq("user_id", user.id).limit(1);
  if (roleError || !roles?.length) return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { supabase, user };
}

const statuses = ["pending", "approved", "rejected", "processing", "completed", "cancelled"];

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizeAdmin(request);
    if (auth.response) return auth.response;
    const params = new URL(request.url).searchParams;
    const status = params.get("status") || "pending";
    const limit = Number(params.get("limit") || 50);
    const offset = Number(params.get("offset") || 0);
    if ((!statuses.includes(status) && status !== "all") || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
      return NextResponse.json({ error: "Filter atau pagination tidak valid" }, { status: 400 });
    }
    let query = auth.supabase.from("account_deletion_requests").select("*", { count: "exact" })
      .order("created_at", { ascending: false }).range(offset, offset + limit - 1);
    if (status !== "all") query = query.eq("status", status);
    const { data, error, count } = await query;
    if (error) throw error;
    return NextResponse.json({ success: true, data, pagination: { total: count || 0, limit, offset } });
  } catch { return NextResponse.json({ error: "Permintaan belum dapat dimuat" }, { status: 500 }); }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await authorizeAdmin(request);
    if (auth.response) return auth.response;
    const { request_id, action, notes } = await request.json();
    if (typeof request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request_id) || !["approved", "rejected", "completed"].includes(action)
      || (notes != null && (typeof notes !== "string" || notes.length > 4000))) {
      return NextResponse.json({ error: "Permintaan tidak valid" }, { status: 400 });
    }
    if (action === "completed") return NextResponse.json({
      error: "Status selesai hanya dapat diberikan oleh proses penghapusan terverifikasi. Eksekusi otomatis belum tersedia.",
    }, { status: 409 });
    const { data: current, error: readError } = await auth.supabase.from("account_deletion_requests")
      .select("metadata").eq("id", request_id).eq("status", "pending").maybeSingle();
    if (readError) throw readError;
    if (!current) return NextResponse.json({ error: "Permintaan tidak ditemukan atau sudah diproses" }, { status: 409 });
    const metadata = current.metadata && typeof current.metadata === "object" && !Array.isArray(current.metadata) ? current.metadata : {};
    const { data, error } = await auth.supabase.from("account_deletion_requests").update({
      status: action, processed_by: auth.user.id, processed_at: new Date().toISOString(),
      metadata: { ...metadata, notes: notes || null },
    }).eq("id", request_id).eq("status", "pending").select().maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Status permintaan telah berubah. Muat ulang daftar." }, { status: 409 });
    return NextResponse.json({ success: true, data, message: action === "approved" ? "Permintaan disetujui; akun belum dihapus" : "Permintaan ditolak" });
  } catch { return NextResponse.json({ error: "Permintaan belum dapat diproses" }, { status: 500 }); }
}
