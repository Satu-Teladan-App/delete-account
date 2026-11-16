export function safeInternalRedirect(value: string | null, fallback = "/tickets"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return fallback;
  try {
    const target = new URL(value, "https://internal.invalid");
    if (target.origin !== "https://internal.invalid" || target.pathname.startsWith("/auth/")) return fallback;
    return target.pathname + target.search + target.hash;
  } catch { return fallback; }
}
