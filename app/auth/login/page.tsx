"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { error } = await getSupabaseBrowserClient().auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error("Tidak dapat masuk. Periksa email dan kata sandi akun Satu Teladan Anda.");
      router.replace("/hapusakun");
    } catch (err) { setError(err instanceof Error ? err.message : "Tidak dapat masuk. Coba lagi."); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto max-w-md px-5 py-12">
    <Link href="/" className="inline-block py-3 font-semibold text-[#002587]">← Hapus Akun Satu Teladan</Link>
    <h1 className="mt-6 text-2xl font-bold text-[#002587]">Verifikasi akun Anda</h1>
    <p className="mt-3 leading-7 text-slate-600">Gunakan akun yang ingin dihapus. Jika biasa masuk dengan Google atau lupa kata sandi, atur ulang kata sandi melalui aplikasi terlebih dahulu.</p>
    <form onSubmit={login} className="mt-7 space-y-5">
      <div><label htmlFor="email" className="block font-medium">Email akun</label><input id="email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 p-3" /></div>
      <div><label htmlFor="password" className="block font-medium">Kata sandi</label><input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 p-3" /></div>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <button disabled={busy} className="min-h-11 w-full rounded-lg bg-[#002587] p-3 font-semibold text-white disabled:opacity-50">{busy ? "Memverifikasi…" : "Masuk"}</button>
    </form>
  </div>;
}
