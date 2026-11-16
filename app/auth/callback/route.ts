import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { safeInternalRedirect } from "@/lib/redirect";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const redirectTo = safeInternalRedirect(requestUrl.searchParams.get("redirect"));

  if (code) {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(new URL(`/auth/login?redirect=${encodeURIComponent(redirectTo)}&error=callback`, request.url));
  }

  // Redirect to the redirect URL or home page
  return NextResponse.redirect(new URL(redirectTo, request.url));
}
