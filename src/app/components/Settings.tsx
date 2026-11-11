import { useState } from "react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Badge } from "./ui/badge";
import {
  Bell,
  Shield,
  Key,
  Save,
  Info,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { useNotificationSettings } from "../data/notificationSettingsStore";
import { APP_CONFIG } from "../config/appConfig";

export function Settings() {
  const {
    settings,
    isSaving,
    saveSettings,
    toggleNotificationType,
  } = useNotificationSettings();

  // Security password state
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);

  // 2FA state (local preference)
  const [is2FAEnabled, setIs2FAEnabled] = useState(false);

  const handleToggleNotification = (
    key: "notifyTagihanReminder" | "notifyTagihanPerubahan" | "notifyOrderUpdate" | "notifyProsesGagal",
    value: boolean
  ) => {
    toggleNotificationType(key, value);
  };

  const handleSaveNotificationSettings = async () => {
    const res = await saveSettings({
      notifyTagihanReminder: settings.notifyTagihanReminder,
      notifyTagihanPerubahan: settings.notifyTagihanPerubahan,
      notifyOrderUpdate: settings.notifyOrderUpdate,
      notifyProsesGagal: settings.notifyProsesGagal,
    });
    if (res.success) {
      toast.success("Pengaturan notifikasi berhasil disimpan.");
    } else {
      toast.error(res.message || "Gagal menyimpan pengaturan notifikasi.");
    }
  };

  const handlePasswordUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oldPassword.trim() || !newPassword.trim() || !confirmPassword.trim()) {
      toast.error("Harap isi seluruh field kata sandi.");
      return;
    }
    if (newPassword.trim().length < 8) {
      toast.error("Kata sandi baru minimal 8 karakter.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Konfirmasi kata sandi baru tidak cocok.");
      return;
    }
    if (oldPassword === newPassword) {
      toast.error("Kata sandi baru tidak boleh sama dengan kata sandi saat ini.");
      return;
    }

    const token = localStorage.getItem("auth_token");
    if (!token) {
      toast.error("Sesi autentikasi tidak ditemukan. Harap login kembali.");
      return;
    }

    setIsUpdatingPassword(true);
    try {
      const res = await fetch(`${APP_CONFIG.apiBaseUrl}/auth/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          oldPassword,
          newPassword,
          confirmPassword,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.message || "Gagal memperbarui kata sandi.");
      }

      if (data.data?.token) {
        localStorage.setItem("auth_token", data.data.token);
      }

      toast.success(data.message || "Kata sandi akun berhasil diperbarui.");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      toast.error(err.message || "Gagal memperbarui kata sandi.");
    } finally {
      setIsUpdatingPassword(false);
    }
  };

  return (
    <div className="space-y-5 w-full min-w-0 text-left content-fluid">
      {/* Tabs Navigation: Only Notifikasi & Keamanan Akun */}
      <Tabs defaultValue="notifications" className="space-y-5">
        <div className="border-b border-border/60 pb-3">
          <TabsList className="grid w-full sm:w-[320px] grid-cols-2 bg-secondary/40 p-1 rounded-lg">
            <TabsTrigger
              value="notifications"
              className="text-sm font-medium flex items-center justify-center gap-2"
            >
              <Bell className="w-4 h-4" />
              Notifikasi
            </TabsTrigger>
            <TabsTrigger
              value="security"
              className="text-sm font-medium flex items-center justify-center gap-2"
            >
              <Shield className="w-4 h-4" />
              Keamanan Akun
            </TabsTrigger>
          </TabsList>
        </div>

        {/* ========================================================= */}
        {/* TAB 1: NOTIFIKASI SISTEM                                 */}
        {/* ========================================================= */}
        <TabsContent value="notifications" className="space-y-6 outline-hidden">
          <Card className="p-5 sm:p-6 border border-border/80 bg-card shadow-xs rounded-xl">
            <div className="space-y-5">
              {/* Header Section */}
              <div className="flex items-center gap-3 border-b border-border/40 pb-4">
                <div className="w-9 h-9 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                  <Bell className="w-4.5 h-4.5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-foreground">
                    Pengaturan Notifikasi Sistem
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Atur preferensi peringatan otomatis dan notifikasi operasional untuk aktivitas bisnis dan sistem.
                  </p>
                </div>
              </div>

              {/* Toggles List */}
              <div className="space-y-3.5">
                {/* 1. Reminder Tagihan */}
                <div className="flex items-start justify-between p-4 rounded-lg border border-border/60 bg-secondary/15 hover:bg-secondary/25 transition-colors gap-3">
                  <div className="space-y-1 pr-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-foreground">
                        Reminder & Pengingat Tagihan
                      </span>
                      <Badge
                        variant="outline"
                        className="text-[10px] text-emerald-600 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800"
                      >
                        Modul Finance
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Pengingat otomatis untuk tagihan jatuh tempo dan tagihan belum lunas yang memerlukan tindak lanjut penagihan.
                    </p>
                  </div>
                  <Switch
                    checked={settings.notifyTagihanReminder}
                    onCheckedChange={(checked) =>
                      handleToggleNotification("notifyTagihanReminder", checked)
                    }
                    aria-label="Aktifkan Reminder & Pengingat Tagihan"
                  />
                </div>

                {/* 2. Tagihan Baru atau Perubahan Tagihan */}
                <div className="flex items-start justify-between p-4 rounded-lg border border-border/60 bg-secondary/15 hover:bg-secondary/25 transition-colors gap-3">
                  <div className="space-y-1 pr-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-foreground">
                        Tagihan Baru & Perubahan Status Pembayaran
                      </span>
                      <Badge
                        variant="outline"
                        className="text-[10px] text-emerald-600 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800"
                      >
                        Modul Invoice
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Pemberitahuan setiap kali invoice baru diterbitkan, verifikasi bukti transfer, atau pelunasan sisa tagihan tercatat.
                    </p>
                  </div>
                  <Switch
                    checked={settings.notifyTagihanPerubahan}
                    onCheckedChange={(checked) =>
                      handleToggleNotification("notifyTagihanPerubahan", checked)
                    }
                    aria-label="Aktifkan Notifikasi Perubahan Tagihan"
                  />
                </div>

                {/* 3. Update Status Order */}
                <div className="flex items-start justify-between p-4 rounded-lg border border-border/60 bg-secondary/15 hover:bg-secondary/25 transition-colors gap-3">
                  <div className="space-y-1 pr-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-foreground">
                        Update Status Dokumen & Order
                      </span>
                      <Badge
                        variant="outline"
                        className="text-[10px] text-emerald-600 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800"
                      >
                        Modul Order
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Pemberitahuan perubahan progres tahapan dokumen kendaraan (Proses Samsat, Verifikasi, Berkas Siap Ambil, Selesai).
                    </p>
                  </div>
                  <Switch
                    checked={settings.notifyOrderUpdate}
                    onCheckedChange={(checked) =>
                      handleToggleNotification("notifyOrderUpdate", checked)
                    }
                    aria-label="Aktifkan Notifikasi Update Status Order"
                  />
                </div>

                {/* 4. Peringatan Proses Penting yang Gagal */}
                <div className="flex items-start justify-between p-4 rounded-lg border border-border/60 bg-secondary/15 hover:bg-secondary/25 transition-colors gap-3">
                  <div className="space-y-1 pr-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-foreground">
                        Peringatan Proses Penting yang Gagal
                      </span>
                      <Badge
                        variant="outline"
                        className="text-[10px] text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-800"
                      >
                        Sistem & Diagnostik
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Peringatan darurat bila ada proses kritis backend yang gagal, upload berkas legalitas bermasalah, atau timeout integrasi.
                    </p>
                  </div>
                  <Switch
                    checked={settings.notifyProsesGagal}
                    onCheckedChange={(checked) =>
                      handleToggleNotification("notifyProsesGagal", checked)
                    }
                    aria-label="Aktifkan Peringatan Proses Gagal"
                  />
                </div>
              </div>

              {/* Action Bar Simpan Settings */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-4 border-t border-border/40">
                <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    Terakhir disimpan: {new Date(settings.updatedAt).toLocaleString("id-ID")}
                    {settings.updatedBy ? ` oleh ${settings.updatedBy}` : ""}
                  </span>
                </div>
                <Button
                  type="button"
                  onClick={handleSaveNotificationSettings}
                  disabled={isSaving}
                  className="w-full sm:w-auto flex items-center justify-center gap-2 shadow-xs"
                >
                  {isSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  {isSaving ? "Menyimpan..." : "Simpan Pengaturan Notifikasi"}
                </Button>
              </div>
            </div>
          </Card>
        </TabsContent>

        {/* ========================================================= */}
        {/* TAB 2: KEAMANAN AKUN                                     */}
        {/* ========================================================= */}
        <TabsContent value="security" className="space-y-6 outline-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Kolom Utama: Form Ganti Kata Sandi */}
            <div className="lg:col-span-7 xl:col-span-8">
              <Card className="p-5 sm:p-6 border border-border/80 bg-card shadow-xs rounded-xl">
                <form onSubmit={handlePasswordUpdate} className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/40 pb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
                        <Key className="w-4 h-4" />
                      </div>
                      <div>
                        <h3 className="text-base font-semibold text-foreground">
                          Ganti Kata Sandi Akun
                        </h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Perbarui kata sandi akun Anda secara berkala untuk menjaga keamanan sistem.
                        </p>
                      </div>
                    </div>
                    <Badge variant="secondary" className="text-[11px] font-normal w-fit">
                      Wajib Minimal 8 Karakter
                    </Badge>
                  </div>

                  <div className="space-y-3.5 pt-1">
                    <div className="space-y-1.5">
                      <Label htmlFor="old-password" className="text-xs font-medium text-foreground">
                        Kata Sandi Saat Ini
                      </Label>
                      <Input
                        id="old-password"
                        type="password"
                        autoComplete="current-password"
                        placeholder="Masukkan kata sandi saat ini"
                        value={oldPassword}
                        onChange={(e) => setOldPassword(e.target.value)}
                        className="bg-input-background"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="new-password" className="text-xs font-medium text-foreground">
                        Kata Sandi Baru
                      </Label>
                      <Input
                        id="new-password"
                        type="password"
                        autoComplete="new-password"
                        placeholder="Minimal 8 karakter kombinasi huruf dan angka"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className="bg-input-background"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="confirm-new-password" className="text-xs font-medium text-foreground">
                        Konfirmasi Kata Sandi Baru
                      </Label>
                      <Input
                        id="confirm-new-password"
                        type="password"
                        autoComplete="new-password"
                        placeholder="Ulangi kata sandi baru persis sama"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className="bg-input-background"
                      />
                    </div>

                    {/* Persyaratan Kata Sandi Visual Checklist */}
                    <div className="p-3.5 rounded-lg border border-border/60 bg-secondary/15 space-y-2 text-xs text-muted-foreground">
                      <p className="font-medium text-foreground text-[11px] uppercase tracking-wider">
                        Kriteria Kata Sandi yang Kuat:
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              newPassword.length >= 8
                                ? "bg-emerald-500"
                                : "bg-muted-foreground/50"
                            }`}
                          />
                          <span
                            className={
                              newPassword.length >= 8
                                ? "text-emerald-600 dark:text-emerald-400 font-medium"
                                : ""
                            }
                          >
                            Minimal 8 karakter
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              confirmPassword && newPassword === confirmPassword
                                ? "bg-emerald-500"
                                : "bg-muted-foreground/50"
                            }`}
                          />
                          <span
                            className={
                              confirmPassword && newPassword === confirmPassword
                                ? "text-emerald-600 dark:text-emerald-400 font-medium"
                                : ""
                            }
                          >
                            Konfirmasi cocok
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              newPassword && oldPassword && newPassword !== oldPassword
                                ? "bg-emerald-500"
                                : "bg-muted-foreground/50"
                            }`}
                          />
                          <span
                            className={
                              newPassword && oldPassword && newPassword !== oldPassword
                                ? "text-emerald-600 dark:text-emerald-400 font-medium"
                                : ""
                            }
                          >
                            Berbeda dari kata sandi lama
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              /[A-Za-z]/.test(newPassword) && /[0-9]/.test(newPassword)
                                ? "bg-emerald-500"
                                : "bg-muted-foreground/50"
                            }`}
                          />
                          <span
                            className={
                              /[A-Za-z]/.test(newPassword) && /[0-9]/.test(newPassword)
                                ? "text-emerald-600 dark:text-emerald-400 font-medium"
                                : ""
                            }
                          >
                            Kombinasi huruf & angka
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-3 border-t border-border/40">
                    <p className="text-xs text-muted-foreground">
                      Setelah diperbarui, sesi Anda akan tetap aktif secara otomatis.
                    </p>
                    <Button
                      type="submit"
                      disabled={isUpdatingPassword}
                      className="w-full sm:w-auto flex items-center justify-center gap-2 shadow-xs"
                    >
                      {isUpdatingPassword ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Menyimpan...
                        </>
                      ) : (
                        <>
                          <Key className="w-4 h-4" />
                          Perbarui Kata Sandi
                        </>
                      )}
                    </Button>
                  </div>
                </form>
              </Card>
            </div>

            {/* Kolom Pendukung: 2FA & Kebijakan Keamanan */}
            <div className="lg:col-span-5 xl:col-span-4 space-y-5">
              {/* Card 2FA */}
              <Card className="p-5 border border-border/80 bg-card shadow-xs rounded-xl">
                <div className="space-y-3.5">
                  <div className="flex items-center gap-2.5 border-b border-border/40 pb-3">
                    <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                      <Shield className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-foreground">
                        Autentikasi Dua Faktor (2FA)
                      </h4>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Lapisan perlindungan keamanan ekstra
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start justify-between gap-3 p-3 rounded-lg bg-secondary/15 border border-border/60">
                    <div className="space-y-0.5 pr-2">
                      <p className="text-xs font-medium text-foreground">Aktifkan Verifikasi OTP</p>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Minta kode verifikasi OTP setiap login untuk akun level Administrator & Super Admin.
                      </p>
                    </div>
                    <Switch
                      checked={is2FAEnabled}
                      onCheckedChange={(checked) => {
                        setIs2FAEnabled(checked);
                        toast.info(
                          checked
                            ? "Preferensi 2FA OTP telah diaktifkan untuk sesi ini."
                            : "Preferensi 2FA OTP dinonaktifkan."
                        );
                      }}
                      aria-label="Aktifkan autentikasi dua faktor (2FA)"
                    />
                  </div>
                </div>
              </Card>

              {/* Card Panduan Keamanan */}
              <Card className="p-5 border border-border/80 bg-card shadow-xs rounded-xl">
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-foreground font-semibold text-sm">
                    <Info className="w-4 h-4 text-primary shrink-0" />
                    <span>Kebijakan Keamanan Akun</span>
                  </div>
                  <ul className="space-y-2 text-xs text-muted-foreground">
                    <li className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mt-1.5" />
                      <span>Jangan gunakan kata sandi yang sama dengan akun pribadi lain.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mt-1.5" />
                      <span>Ganti kata sandi secara berkala setiap 90 hari untuk mitigasi risiko.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mt-1.5" />
                      <span>Segera lakukan logout setelah selesai menggunakan komputer bersama.</span>
                    </li>
                  </ul>
                </div>
              </Card>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
