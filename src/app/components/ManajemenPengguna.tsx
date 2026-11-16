import { useState, useMemo } from "react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Badge } from "./ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { TablePagination } from "./ui/TablePagination";
import { DataTableShell, DataTableEmptyRow } from "./ui/data-table";
import { Search, Eye, KeyRound, CheckCircle2, UserCheck, UserX, Shield, Copy, Check, RotateCcw, AlertTriangle, RefreshCw, Loader2, Trash2 } from "lucide-react";
import { PermanentErasureDialog } from "./PermanentErasureDialog";
import { toast } from "sonner";
import { useKaryawanPengguna, PenggunaRecord, karyawanPenggunaAdapter } from "../data/karyawanPenggunaAdapter";
import { cn } from "./ui/utils";

export function ManajemenPengguna() {
  const { pengguna, isPenggunaLoading: isLoading, penggunaError: error, isPenggunaStale: isStale, refresh: refreshUsers, activateAccount, deactivateAccount, resetPassword } = useKaryawanPengguna();
  const refresh = () => refreshUsers({ target: "users" });

  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterJabatan, setFilterJabatan] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);

  // Dialog States
  const [selectedUser, setSelectedUser] = useState<PenggunaRecord | null>(null);
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [isDeactivateDialogOpen, setIsDeactivateDialogOpen] = useState(false);
  const [isResetPasswordDialogOpen, setIsResetPasswordDialogOpen] = useState(false);
  const [isErasureDialogOpen, setIsErasureDialogOpen] = useState(false);
  const [selectedUserForErasure, setSelectedUserForErasure] = useState<PenggunaRecord | null>(null);
  const [resetSuccessData, setResetSuccessData] = useState<{ user: PenggunaRecord; newPassword: string } | null>(null);
  const [copiedPassword, setCopiedPassword] = useState(false);

  const isAdministrator = useMemo(() => {
    try {
      const stored = localStorage.getItem("auth_user");
      const authUser = stored ? JSON.parse(stored) : null;
      const role = (authUser?.role || authUser?.jabatan || "").toLowerCase();
      return role === "administrator" || role === "admin" || !stored;
    } catch {
      return true;
    }
  }, []);

  const handleOpenErasureDialog = (user: PenggunaRecord) => {
    setSelectedUserForErasure(user);
    setIsErasureDialogOpen(true);
  };

  // DATA PIPELINE: Raw -> Filter & Search -> Pagination -> Render
  const filteredData = useMemo(() => {
    return pengguna.filter((item) => {
      const matchSearch =
        searchTerm === "" ||
        item.nama.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (item.employeeId ? item.employeeId.toLowerCase().includes(searchTerm.toLowerCase()) : false);

      const matchStatus = filterStatus === "all" || item.statusAkun === filterStatus;
      const matchJabatan = filterJabatan === "all" || item.jabatan === filterJabatan;

      return matchSearch && matchStatus && matchJabatan;
    });
  }, [pengguna, searchTerm, filterStatus, filterJabatan]);

  const handleResetFilters = () => {
    setSearchTerm("");
    setFilterStatus("all");
    setFilterJabatan("all");
    setCurrentPage(1);
  };

  const hasActiveFilters = Boolean(searchTerm || filterStatus !== "all" || filterJabatan !== "all");

  // Pagination calculation
  const totalPages = Math.max(1, Math.ceil(filteredData.length / itemsPerPage));
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedData = filteredData.slice(startIndex, startIndex + itemsPerPage);

  // Handlers
  const handleSearchChange = (val: string) => {
    setSearchTerm(val);
    setCurrentPage(1);
  };

  const handleStatusFilterChange = (val: string) => {
    setFilterStatus(val);
    setCurrentPage(1);
  };

  const handleJabatanFilterChange = (val: string) => {
    setFilterJabatan(val);
    setCurrentPage(1);
  };

  const handlePageSizeChange = (newSize: number) => {
    setItemsPerPage(newSize);
    setCurrentPage(1);
  };

  const handleActivateClick = (user: PenggunaRecord) => {
    activateAccount(user.id);
    toast.success(`Akun ${user.nama} berhasil diaktifkan.`);
  };

  const handleOpenDeactivateDialog = (user: PenggunaRecord) => {
    setSelectedUser(user);
    setIsDeactivateDialogOpen(true);
  };

  const handleConfirmDeactivate = () => {
    if (selectedUser) {
      deactivateAccount(selectedUser.id);
      toast.info(`Akun ${selectedUser.nama} dinonaktifkan.`);
      setIsDeactivateDialogOpen(false);
      setSelectedUser(null);
    }
  };

  const handleOpenResetDialog = (user: PenggunaRecord) => {
    setSelectedUser(user);
    setIsResetPasswordDialogOpen(true);
  };

  const handleConfirmResetPassword = async () => {
    if (selectedUser) {
      const res = await resetPassword(selectedUser.id);
      setIsResetPasswordDialogOpen(false);

      if (res.success && res.newPassword) {
        setResetSuccessData({
          user: selectedUser,
          newPassword: res.newPassword,
        });
        toast.success(`Kata sandi akun ${selectedUser.nama} berhasil direset.`);
      } else {
        toast.error(res.error || "Gagal mereset kata sandi.");
      }
      setSelectedUser(null);
    }
  };

  const handleCopyPassword = () => {
    if (resetSuccessData) {
      navigator.clipboard.writeText(resetSuccessData.newPassword);
      setCopiedPassword(true);
      setTimeout(() => setCopiedPassword(false), 2000);
      toast.success("Password tersalin ke clipboard!");
    }
  };

  const handleViewUser = (user: PenggunaRecord) => {
    setSelectedUser(user);
    setIsViewDialogOpen(true);
  };

  const getStatusBadge = (status: PenggunaRecord["statusAkun"]) => {
    return <Badge status={status}>{status}</Badge>;
  };

  if (isLoading && pengguna.length === 0) {
    return (
      <div className="flex-1 flex flex-col min-h-0 space-y-4 w-full min-w-0 text-left content-fluid">
        <Card className="p-8 border border-border/80 bg-card shadow-xs flex-1 flex flex-col items-center justify-center text-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary mb-3" />
          <p className="text-sm font-medium text-foreground">Memuat data pengguna dari database...</p>
          <p className="text-xs text-muted-foreground mt-1">Menghubungkan ke API server...</p>
        </Card>
      </div>
    );
  }

  if (error && pengguna.length === 0) {
    return (
      <div className="flex-1 flex flex-col min-h-0 space-y-4 w-full min-w-0 text-left content-fluid">
        <Card className="p-8 border border-red-500/20 bg-red-500/5 shadow-xs flex-1 flex flex-col items-center justify-center text-center">
          <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 mb-3">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-foreground">Gagal Memuat Data Pengguna</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refresh()}
            className="mt-4 gap-2 border-border text-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Coba Lagi</span>
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 space-y-4 w-full min-w-0 text-left content-fluid">
      <Card className="p-4 sm:p-5 border border-border/80 bg-card shadow-xs flex-1 flex flex-col min-h-0 space-y-3 w-full">
        {isStale && (
          <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-between text-xs text-amber-700 dark:text-amber-400">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                <strong>Peringatan Sinkronisasi:</strong> Gagal memperbarui data dari server ({error}). Menampilkan data cache lokal terakhir.
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refresh()}
              className="h-7 text-xs gap-1 hover:bg-amber-500/20"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Coba Sinkron Ulang
            </Button>
          </div>
        )}
        {/* COMPACT TOOLBAR (Judul, Search, Filters — strictly derived from Karyawan HR master) */}
        <div className="flex flex-col md:flex-row gap-2.5 justify-between items-stretch md:items-center shrink-0">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Cari nama, email, atau NIK/ID karyawan..."
              className="pl-8 bg-background border-border h-8 text-xs font-normal placeholder:text-muted-foreground/65"
              value={searchTerm}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={filterStatus} onValueChange={handleStatusFilterChange}>
              <SelectTrigger size="sm" className="w-[140px] bg-background border-border h-8 text-xs">
                <SelectValue placeholder="Semua Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">Semua Status</SelectItem>
                <SelectItem value="Aktif" className="text-xs">Aktif</SelectItem>
                <SelectItem value="Nonaktif" className="text-xs">Nonaktif</SelectItem>
                <SelectItem value="Belum Aktif" className="text-xs">Belum Aktif</SelectItem>
              </SelectContent>
            </Select>

            <Select value={filterJabatan} onValueChange={handleJabatanFilterChange}>
              <SelectTrigger size="sm" className="w-[140px] bg-background border-border h-8 text-xs">
                <SelectValue placeholder="Semua Jabatan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">Semua Jabatan</SelectItem>
                <SelectItem value="ADMIN" className="text-xs">ADMIN</SelectItem>
                <SelectItem value="FINANCE" className="text-xs">FINANCE</SelectItem>
                <SelectItem value="SVP" className="text-xs">SVP</SelectItem>
                <SelectItem value="MESSENGER" className="text-xs">MESSENGER</SelectItem>
                <SelectItem value="CLILEN" className="text-xs">CLILEN</SelectItem>
              </SelectContent>
            </Select>

            {hasActiveFilters && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetFilters}
                className="border-border text-xs h-8 px-2.5 gap-1 text-muted-foreground hover:text-foreground shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </Button>
            )}
          </div>
        </div>

        {/* RESPONSIVE TABLE WRAPPER (Fill Width, horizontal scrollable if needed) */}
        <DataTableShell
          className="w-full"
          footer={
            <TablePagination
              currentPage={currentPage}
              totalItems={filteredData.length}
              itemsPerPage={itemsPerPage}
              onPageChange={setCurrentPage}
              onItemsPerPageChange={handlePageSizeChange}
              pageSizeOptions={[10, 25, 50, 100]}
            />
          }
        >
          <Table 
            containerClassName="overflow-y-auto overflow-x-auto max-h-[calc(100vh-270px)] sm:max-h-[calc(100vh-280px)] min-h-[160px]"
            className={cn("w-full min-w-[700px]", paginatedData.length === 0 && "h-full")}
          >
            <TableHeader className="sticky top-0 z-10 bg-card border-b border-border shadow-2xs">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[50px] text-center text-xs h-9 font-semibold text-foreground/80 bg-card px-2">No</TableHead>
                <TableHead className="min-w-[160px] text-left text-xs h-9 font-semibold text-foreground/80 bg-card px-3.5">Nama</TableHead>
                <TableHead className="w-[110px] text-center text-xs h-9 font-semibold text-foreground/80 bg-card px-3.5">Jabatan</TableHead>
                <TableHead className="min-w-[180px] text-left text-xs h-9 font-semibold text-foreground/80 bg-card px-3.5">Username / Email</TableHead>
                <TableHead className="w-[100px] text-center text-xs h-9 font-semibold text-foreground/80 bg-card px-3.5">Role</TableHead>
                <TableHead className="w-[110px] text-center text-xs h-9 font-semibold text-foreground/80 bg-card px-3.5">Status Akun</TableHead>
                <TableHead className="w-[130px] text-center text-xs h-9 font-semibold text-foreground/80 bg-card px-3.5">Terakhir Login</TableHead>
                <TableHead className="w-[140px] text-center text-xs h-9 font-semibold text-foreground/80 bg-card px-2">Aksi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedData.length > 0 ? (
                paginatedData.map((item, index) => {
                  const globalIndex = startIndex + index + 1;
                  return (
                    <TableRow
                      key={item.id}
                      className="hover:bg-muted/30 transition-colors border-b border-border/60 last:border-0 h-10"
                    >
                      <TableCell className="w-[50px] text-center text-xs text-muted-foreground font-mono px-2 py-2 align-middle">
                        {globalIndex}
                      </TableCell>
                      <TableCell className="px-3.5 py-2 text-xs align-middle text-left">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-medium text-foreground truncate">{item.nama}</span>
                          {item.employeeId ? (
                            <span className="text-[11px] text-muted-foreground font-mono shrink-0">
                              ({item.employeeId})
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground/60 italic shrink-0">
                              (Non-Pegawai)
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="w-[110px] px-3.5 py-2 text-xs text-center align-middle">
                        <Badge status={item.jabatan}>
                          {item.jabatan}
                        </Badge>
                      </TableCell>
                      <TableCell className="px-3.5 py-2 text-xs text-foreground/90 align-middle text-left">
                        {item.email}
                      </TableCell>
                      <TableCell className="w-[100px] px-3.5 py-2 text-xs capitalize text-foreground/80 text-center align-middle">
                        {item.role}
                      </TableCell>
                      <TableCell className="w-[110px] px-3.5 py-2 text-center text-xs align-middle">
                        {getStatusBadge(item.statusAkun)}
                      </TableCell>
                      <TableCell className="w-[130px] px-3.5 py-2 text-xs text-muted-foreground text-center align-middle">
                        {item.terakhirLogin}
                      </TableCell>
                      <TableCell className="w-[140px] px-2 py-1.5 text-center text-xs align-middle">
                        <div className="flex items-center justify-center gap-1">
                          {/* Toggle Status Button */}
                          {item.statusAkun === "Aktif" ? (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              onClick={() => handleOpenDeactivateDialog(item)}
                              className="finance-action-btn h-7 w-7 text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-500/10"
                              aria-label={`Nonaktifkan akun ${item.nama}`}
                              title="Nonaktifkan akun pengguna"
                            >
                              <UserX className="w-3.5 h-3.5" />
                            </Button>
                          ) : (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              onClick={() => handleActivateClick(item)}
                              className="finance-action-btn h-7 w-7 text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10"
                              aria-label={`Aktifkan akun ${item.nama}`}
                              title="Aktifkan akun pengguna"
                            >
                              <UserCheck className="w-3.5 h-3.5" />
                            </Button>
                          )}

                          {/* Reset Password Button */}
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => handleOpenResetDialog(item)}
                            className="finance-action-btn h-7 w-7 text-muted-foreground hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-500/10"
                            aria-label={`Reset password ${item.nama}`}
                            title="Reset kata sandi menggunakan tanggal lahir (DDMMYYYY)"
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                          </Button>

                          {/* View Detail Button */}
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={() => handleViewUser(item)}
                            className="finance-action-btn h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                            aria-label={`Lihat rincian akun ${item.nama || item.email || ""}`.trim()}
                            title="Lihat rincian akun"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </Button>

                          {/* Permanent Erasure Button (Administrator Only) */}
                          {isAdministrator && (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              onClick={() => handleOpenErasureDialog(item)}
                              className="finance-action-btn h-7 w-7 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10"
                              aria-label={`Hapus permanen akun ${item.nama}`}
                              title="Hapus permanen akun pengguna dan data master"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <DataTableEmptyRow
                  colSpan={8}
                  icon={UserX}
                  title="Data Pengguna Tidak Ditemukan"
                  description={
                    searchTerm
                      ? `Tidak ditemukan akun pengguna yang cocok dengan "${searchTerm}".`
                      : "Belum ada akun pengguna yang terdaftar atau sesuai dengan filter yang dipilih."
                  }
                />
              )}
            </TableBody>
          </Table>
        </DataTableShell>
      </Card>

      {/* CONFIRMATION DIALOG: DEACTIVATE ACCOUNT */}
      <AlertDialog open={isDeactivateDialogOpen} onOpenChange={setIsDeactivateDialogOpen}>
        <AlertDialogContent className="border-border sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base font-semibold">Nonaktifkan Akun Pengguna?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground">
              Apakah Anda yakin ingin menonaktifkan akun untuk{" "}
              <strong className="text-foreground">{selectedUser?.nama}</strong>? Pengguna ini tidak akan dapat login atau
              mengakses sistem sampai diaktifkan kembali. Data karyawan tetap aman dan tidak terhapus.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-4 gap-2">
            <AlertDialogCancel className="h-8 text-xs">Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDeactivate}
              className="h-8 text-xs bg-amber-600 hover:bg-amber-700 text-white shadow-xs font-semibold"
            >
              Nonaktifkan Akun
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* CONFIRMATION DIALOG: RESET PASSWORD (DDMMYYYY Requirement) */}
      <AlertDialog open={isResetPasswordDialogOpen} onOpenChange={setIsResetPasswordDialogOpen}>
        <AlertDialogContent className="border-border sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base font-semibold">Reset Kata Sandi</AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground space-y-2">
              <p>
                Apakah Anda yakin ingin mereset kata sandi akun{" "}
                <strong className="text-foreground">{selectedUser?.nama}</strong>?
              </p>
              <p className="p-2.5 rounded-lg bg-muted/40 border border-border/60 text-[11px] text-foreground">
                Password akan direset menggunakan tanggal lahir karyawan dengan format{" "}
                <strong className="font-mono text-primary">DDMMYYYY</strong>.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-4 gap-2">
            <AlertDialogCancel className="h-8 text-xs">Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmResetPassword}
              className="h-8 text-xs bg-primary hover:bg-primary/90 text-primary-foreground shadow-xs font-semibold"
            >
              Reset Kata Sandi
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* SUCCESS MODAL: RESET PASSWORD RESULT */}
      <Dialog open={!!resetSuccessData} onOpenChange={(open) => !open && setResetSuccessData(null)}>
        <DialogContent className="border-border sm:max-w-md p-5 bg-card">
          <DialogHeader className="text-center sm:text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mb-2">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <DialogTitle className="text-base font-semibold">Kata Sandi Berhasil Direset</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Kata sandi akun {resetSuccessData?.user.nama} telah direset menggunakan format tanggal lahir karyawan.
            </DialogDescription>
          </DialogHeader>

          {resetSuccessData && (
            <div className="my-3 p-3.5 rounded-lg border border-border/70 bg-muted/20 space-y-2 text-xs">
              <div className="flex justify-between items-center pb-2 border-b border-border/50">
                <span className="text-muted-foreground">Nama Pengguna</span>
                <span className="font-medium text-foreground">{resetSuccessData.user.nama}</span>
              </div>
              <div className="flex justify-between items-center pb-2 border-b border-border/50">
                <span className="text-muted-foreground">ID Karyawan</span>
                <span className="font-mono font-medium text-foreground">{resetSuccessData.user.employeeId || "-"}</span>
              </div>
              <div className="flex justify-between items-center pt-1">
                <span className="text-muted-foreground font-medium">Password Baru (DDMMYYYY)</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-base text-primary bg-primary/10 px-2 py-0.5 rounded border border-primary/20">
                    {resetSuccessData.newPassword}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleCopyPassword}
                    className="h-7 w-7 p-0"
                    title="Salin password"
                  >
                    {copiedPassword ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  </Button>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="sm:justify-center">
            <Button
              className="w-full h-8.5 text-xs bg-primary hover:bg-primary/90 text-primary-foreground shadow-xs font-semibold"
              onClick={() => setResetSuccessData(null)}
            >
              Tutup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DETAIL MODAL */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent className="border-border sm:max-w-md p-5 bg-card">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Rincian Akun Pengguna</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Informasi data akun dan keterkaitan dengan master Karyawan
            </DialogDescription>
          </DialogHeader>

          {selectedUser && (
            <div className="my-3 space-y-2.5 text-xs">
              <div className="grid grid-cols-2 gap-2 p-3 rounded-lg border border-border/70 bg-muted/20">
                <div>
                  <p className="text-[11px] text-muted-foreground">ID Akun</p>
                  <p className="font-mono font-semibold text-foreground">{selectedUser.id}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">ID Karyawan</p>
                  <p className="font-mono font-semibold text-foreground">
                    {selectedUser.employeeId || <span className="text-muted-foreground font-normal italic">Tidak Terhubung (Non-Pegawai)</span>}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Nama Lengkap</p>
                  <p className="font-medium text-foreground">{selectedUser.nama}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Jabatan</p>
                  <p className="font-medium text-foreground">{selectedUser.jabatan}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-[11px] text-muted-foreground">Username / Email</p>
                  <p className="font-mono text-foreground">{selectedUser.email}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Role Akses</p>
                  <p className="capitalize font-medium text-foreground">{selectedUser.role}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Status Akun</p>
                  <div className="mt-0.5">{getStatusBadge(selectedUser.statusAkun)}</div>
                </div>
                <div className="col-span-2">
                  <p className="text-[11px] text-muted-foreground">Terakhir Login</p>
                  <p className="font-mono text-foreground">{selectedUser.terakhirLogin}</p>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              className="w-full h-8 text-xs"
              onClick={() => setIsViewDialogOpen(false)}
            >
              Tutup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* PERMANENT ERASURE DIALOG FOR PENGGUNA */}
      <PermanentErasureDialog
        open={isErasureDialogOpen}
        onOpenChange={setIsErasureDialogOpen}
        targetId={selectedUserForErasure?.id || selectedUserForErasure?.employeeId || null}
        targetName={selectedUserForErasure?.nama}
        onErasureSuccess={() => {
          refresh();
        }}
      />
    </div>
  );
}
