import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { TieredPaymentMethodSelect, PaymentMethodSnapshotData } from "./TieredPaymentMethodSelect";
import { formatRupiah } from "../../utils/financeFormatters";
import { Wallet, Plus, ArrowDownLeft, ArrowUpRight, AlertCircle, Info } from "lucide-react";

export interface AddKasMessengerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messengerOptions: string[];
  orderOptions: string[];
  onSubmit: (data: {
    tanggal: string;
    jenis: string;
    messenger: string;
    keterangan: string;
    in: number;
    out: number;
    orderNo?: string;
    payment_method_id?: string | null;
    payment_method_snapshot?: string | null;
  }) => Promise<void> | void;
}

export function AddKasMessengerModal({
  open,
  onOpenChange,
  messengerOptions,
  orderOptions,
  onSubmit,
}: AddKasMessengerModalProps) {
  const [tanggal, setTanggal] = useState<string>(new Date().toISOString().split("T")[0]);
  const [jenis, setJenis] = useState<string>("Petty cash");
  const [messenger, setMessenger] = useState<string>(messengerOptions[0] || "");
  const [arah, setArah] = useState<"IN" | "OUT">("IN");
  const [nominal, setNominal] = useState<string>("");
  const [keterangan, setKeterangan] = useState<string>("");
  const [orderNo, setOrderNo] = useState<string>("-");
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(null);
  const [paymentMethodSnapshot, setPaymentMethodSnapshot] = useState<PaymentMethodSnapshotData | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const cleanNominal = parseInt(nominal.replace(/[^0-9]/g, ""), 10) || 0;

  const handleReset = () => {
    setTanggal(new Date().toISOString().split("T")[0]);
    setJenis("Petty cash");
    setMessenger(messengerOptions[0] || "");
    setArah("IN");
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
      setErrorMsg("Keterangan transaksi wajib diisi.");
      return;
    }

    if (arah === "IN" && !paymentMethodId) {
      setErrorMsg("Metode pembayaran wajib dipilih untuk transaksi kas masuk (top-up).");
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({
        tanggal,
        jenis,
        messenger: messenger || messengerOptions[0] || "Kurir",
        keterangan: keterangan.trim(),
        in: arah === "IN" ? cleanNominal : 0,
        out: arah === "OUT" ? cleanNominal : 0,
        orderNo: orderNo && orderNo !== "-" ? orderNo.split(" ")[0] : undefined,
        payment_method_id: arah === "IN" ? paymentMethodId : null,
        payment_method_snapshot: arah === "IN" && paymentMethodSnapshot ? JSON.stringify(paymentMethodSnapshot) : null,
      });
      handleReset();
      onOpenChange(false);
    } catch (err: any) {
      setErrorMsg(err?.message || "Gagal menyimpan transaksi kas messenger.");
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
              <Wallet className="w-4 h-4" />
            </div>
            <span>Tambah Transaksi Kas Messenger</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Catat top-up dana petty cash kurir atau pengeluaran operasional messenger.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          {errorMsg && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Tanggal & Jenis */}
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
              <Label className="text-xs font-semibold">Jenis Kas *</Label>
              <Select value={jenis} onValueChange={setJenis}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Pilih jenis" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Petty cash" className="text-xs">Petty cash</SelectItem>
                  <SelectItem value="Operasional" className="text-xs">Operasional</SelectItem>
                  <SelectItem value="Biaya Samsat" className="text-xs">Biaya Samsat</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Kurir & Order */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Nama Messenger *</Label>
              <Select value={messenger} onValueChange={setMessenger}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Pilih kurir" />
                </SelectTrigger>
                <SelectContent>
                  {messengerOptions.map((opt) => (
                    <SelectItem key={opt} value={opt} className="text-xs">
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
          </div>

          {/* Arah Transaksi: Masuk (Debit) vs Keluar (Kredit) */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Tipe Transaksi *</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setArah("IN")}
                className={`py-2 px-3 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  arah === "IN"
                    ? "bg-emerald-500/10 border-emerald-500 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500"
                    : "border-border bg-card text-muted-foreground hover:bg-muted"
                }`}
              >
                <ArrowDownLeft className="w-3.5 h-3.5" />
                <span>Kas Masuk (Top-Up)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setArah("OUT");
                  setPaymentMethodId(null);
                  setPaymentMethodSnapshot(null);
                }}
                className={`py-2 px-3 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  arah === "OUT"
                    ? "bg-rose-500/10 border-rose-500 text-rose-700 dark:text-rose-300 ring-1 ring-rose-500"
                    : "border-border bg-card text-muted-foreground hover:bg-muted"
                }`}
              >
                <ArrowUpRight className="w-3.5 h-3.5" />
                <span>Kas Keluar (Operasional)</span>
              </button>
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
              placeholder="Contoh: Top-up saldo awal minggu / Biaya bensin & tol"
              value={keterangan}
              onChange={(e) => setKeterangan(e.target.value)}
              className="h-9 text-xs"
              required
            />
          </div>

          {/* METODE PEMBAYARAN TIERED SELECTOR */}
          {arah === "IN" ? (
            <div className="pt-2 border-t border-border/60">
              <TieredPaymentMethodSelect
                value={paymentMethodId}
                onChange={(id, snap) => {
                  setPaymentMethodId(id);
                  setPaymentMethodSnapshot(snap);
                }}
                required={true}
              />
            </div>
          ) : (
            <div className="p-3 rounded-lg border border-border/60 bg-muted/20 text-xs text-muted-foreground flex items-center gap-2">
              <Info className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>
                Metode pembayaran tidak berlaku untuk kas keluar kurir (payout reimbursement atau operasional kurir).
              </span>
            </div>
          )}

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
              disabled={isSubmitting}
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
