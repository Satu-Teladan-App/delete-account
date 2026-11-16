import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const publicPages = new Set(["/", "/hapusakun", "/hapus-akun", "/auth/login", "/privacy", "/tos"]);
const retiredPages = new Set(["/tickets", "/auth/register"]);

function secure(response: NextResponse) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname.replace(/\/$/, "") || "/";
  if (retiredPages.has(path) || path === "/admin" || path.startsWith("/admin/")) {
    return secure(NextResponse.redirect(new URL("/hapusakun", request.url)));
  }
  if (path.startsWith("/api/")) {
    if (path !== "/api/account-deletion/request") {
      return secure(NextResponse.json({ error: "Not found" }, { status: 404 }));
    }
    if (!["GET", "POST"].includes(request.method)) {
      const response = NextResponse.json({ error: "Method not allowed" }, { status: 405 });
      response.headers.set("Allow", "GET, POST");
      return secure(response);
    }
    // Sessions live in browser storage. The API verifies this token with Supabase.
    if (!/^Bearer\s+\S+$/i.test(request.headers.get("authorization") || "")) {
      return secure(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    }
    if (request.method === "POST" && request.headers.get("sec-fetch-site") === "cross-site") {
      return secure(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    }
    return secure(NextResponse.next());
  }
  if (!publicPages.has(path)) {
    return secure(NextResponse.json({ error: "Not found" }, { status: 404 }));
  }
  return secure(NextResponse.next());
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|site\\.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
