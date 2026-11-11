import { useMemo } from "react";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Badge } from "../ui/badge";
import { usePaymentMethods } from "../../data/paymentMethodStore";
import { CreditCard, Wallet, AlertCircle } from "lucide-react";

export interface PaymentMethodSnapshotData {
  id: string;
  nama_metode: string;
  bank: string;
  nama_rekening: string;
  nomor_rekening: string;
}

export interface TieredPaymentMethodSelectProps {
  value: string | null;
  onChange: (methodId: string | null, snapshot: PaymentMethodSnapshotData | null) => void;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  error?: string | null;
}

export function TieredPaymentMethodSelect({
  value,
  onChange,
  required = true,
  disabled = false,
  className = "",
  error,
}: TieredPaymentMethodSelectProps) {
  const { activeMethods, isLoading } = usePaymentMethods();

  // Cash method from active methods
  const cashMethods = useMemo(() => {
    return activeMethods.filter(
      (m) => m.nama_metode?.toLowerCase().includes("tunai") || m.bank?.toLowerCase() === "tunai"
    );
  }, [activeMethods]);

  // Bank transfer methods
  const bankMethods = useMemo(() => {
    return activeMethods.filter(
      (m) => !m.nama_metode?.toLowerCase().includes("tunai") && m.bank?.toLowerCase() !== "tunai"
    );
  }, [activeMethods]);

  const handleSelect = (methodId: string) => {
    if (!methodId) {
      onChange(null, null);
      return;
    }
    const method = activeMethods.find((m) => m.id === methodId);
    if (!method) {
      onChange(null, null);
      return;
    }
    onChange(method.id, {
      id: method.id,
      nama_metode: method.nama_metode,
      bank: method.bank || "Tunai",
      nama_rekening: method.nama_rekening || "",
      nomor_rekening: method.nomor_rekening || "",
    });
  };

  return (
    <div className={`space-y-1.5 ${className}`}>
      {/* Label */}
      <Label className="text-xs font-semibold text-foreground flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <CreditCard className="w-3.5 h-3.5 text-primary" />
          Metode Pembayaran {required && <span className="text-rose-500">*</span>}
        </span>
        <span className="text-[10px] text-muted-foreground font-normal">
          Sumber: Master Payment Methods
        </span>
      </Label>

      {/* Direct Single Select from payment_methods Table */}
      <Select
        disabled={disabled || isLoading}
        value={value || ""}
        onValueChange={handleSelect}
      >
        <SelectTrigger className="min-h-10 h-auto py-2 text-xs bg-background border-border">
          <SelectValue placeholder={isLoading ? "Memuat metode pembayaran..." : "Pilih Metode Pembayaran (Tunai / Rekening Bank)..."} />
        </SelectTrigger>
        <SelectContent className="max-h-[300px]">
          {/* Cash Methods Group */}
          {cashMethods.length > 0 && (
            <SelectGroup>
              <SelectLabel className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-2 py-1 bg-muted/40">
                💵 Kas Tunai (Fisik)
              </SelectLabel>
              {cashMethods.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-xs py-2 cursor-pointer">
                  <div className="flex items-center gap-2">
                    <Wallet className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                      {m.nama_metode || "Tunai (Kas Fisik)"}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          )}

          {/* Bank Transfer Methods Group */}
          {bankMethods.length > 0 && (
            <SelectGroup>
              <SelectLabel className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-2 py-1 bg-muted/40 mt-1">
                🏦 Rekening Transfer Bank
              </SelectLabel>
              {bankMethods.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-xs py-2 cursor-pointer">
                  <div className="flex flex-col text-left leading-snug">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className="text-[10px] bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-300/40 font-bold uppercase tracking-wide px-1.5 py-0"
                      >
                        {m.bank}
                      </Badge>
                      <span className="font-mono text-xs font-bold text-foreground">
                        {m.nomor_rekening || "—"}
                      </span>
                    </div>
                    {m.nama_rekening && (
                      <span className="text-[11px] text-muted-foreground mt-0.5">
                        a.n. <strong className="font-medium text-foreground/85">{m.nama_rekening}</strong>
                      </span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>

      {error && (
        <p className="text-[11px] text-rose-500 flex items-center gap-1 mt-1">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
