import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { TieredPaymentMethodSelect, PaymentMethodSnapshotData } from "./TieredPaymentMethodSelect";
import { formatRupiah } from "../../utils/financeFormatters";
import { Building2, Plus, ArrowDownLeft, ArrowUpRight, AlertCircle, Info } from "lucide-react";

export interface AddKasKantorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  responsibleOptions: string[];
  orderOptions: string[];
  expenseCategories: string[];
  isLoading?: boolean;
  error?: string | null;
  onSubmit: (data: {
    tanggal: string;
    status: string;
    kategori: string;
    keterangan: string;
    penanggungJawab?: string;
    debit: number;
    kredit: number;
    orderNo?: string;
    payment_method_id?: string | null;
    payment_method_snapshot?: string | null;
  }) => Promise<void> | void;
}

export function AddKasKantorModal({
  open,
  onOpenChange,
  responsibleOptions,
  orderOptions,
  expenseCategories,
  isLoading = false,
  error = null,
  onSubmit,
}: AddKasKantorModalProps) {
  const [tanggal, setTanggal] = useState<string>(new Date().toISOString().split("T")[0]);
  const [status, setStatus] = useState<"Debit" | "Kredit">("Debit");
  const [kategori, setKategori] = useState<string>(expenseCategories[0] || "Operasional");
  const [penanggungJawab, setPenanggungJawab] = useState<string>(responsibleOptions[0] || "");
  useEffect(() => {
    if (responsibleOptions.length > 0) {
      if (!penanggungJawab) {
        setPenanggungJawab(responsibleOptions[0]);
      } else if (!responsibleOptions.includes(penanggungJawab)) {
        // Selected person is no longer in valid options list; reset to empty to avoid silent arbitrary replacement
        setPenanggungJawab("");
      }
    } else if (!isLoading && responsibleOptions.length === 0) {
      setPenanggungJawab("");
    }
  }, [responsibleOptions, penanggungJawab, isLoading]);
  const [nominal, setNominal] = useState<string>("");
  const [keterangan, setKeterangan] = useState<string>("");
  const [orderNo, setOrderNo] = useState<string>("-");
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(null);
  const [paymentMethodSnapshot, setPaymentMethodSnapshot] = useState<PaymentMethodSnapshotData | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const cleanNominal = parseInt(nominal.replace(/[^0-9]/g, ""), 10) || 0;
  const isModalAwal = kategori === "MODAL_AWAL";

  const handleReset = () => {
    setTanggal(new Date().toISOString().split("T")[0]);
    setStatus("Debit");
    setKategori(expenseCategories[0] || "Operasional");
    setPenanggungJawab(responsibleOptions[0] || "");
    setNominal("");
    setKeterangan("");
    setOrderNo("-");
    setPaymentMethodId(null);
    setPaymentMethodSnapshot(null);
    setErrorMsg(null);
    setIsSubmitting(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (cleanNominal <= 0) {
      setErrorMsg("Nominal transaksi harus lebih besar dari Rp 0.");
      return;
    }
    if (!keterangan.trim()) {
      setErrorMsg("Keterangan transaksi kas kantor wajib diisi.");
      return;
    }

    if (penanggungJawab && penanggungJawab.startsWith("__")) {
      setErrorMsg("Penanggung jawab belum dipilih atau tidak tersedia.");
      return;
    }

    if (!isModalAwal && !paymentMethodId) {
      setErrorMsg("Metode pembayaran wajib dipilih untuk transaksi kas kantor operasional.");
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({
        tanggal,
        status: status === "Debit" ? "Debit" : "Kredit",
        kategori,
        keterangan: keterangan.trim(),
        penanggungJawab: penanggungJawab && penanggungJawab !== "-" && !penanggungJawab.startsWith("__") ? penanggungJawab : undefined,
        debit: status === "Debit" ? cleanNominal : 0,
        kredit: status === "Kredit" ? cleanNominal : 0,
        orderNo: orderNo && orderNo !== "-" ? orderNo.split(" ")[0] : undefined,
        payment_method_id: paymentMethodId,
        payment_method_snapshot: paymentMethodSnapshot ? JSON.stringify(paymentMethodSnapshot) : null,
      });
      handleReset();
      onOpenChange(false);
    } catch (err: any) {
      setErrorMsg(err?.message || "Gagal menyimpan transaksi kas kantor.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleReset();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="border-border sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold flex items-center gap-2 text-foreground">
            <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Building2 className="w-4 h-4" />
            </div>
            <span>Tambah Transaksi Kas Kantor</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Catat arus kas masuk debit ataupun pengeluaran operasional kredit kantor.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          {errorMsg && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Tanggal & Penanggung Jawab */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Tanggal *</Label>
              <Input
                type="date"
                value={tanggal}
                onChange={(e) => setTanggal(e.target.value)}
                className="h-9 text-xs"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Penanggung Jawab</Label>
              <Select value={penanggungJawab} onValueChange={setPenanggungJawab}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder={isLoading && responsibleOptions.length === 0 ? "Memuat data penanggung jawab..." : "Pilih penanggung jawab"} />
                </SelectTrigger>
                <SelectContent>
                  {isLoading && responsibleOptions.length === 0 ? (
                    <SelectItem value="__loading" disabled className="text-xs text-muted-foreground">
                      Memuat data penanggung jawab...
                    </SelectItem>
                  ) : error && responsibleOptions.length === 0 ? (
                    <SelectItem value="__error" disabled className="text-xs text-rose-500">
                      Gagal memuat: {error}
                    </SelectItem>
                  ) : responsibleOptions.length === 0 ? (
                    <SelectItem value="__empty" disabled className="text-xs text-muted-foreground">
                      Tidak ada penanggung jawab aktif
                    </SelectItem>
                  ) : (
                    responsibleOptions.map((opt) => (
                      <SelectItem key={opt} value={opt} className="text-xs">
                        {opt}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Status & Kategori */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Tipe Arus Kas *</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setStatus("Debit")}
                  className={`py-2 px-2.5 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                    status === "Debit"
                      ? "bg-emerald-500/10 border-emerald-500 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500"
                      : "border-border bg-card text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <ArrowDownLeft className="w-3.5 h-3.5" />
                  <span>Debit (Masuk)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setStatus("Kredit")}
                  className={`py-2 px-2.5 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                    status === "Kredit"
                      ? "bg-rose-500/10 border-rose-500 text-rose-700 dark:text-rose-300 ring-1 ring-rose-500"
                      : "border-border bg-card text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  <span>Kredit (Keluar)</span>
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Kategori Kas *</Label>
              <Select value={kategori} onValueChange={setKategori}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Pilih kategori" />
                </SelectTrigger>
                <SelectContent>
                  {expenseCategories.map((cat) => (
                    <SelectItem key={cat} value={cat} className="text-xs">
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Nominal */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold flex items-center justify-between">
              <span>Nominal Transaksi (Rp) *</span>
              {cleanNominal > 0 && (
                <span className="font-mono text-xs font-semibold text-primary">
                  {formatRupiah(cleanNominal)}
                </span>
              )}
            </Label>
            <Input
              type="text"
              placeholder="0"
              value={nominal ? parseInt(nominal.replace(/[^0-9]/g, ""), 10).toLocaleString("id-ID") : ""}
              onChange={(e) => setNominal(e.target.value.replace(/[^0-9]/g, ""))}
              className="h-9 text-xs font-mono font-bold"
              required
            />
          </div>

          {/* Keterangan */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Keterangan *</Label>
            <Input
              type="text"
              placeholder="Contoh: Penerimaan pembayaran konsumen / Biaya sewa kantor"
              value={keterangan}
              onChange={(e) => setKeterangan(e.target.value)}
              className="h-9 text-xs"
              required
            />
          </div>

          {/* Order Terkait */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Order Terkait (Opsional)</Label>
            <Select value={orderNo} onValueChange={setOrderNo}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Pilih nomor order" />
              </SelectTrigger>
              <SelectContent>
                {orderOptions.map((opt) => (
                  <SelectItem key={opt} value={opt} className="text-xs truncate max-w-[240px]">
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* METODE PEMBAYARAN TIERED SELECTOR */}
          <div className="pt-2 border-t border-border/60">
            <TieredPaymentMethodSelect
              value={paymentMethodId}
              onChange={(id, snap) => {
                setPaymentMethodId(id);
                setPaymentMethodSnapshot(snap);
              }}
              required={!isModalAwal}
            />
            {isModalAwal && (
              <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
                <Info className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                Untuk modal awal / opening balance, metode pembayaran bersifat opsional.
              </p>
            )}
          </div>

          <DialogFooter className="mt-4 gap-2 pt-2 border-t border-border">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="text-xs h-8"
              disabled={isSubmitting}
            >
              Batal
            </Button>
            <Button
              type="submit"
              size="sm"
              className="text-xs h-8 bg-primary text-primary-foreground gap-1.5 font-semibold"
              disabled={isSubmitting || isLoading || (responsibleOptions.length === 0 && !isModalAwal)}
            >
              <Plus className="w-3.5 h-3.5" />
              {isSubmitting ? "Menyimpan..." : "Simpan Transaksi"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
