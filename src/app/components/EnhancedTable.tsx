import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Plus,
  Download,
  Edit,
  Trash2,
  FileText,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { TablePagination } from "./ui/TablePagination";
import { DataTableShell, DataTableToolbar, DataTableEmptyRow } from "./ui/data-table";
import { cn } from "./ui/utils";

export interface ColumnDef {
  key: string;
  label: string;
  width?: string;
  align?: "left" | "center" | "right";
  filterable?: boolean;
  filterType?: string;
  [key: string]: any;
}

export type Column = ColumnDef;

interface EnhancedTableProps {
  columns: ColumnDef[];
  data: any[];
  showRowNumber?: boolean;
  onAdd?: () => void;
  onEdit?: (item: any) => void;
  onDelete?: (item: any) => void;
  onView?: (item: any) => void;
  onExport?: (format: 'csv' | 'pdf', filteredData: any[]) => void;
  searchPlaceholder?: string;
  itemsPerPageOptions?: number[];
  filterSlot?: React.ReactNode;
}

export function EnhancedTable({
  columns,
  data,
  showRowNumber = true,
  onAdd,
  onEdit,
  onDelete,
  onExport,
  searchPlaceholder = "Cari data...",
  itemsPerPageOptions = [10, 25, 50, 100],
  filterSlot
}: EnhancedTableProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(itemsPerPageOptions.includes(25) ? 25 : itemsPerPageOptions[0]);

  // Filter data based on search
  const filteredData = data.filter(item =>
    Object.values(item).some(value =>
      String(value).toLowerCase().includes(searchTerm.toLowerCase())
    )
  );

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredData.length / itemsPerPage));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const startIndex = (safeCurrentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedData = filteredData.slice(startIndex, endIndex);

  const formatValue = (value: any, key: string) => {
    if (value === null || value === undefined || value === "") return "-";
    
    // Format currency
    if (typeof value === "number" && (key.toLowerCase().includes("uang") || key.toLowerCase().includes("biaya") || key.toLowerCase().includes("profit") || key.toLowerCase().includes("cashback") || key.toLowerCase().includes("gaji"))) {
      const formatted = value.toLocaleString("id-ID");
      if (value < 0) {
        return <span className="font-mono tabular-nums text-rose-600 dark:text-rose-400 font-medium">-Rp {Math.abs(value).toLocaleString("id-ID")}</span>;
      } else if (key.toLowerCase().includes("profit") || key.toLowerCase().includes("masuk")) {
        return <span className="font-mono tabular-nums text-emerald-600 dark:text-emerald-400 font-medium">Rp {formatted}</span>;
      } else if (key.toLowerCase().includes("keluar") || key.toLowerCase().includes("biaya")) {
        return <span className="font-mono tabular-nums text-rose-500 dark:text-rose-400 font-medium">Rp {formatted}</span>;
      }
      return <span className="font-mono tabular-nums text-foreground font-medium">Rp {formatted}</span>;
    }
    
    // Format status and jabatan badges (exclude non-badge fields: jenis layanan, wilayah, dll)
    const lowerKey = key.toLowerCase();
    const isExcluded = lowerKey.includes("layanan") || lowerKey.includes("wilayah") || lowerKey.includes("kantor");
    
    if (!isExcluded && (lowerKey.includes("status") || lowerKey.includes("jabatan"))) {
      return <Badge status={value}>{value}</Badge>;
    }
    
    return value;
  };

  const getColAlignment = (col: ColumnDef) => {
    if (col.align) return col.align;
    const k = col.key.toLowerCase();
    if (k.includes("uang") || k.includes("biaya") || k.includes("profit") || k.includes("gaji") || k.includes("nominal") || k.includes("total")) {
      return "right";
    }
    if (k.includes("status") || k.includes("jabatan") || k === "no" || k === "nik" || k === "id" || k.includes("tgl") || k.includes("tanggal")) {
      return "center";
    }
    return "left";
  };

  const handleResetSearch = () => {
    setSearchTerm("");
    setCurrentPage(1);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 space-y-3">
      {/* Standardized Table Toolbar */}
      <DataTableToolbar
        searchValue={searchTerm}
        onSearchChange={(value) => {
          setSearchTerm(value);
          setCurrentPage(1);
        }}
        searchPlaceholder={searchPlaceholder}
        showReset={Boolean(searchTerm)}
        onReset={handleResetSearch}
        left={filterSlot}
        right={
          <>
            {onAdd && (
              <Button size="sm" onClick={onAdd} className="bg-primary hover:bg-primary/90 h-8 text-xs gap-1.5">
                <Plus className="w-3.5 h-3.5" />
                <span>Tambah</span>
              </Button>
            )}
            {onExport && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="border-border h-8 text-xs gap-1.5">
                    <Download className="w-3.5 h-3.5" />
                    <span>Export</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => onExport('csv', filteredData)} className="text-xs">
                    <FileText className="w-3.5 h-3.5 mr-2" />
                    Export CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onExport('pdf', filteredData)} className="text-xs">
                    <FileText className="w-3.5 h-3.5 mr-2" />
                    Export PDF
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />

      {/* Standardized Table Shell + Pagination */}
      <DataTableShell
        footer={
          <TablePagination
            currentPage={currentPage}
            totalItems={filteredData.length}
            itemsPerPage={itemsPerPage}
            onPageChange={setCurrentPage}
            onItemsPerPageChange={(newSize) => {
              setItemsPerPage(newSize);
              setCurrentPage(1);
            }}
            pageSizeOptions={itemsPerPageOptions}
          />
        }
      >
        <Table
          containerClassName="overflow-y-auto overflow-x-auto max-h-[calc(100vh-270px)] sm:max-h-[calc(100vh-280px)] min-h-[160px]"
          className={`w-full min-w-[550px] ${paginatedData.length === 0 ? "h-full" : ""}`}
        >
          <TableHeader className="sticky top-0 z-10 bg-card border-b border-border shadow-2xs">
            <TableRow className="hover:bg-transparent">
              {showRowNumber && (
                <TableHead className="w-[50px] text-center text-xs h-9 font-semibold text-foreground/80 bg-card px-2">
                  No
                </TableHead>
              )}
              {columns.map(col => {
                const align = getColAlignment(col);
                const alignClass = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
                return (
                  <TableHead
                    key={col.key}
                    style={col.width ? { width: col.width } : undefined}
                    className={cn(
                      "h-9 px-3.5 text-xs font-semibold text-foreground/80 bg-card",
                      alignClass
                    )}
                  >
                    {col.label}
                  </TableHead>
                );
              })}
              {(onEdit || onDelete) && (
                <TableHead className="text-center h-9 px-2 text-xs font-semibold text-foreground/80 w-[80px] bg-card">
                  Aksi
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedData.length === 0 ? (
              <DataTableEmptyRow
                colSpan={columns.length + (showRowNumber ? 1 : 0) + (onEdit || onDelete ? 1 : 0)}
                title="Tidak ada data ditemukan"
                description="Belum ada data yang cocok dengan kriteria pencarian atau filter saat ini."
              />
            ) : (
              paginatedData.map((item, idx) => (
                <TableRow
                  key={item.id ?? idx}
                  className="hover:bg-muted/30 transition-colors border-b border-border/60 last:border-0 h-10"
                >
                  {showRowNumber && (
                    <TableCell className="w-[50px] text-center text-xs text-muted-foreground font-mono px-2 py-2 align-middle">
                      {startIndex + idx + 1}
                    </TableCell>
                  )}
                  {columns.map(col => {
                    const align = getColAlignment(col);
                    const alignClass = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
                    return (
                      <TableCell
                        key={col.key}
                        style={col.width ? { width: col.width } : undefined}
                        className={cn("px-3.5 py-2 text-xs align-middle", alignClass)}
                      >
                        {formatValue(item[col.key], col.key)}
                      </TableCell>
                    );
                  })}
                  {(onEdit || onDelete) && (
                    <TableCell className="text-center px-2 py-1.5 align-middle w-[80px]">
                      <div className="flex gap-1 justify-center items-center">
                        {onEdit && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => onEdit(item)}
                            className="finance-action-btn h-7 w-7 text-muted-foreground hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-500/10"
                            aria-label="Edit data"
                            title="Edit data"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        {onDelete && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => onDelete(item)}
                            className="finance-action-btn h-7 w-7 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10"
                            aria-label="Hapus data"
                            title="Hapus data"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </DataTableShell>
    </div>
  );
}
