"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/providers/auth-provider";
import { getDeletionRequestStatus, submitDeletionRequest } from "@/lib/api/account-deletion";

const statuses: Record<string, string> = {
  pending: "Menunggu peninjauan", approved: "Disetujui", rejected: "Ditolak",
  processing: "Sedang diproses", completed: "Selesai", cancelled: "Dibatalkan",
};

export default function HapusAkunPage() {
  const { user, isLoading, signOut } = useAuth();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [requests, setRequests] = useState<Awaited<ReturnType<typeof getDeletionRequestStatus>>>([]);
  const [loadingStatus, setLoadingStatus] = useState(false);

  useEffect(() => {
    let active = true;
    setRequests([]);
    if (!user) return;
    setLoadingStatus(true);
    getDeletionRequestStatus().then(data => { if (active) setRequests(data); })
      .catch(() => { if (active) setError("Status belum dapat dimuat. Muat ulang halaman sebelum mengirim permintaan baru."); })
      .finally(() => { if (active) setLoadingStatus(false); });
    return () => { active = false; };
  }, [user]);

  const pending = requests.some(r => ["pending", "approved", "processing"].includes(r.status));
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!user || !confirmed || submitting || pending) return;
    setSubmitting(true);
    setError("");
    try {
      await submitDeletionRequest({ email: user.email || "", reason: reason.trim() || "Permintaan penghapusan akun dan data terkait melalui halaman web." });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Permintaan belum terkirim. Silakan coba lagi.");
    } finally { setSubmitting(false); }
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-10 sm:py-16">
      <header className="mb-10 border-b border-slate-200 pb-5">
        <Link href="/" className="text-lg font-bold text-[#002587]">Satu Teladan</Link>
        <p className="mt-1 text-sm text-slate-600">Pengelolaan akun dan data pribadi</p>
      </header>
      <h1 className="text-3xl font-bold tracking-tight text-[#002587]">Hapus akun</h1>
      <p className="mt-4 leading-7 text-slate-700">Ajukan penghapusan akun Satu Teladan dan data yang terkait dengan akun Anda. Anda dapat mengajukan melalui halaman ini tanpa membuka aplikasi.</p>
      <section aria-labelledby="proses" className="mt-8 space-y-4">
        <h2 id="proses" className="text-xl font-semibold">Cara mengajukan</h2>
        <ol className="list-decimal space-y-2 pl-5 leading-7 text-slate-700">
          <li>Masuk dengan akun Satu Teladan untuk memverifikasi kepemilikan akun.</li>
          <li>Baca informasi di bawah, lalu kirim permintaan penghapusan.</li>
          <li>Admin meninjau permintaan. Pantau statusnya pada halaman ini setelah masuk.</li>
        </ol>
        <p className="leading-7 text-slate-700">Pengajuan tidak langsung menghapus akun. Status disetujui berarti permintaan diterima untuk diproses; penghapusan baru selesai ketika status menjadi Selesai.</p>
      </section>
      <section aria-labelledby="data" className="my-8 border-y border-slate-200 py-6">
        <h2 id="data" className="text-xl font-semibold">Data yang terkait dengan permintaan</h2>
        <p className="mt-3 leading-7 text-slate-700">Permintaan mencakup akun masuk dan data profil pribadi Anda. Riwayat pesan, keanggotaan, kontribusi, serta konten yang terkait dengan pengguna lain perlu ditinjau admin sebelum dihapus atau dianonimkan.</p>
        <p className="mt-3 leading-7 text-slate-700">Rincian data yang wajib disimpan, alasan penyimpanan, serta jangka waktu pemrosesan dan retensi belum ditetapkan pada halaman ini. Informasi tersebut perlu dikonfirmasi pengelola sebelum penghapusan diselesaikan.</p>
      </section>
      <section aria-labelledby="permintaan">
        <h2 id="permintaan" className="text-xl font-semibold">Permintaan penghapusan</h2>
        {isLoading ? <p className="mt-4" role="status">Memeriksa sesi akun…</p> : !user ? (
          <div className="mt-4">
            <p className="mb-5 leading-7 text-slate-700">Masuk untuk memastikan permintaan hanya dibuat oleh pemilik akun.</p>
            <Link href="/auth/login?redirect=/hapusakun" className="inline-flex min-h-11 items-center rounded-lg bg-[#002587] px-5 py-3 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-4">Masuk untuk mengajukan</Link>
          </div>
        ) : <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm"><p>Akun: <strong>{user.email}</strong></p><button onClick={() => void signOut()} className="min-h-11 text-[#002587] underline">Keluar</button></div>
          {loadingStatus && <p role="status">Memuat status permintaan…</p>}
          {requests.length > 0 && <ul className="my-4 space-y-2">{requests.map(r => <li key={r.id} className="rounded-lg border border-slate-200 p-4"><strong>{statuses[r.status] || r.status}</strong><p className="mt-1 text-sm text-slate-600">Diajukan {new Date(r.requested_at).toLocaleDateString("id-ID")}</p></li>)}</ul>}
          {success ? <p role="status" className="mt-5 rounded-lg bg-slate-100 p-5 leading-7">Permintaan diterima dan akan ditinjau admin. Akun belum dihapus. Anda dapat kembali ke halaman ini untuk memeriksa status.</p> : !pending && <form onSubmit={submit} className="mt-5 space-y-5">
            <div><label htmlFor="reason" className="block font-medium">Alasan (opsional)</label><textarea id="reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={2000} rows={4} className="mt-2 w-full rounded-lg border border-slate-300 p-3 focus:outline-2 focus:outline-[#002587]" /></div>
            <label className="flex items-start gap-3 leading-6"><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="mt-1 h-5 w-5 accent-[#002587]" /><span>Saya mengajukan penghapusan akun dan memahami bahwa akun yang telah dihapus tidak dapat dipulihkan.</span></label>
            <button type="submit" disabled={submitting || loadingStatus || !confirmed || Boolean(error)} className="min-h-11 rounded-lg bg-[#002587] px-5 py-3 font-semibold text-white disabled:opacity-50">{submitting ? "Mengirim…" : "Ajukan penghapusan akun"}</button>
          </form>}
        </div>}
        {error && <div role="alert" className="mt-4 text-red-700"><p>{error}</p><button onClick={() => window.location.reload()} className="mt-2 min-h-11 underline">Muat ulang halaman</button></div>}
      </section>
      <footer className="mt-12 border-t border-slate-200 pt-5 text-sm text-slate-600"><Link href="/privacy" className="inline-block py-2 text-[#002587] underline">Kebijakan Privasi</Link></footer>
    </div>
  );
}
