import { useEffect, useMemo, useState } from "react";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { useNavigationGuard } from "../../context/NavigationGuardContext";
import { formatRupiah } from "../../utils/financeFormatters";
import {
  ArrowLeft,
  Wallet,
  Building2,
  CreditCard,
  ShieldCheck,
  Calendar,
  User,
  FileText,
  Clock,
  Eye,
  Download,
  AlertCircle,
  Receipt,
} from "lucide-react";
import { DocumentPreviewModal } from "../DocumentPreviewModal";

export interface CashLedgerDetailPageProps {
  subTabTitle: string;
  item: any;
  onBack: () => void;
}

export function CashLedgerDetailPage({
  subTabTitle,
  item,
  onBack,
}: CashLedgerDetailPageProps) {
  const { setCustomHeader } = useNavigationGuard();
  const [previewReceipt, setPreviewReceipt] = useState<{ url: string; title: string } | null>(null);

  const isMessenger = subTabTitle?.toLowerCase().includes("messenger");
  const ledgerTitle = isMessenger ? "Buku Kas Messenger" : "Buku Kas Kantor";

  // Register Shell Header
  useEffect(() => {
    if (!item) return;
    const subtitle = `ID #${item.id} • ${item.tanggal} • ${item.messenger || item.penanggungJawab || "-"}`;
    setCustomHeader({
      title: `Detail Transaksi — ${ledgerTitle}`,
      subtitle,
      showBackButton: true,
      onBack,
      hideBreadcrumbs: true,
    });
    return () => {
      setCustomHeader(null);
    };
  }, [item, ledgerTitle, onBack, setCustomHeader]);

  // Parse payment method snapshot
  const parsedSnapshot = useMemo(() => {
    const raw = item?.paymentMethodSnapshot || item?.payment_method_snapshot;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, [item]);

  if (!item) {
    return (
      <div className="p-8 text-center space-y-4">
        <p className="text-muted-foreground text-sm">Data transaksi kas tidak ditemukan.</p>
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1.5" />
          Kembali
        </Button>
      </div>
    );
  }

  const isMasuk = isMessenger ? (item.in || 0) > 0 : (item.status === "Debit" || item.status === "Pemasukan" || (item.debit || 0) > 0);
  const nominalMasuk = isMessenger ? (item.in || 0) : (item.debit || 0);
  const nominalKeluar = isMessenger ? (item.out || 0) : (item.kredit || 0);
  const runningTotal = item.total !== undefined ? item.total : (item.saldo !== undefined ? item.saldo : 0);

  return (
    <div className="space-y-5 text-left max-w-5xl mx-auto pb-10">
      {/* Top Action Bar */}
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={onBack}
          className="text-xs h-8 gap-1.5 border-border hover:bg-muted"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Kembali ke {ledgerTitle}</span>
        </Button>

        <Badge variant="outline" className="text-xs font-mono font-medium px-2.5 py-1">
          ID: #{item.id}
        </Badge>
      </div>

      {/* Grid: 3 Main Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* CARD 1: INFORMASI TRANSAKSI */}
        <Card className="p-4 sm:p-5 border border-border/80 bg-card shadow-xs rounded-xl space-y-4 md:col-span-2">
          <div className="flex items-center gap-3 border-b border-border/60 pb-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold shrink-0">
              {isMessenger ? <Wallet className="w-4 h-4" /> : <Building2 className="w-4 h-4" />}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">1. Informasi Transaksi</h3>
              <p className="text-xs text-muted-foreground">Rincian pencatatan buku kas dan relasi operasional</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div className="space-y-1">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                Tanggal Transaksi
              </span>
              <p className="font-semibold text-foreground font-mono text-sm">{item.tanggal}</p>
            </div>

            <div className="space-y-1">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                Tipe Arus Kas
              </span>
              <div>
                {isMasuk ? (
                  <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-300/40 text-xs font-medium">
                    🟢 Kas Masuk (Debit / Pemasukan)
                  </Badge>
                ) : (
                  <Badge variant="outline" className="bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-300/40 text-xs font-medium">
                    🔴 Kas Keluar (Kredit / Pengeluaran)
                  </Badge>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                Jenis / Kategori
              </span>
              <p className="font-medium text-foreground">{item.jenis || item.kategori || "Operasional"}</p>
            </div>

            <div className="space-y-1">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-muted-foreground" />
                {isMessenger ? "Nama Messenger" : "Penanggung Jawab"}
              </span>
              <p className="font-semibold text-foreground">{item.messenger || item.penanggungJawab || "-"}</p>
            </div>

            {item.orderNo && (
              <div className="space-y-1 sm:col-span-2">
                <span className="text-muted-foreground">Nomor Order Terkait</span>
                <p className="font-mono font-bold text-primary">{item.orderNo}</p>
              </div>
            )}

            {item.reimbursementId && (
              <div className="space-y-1 sm:col-span-2">
                <span className="text-muted-foreground">ID Pengajuan Reimbursement</span>
                <p className="font-mono font-semibold text-blue-600 dark:text-blue-400">{item.reimbursementId}</p>
              </div>
            )}

            <div className="space-y-1 sm:col-span-2">
              <span className="text-muted-foreground">Keterangan Transaksi</span>
              <p className="p-2.5 rounded-lg bg-muted/30 border border-border/60 text-foreground font-normal leading-relaxed">
                {item.keterangan || "-"}
              </p>
            </div>
          </div>
        </Card>

        {/* CARD 2: RINGKASAN SALDO */}
        <Card className="p-4 sm:p-5 border border-border/80 bg-card shadow-xs rounded-xl space-y-4">
          <div className="flex items-center gap-2 border-b border-border/60 pb-3">
            <span className="font-semibold text-xs text-foreground uppercase tracking-wider">
              2. Rincian Saldo
            </span>
          </div>

          <div className="space-y-3 text-xs">
            {nominalMasuk > 0 && (
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 space-y-1">
                <span className="text-emerald-700 dark:text-emerald-300 text-[11px] font-semibold">Kas Masuk (Debit)</span>
                <p className="font-mono font-bold text-base text-emerald-600 dark:text-emerald-400">
                  {formatRupiah(nominalMasuk)}
                </p>
              </div>
            )}

            {nominalKeluar > 0 && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 space-y-1">
                <span className="text-rose-700 dark:text-rose-300 text-[11px] font-semibold">Kas Keluar (Kredit)</span>
                <p className="font-mono font-bold text-base text-rose-600 dark:text-rose-400">
                  {formatRupiah(nominalKeluar)}
                </p>
              </div>
            )}

            <div className="p-3 rounded-lg bg-muted/40 border border-border space-y-1">
              <span className="text-muted-foreground text-[11px] font-semibold">Posisi Saldo Berjalan</span>
              <p className="font-mono font-bold text-base text-foreground">
                {formatRupiah(runningTotal)}
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* CARD 3: METODE PEMBAYARAN (FROZEN SNAPSHOT) */}
      <Card className="p-4 sm:p-5 border border-border/80 bg-card shadow-xs rounded-xl space-y-4">
        <div className="flex items-center justify-between border-b border-border/60 pb-3 flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center font-bold shrink-0">
              <CreditCard className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">3. Metode Pembayaran & Snapshot Historis</h3>
              <p className="text-xs text-muted-foreground">Rekam jejak kanal pembayaran terbekukan (Single Source of Truth)</p>
            </div>
          </div>

          {parsedSnapshot && (
            <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-300/40 gap-1 font-medium">
              <ShieldCheck className="w-3.5 h-3.5" />
              Snapshot Terkunci
            </Badge>
          )}
        </div>

        {parsedSnapshot ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs pt-1">
            <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-1">
              <span className="text-muted-foreground text-[11px]">Nama Metode</span>
              <p className="font-semibold text-foreground text-sm">{parsedSnapshot.nama_metode || "-"}</p>
            </div>

            <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-1">
              <span className="text-muted-foreground text-[11px]">Bank / Saluran</span>
              <p className="font-semibold text-primary font-mono text-sm">{parsedSnapshot.bank || "-"}</p>
            </div>

            <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-1">
              <span className="text-muted-foreground text-[11px]">Nomor Rekening</span>
              <p className="font-mono font-bold text-foreground text-sm">
                {parsedSnapshot.nomor_rekening || "—"}
              </p>
            </div>

            <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-1">
              <span className="text-muted-foreground text-[11px]">Atas Nama Rekening</span>
              <p className="font-semibold text-foreground text-sm">
                {parsedSnapshot.nama_rekening || "—"}
              </p>
            </div>

            {parsedSnapshot.id && (
              <div className="p-2 sm:col-span-2 md:col-span-4 rounded bg-muted/10 border border-border/50 text-[11px] font-mono text-muted-foreground flex items-center justify-between">
                <span>Master ID Referensi: {parsedSnapshot.id}</span>
                <span className="text-[10px] text-emerald-600 font-sans">Snapshot kebal mutasi master</span>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 rounded-lg border border-dashed border-border/80 bg-muted/10 text-xs text-muted-foreground flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                Metode Pembayaran: <span className="font-mono text-muted-foreground">—</span>
              </p>
              <p className="text-[11px]">
                {isMessenger && !isMasuk
                  ? "Transaksi kas keluar kurir (operasional / reimbursement) tidak menggunakan saluran pembayaran masuk (nilai NULL kanonis)."
                  : "Transaksi ini dicatat sebelum saluran pembayaran diaktifkan atau tidak menggunakan master pembayaran historis. Nilai tetap dipertahankan NULL tanpa tebakan."}
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* CARD 4: BUKTI STRUK (JIKA ADA) */}
      {item.receiptUrl && (
        <Card className="p-4 sm:p-5 border border-border/80 bg-card shadow-xs rounded-xl space-y-4">
          <div className="flex items-center justify-between border-b border-border/60 pb-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center font-bold shrink-0">
                <Receipt className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">4. Bukti Kuitansi / Struk</h3>
                <p className="text-xs text-muted-foreground">Lampiran bukti pengeluaran yang diunggah</p>
              </div>
            </div>

            <Button
              size="sm"
              variant="outline"
              onClick={() => setPreviewReceipt({ url: item.receiptUrl, title: `Bukti Transaksi #${item.id}` })}
              className="text-xs h-8 gap-1.5"
            >
              <Eye className="w-3.5 h-3.5" />
              Lihat Bukti
            </Button>
          </div>
        </Card>
      )}

      {/* Preview Modal */}
      {previewReceipt && (
        <DocumentPreviewModal
          isOpen={true}
          onClose={() => setPreviewReceipt(null)}
          rawUrl={previewReceipt.url}
          title={previewReceipt.title}
          documentName={previewReceipt.title}
        />
      )}
    </div>
  );
}
