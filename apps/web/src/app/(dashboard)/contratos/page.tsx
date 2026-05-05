"use client";

import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { useSearchParams, useRouter } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus,
  Search,
  FileText,
  MoreVertical,
  Upload,
  Pencil,
  Trash2,
  DollarSign,
  CalendarClock,
  ClipboardList,
  CheckCircle2,
  Files,
  Download,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ContractForm } from "@/components/forms/contract-form";
import { UploadPdf } from "@/components/forms/upload-pdf";
import { BatchUploadPdf } from "@/components/forms/batch-upload-pdf";
import { ImportSpreadsheet } from "@/components/forms/import-spreadsheet";
import { ImportContractPdf } from "@/components/forms/import-contract-pdf";
import { FileSpreadsheet, FileSearch } from "lucide-react";
import Link from "next/link";
import { useContextMenu } from "@/components/ui/context-menu-custom";
import { ExternalLink, Eye } from "lucide-react";

interface Contract {
  id: string;
  code: string;
  type: string;
  status: string;
  propertyId: string;
  ownerId: string;
  tenantId: string;
  rentalValue: number;
  adminFeePercent: number;
  paymentDay: number;
  startDate: string;
  endDate: string;
  guaranteeType: string | null;
  guaranteeValue: number | null;
  guaranteeNotes: string | null;
  adjustmentIndex: string | null;
  adjustmentMonth: number | null;
  notes: string | null;
  property: { id: string; title: string };
  owner: { id: string; name: string };
  tenant: { id: string; name: string };
  createdBy: { id: string; name: string } | null;
}

const statusConfig: Record<string, { label: string; className: string }> = {
  ATIVO: { label: "Ativo", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  PENDENTE_RENOVACAO: { label: "Renovação", className: "bg-amber-100 text-amber-700 border-amber-200" },
  ENCERRADO: { label: "Encerrado", className: "bg-muted text-muted-foreground" },
  CANCELADO: { label: "Cancelado", className: "bg-red-100 text-red-700 border-red-200" },
};

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
}

export default function ContratosPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-12"><p className="text-sm text-muted-foreground">Carregando...</p></div>}>
      <ContratosContent />
    </Suspense>
  );
}

function ContratosContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [activeTab, setActiveTab] = useState("todos");
  const [guaranteeFilter, setGuaranteeFilter] = useState("all");
  const [formOpen, setFormOpen] = useState(false);
  const [selectedContract, setSelectedContract] = useState<Contract | undefined>(undefined);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [contractToDelete, setContractToDelete] = useState<Contract | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [batchUploadOpen, setBatchUploadOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importContractPdfOpen, setImportContractPdfOpen] = useState(false);
  const [openCtxMenu, CtxMenuPortal] = useContextMenu();
  // Paginacao server-side
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalEntries, setTotalEntries] = useState(0);
  const [stats, setStats] = useState({
    totalContracts: 0,
    activeContracts: 0,
    totalMonthlyValue: 0,
    expiringIn30Days: 0,
  });

  function tabToStatus(tab: string): string | null {
    if (tab === "ativos") return "ATIVO";
    if (tab === "encerrados") return "ENCERRADO";
    if (tab === "renovacao") return "PENDENTE_RENOVACAO";
    return null;
  }

  async function fetchContracts() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      const status = tabToStatus(activeTab);
      if (status) params.set("status", status);
      if (guaranteeFilter !== "all") params.set("guaranteeType", guaranteeFilter);
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      const response = await fetch(`/api/contracts?${params.toString()}`);
      if (response.ok) {
        const data = await response.json();
        setContracts(data.data || []);
        setTotalPages(data.pagination?.totalPages || 1);
        setTotalEntries(data.pagination?.total || 0);
      }
    } catch (error) {
      console.error("Erro ao buscar contratos:", error);
      toast.error("Erro ao carregar contratos");
    } finally {
      setLoading(false);
    }
  }

  async function fetchStats() {
    try {
      const res = await fetch("/api/contracts/stats");
      if (res.ok) {
        const data = await res.json();
        setStats({
          totalContracts: data.totalContracts || 0,
          activeContracts: data.activeContracts || 0,
          totalMonthlyValue: data.totalMonthlyValue || 0,
          expiringIn30Days: data.expiringIn30Days || 0,
        });
      }
    } catch (error) {
      console.error("Erro ao buscar stats:", error);
    }
  }

  async function refresh() {
    await Promise.all([fetchContracts(), fetchStats()]);
  }

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [activeTab, guaranteeFilter, debouncedSearch]);

  useEffect(() => {
    fetchStats();
  }, []);

  useEffect(() => {
    fetchContracts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, activeTab, guaranteeFilter, debouncedSearch]);

  useEffect(() => {
    if (searchParams.get("novo") === "true") {
      setSelectedContract(undefined);
      setFormOpen(true);
      router.replace("/contratos");
    }
  }, [searchParams, router]);

  // Servidor ja filtrou — `contracts` ja sao as linhas da pagina atual
  const filteredContracts = contracts;
  const { totalContracts, activeContracts, totalMonthlyValue, expiringIn30Days } = stats;

  function handleNewContract() {
    setSelectedContract(undefined);
    setFormOpen(true);
  }

  function handleEditContract(contract: Contract) {
    setSelectedContract(contract);
    setFormOpen(true);
  }

  function handleDeleteClick(contract: Contract) {
    setContractToDelete(contract);
    setDeleteDialogOpen(true);
  }

  async function handleDeleteConfirm() {
    if (!contractToDelete) return;
    try {
      const response = await fetch(`/api/contracts/${contractToDelete.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || "Erro ao excluir contrato");
        return;
      }
      refresh();
    } catch (error) {
      toast.error("Erro ao excluir contrato");
    } finally {
      setDeleteDialogOpen(false);
      setContractToDelete(null);
    }
  }

  function handleFormSuccess() {
    refresh();
  }

  return (
    <div className="flex flex-col">
      <Header title="Contratos" subtitle="Gerencie contratos de locação e venda" />

      <div className="p-4 sm:p-6 space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            {
              label: "Total Contratos",
              value: loading ? "..." : String(totalContracts),
              icon: ClipboardList,
              color: "text-primary",
            },
            {
              label: "Ativos",
              value: loading ? "..." : String(activeContracts),
              icon: CheckCircle2,
              color: "text-emerald-600",
            },
            {
              label: "Valor Total Mensal",
              value: loading ? "..." : formatCurrency(totalMonthlyValue),
              icon: DollarSign,
              color: "text-primary",
            },
            {
              label: "Vencendo em 30 dias",
              value: loading ? "..." : String(expiringIn30Days),
              icon: CalendarClock,
              color: "text-amber-600",
            },
          ].map((stat) => (
            <Card key={stat.label} className="border-0 shadow-sm">
              <CardContent className="p-4">
                <p className="text-xs font-medium text-muted-foreground">{stat.label}</p>
                <p className={cn("text-xl font-bold mt-1", stat.color)}>{stat.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Table */}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-0">
            <div className="flex flex-col gap-3 p-4 border-b">
              <div className="flex items-center justify-between">
                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-auto">
                  <TabsList className="h-9 sm:h-8">
                    <TabsTrigger value="todos" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">Todos</TabsTrigger>
                    <TabsTrigger value="ativos" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">Ativos</TabsTrigger>
                    <TabsTrigger value="renovacao" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3 hidden sm:inline-flex">Renovação</TabsTrigger>
                    <TabsTrigger value="encerrados" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3 hidden sm:inline-flex">Encerrados</TabsTrigger>
                  </TabsList>
                </Tabs>
                <Button size="sm" className="gap-1.5 h-10 sm:h-8 text-xs" onClick={handleNewContract}>
                  <Plus className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Novo Contrato</span>
                  <span className="sm:hidden">Novo</span>
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[140px] sm:flex-none">
                  <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Buscar contrato..."
                    className="pl-9 h-10 sm:h-8 w-full sm:w-[200px] text-sm sm:text-xs"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <Select value={guaranteeFilter} onValueChange={setGuaranteeFilter}>
                  <SelectTrigger className="h-10 sm:h-8 w-[160px] text-xs">
                    <SelectValue placeholder="Garantia" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas as garantias</SelectItem>
                    <SelectItem value="SEGURO_FIANCA">Seguro Fianca</SelectItem>
                    <SelectItem value="FIADOR">Fiador</SelectItem>
                    <SelectItem value="CAUCAO">Caucao</SelectItem>
                    <SelectItem value="TITULO_CAPITALIZACAO">Titulo Capitalizacao</SelectItem>
                    <SelectItem value="SEM_GARANTIA">Sem Garantia</SelectItem>
                  </SelectContent>
                </Select>
                <div className="hidden sm:flex items-center gap-2">
                  <Button variant="default" size="sm" className="gap-1.5 h-8 text-xs" onClick={() => setImportContractPdfOpen(true)}>
                    <FileSearch className="h-3.5 w-3.5" />
                    Importar Contratos PDF
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 h-8 text-xs"
                    onClick={async () => {
                      try {
                        const res = await fetch("/api/documents/download-all?entityType=CONTRACT");
                        if (!res.ok) throw new Error("Erro");
                        const blob = await res.blob();
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "contratos-pdfs.zip";
                        a.click();
                        URL.revokeObjectURL(url);
                      } catch {
                        toast.error("Erro ao baixar PDFs");
                      }
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                    Baixar Todos PDFs
                  </Button>
                </div>
                {/* Mobile: import dropdown */}
                <div className="sm:hidden">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-1.5 h-10 text-xs">
                        <Upload className="h-3.5 w-3.5" />
                        Importar
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setImportOpen(true)}>
                        <FileSpreadsheet className="h-3.5 w-3.5 mr-2" /> Planilha
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setUploadOpen(true)}>
                        <Upload className="h-3.5 w-3.5 mr-2" /> PDF
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setBatchUploadOpen(true)}>
                        <Files className="h-3.5 w-3.5 mr-2" /> Lote
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setImportContractPdfOpen(true)}>
                        <FileSearch className="h-3.5 w-3.5 mr-2" /> Contratos PDF
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">Carregando...</p>
              </div>
            ) : filteredContracts.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">
                  {search
                    ? "Nenhum contrato encontrado para a busca."
                    : "Nenhum contrato cadastrado."}
                </p>
              </div>
            ) : (
              <>
              {/* Mobile card view */}
              <div className="divide-y md:hidden">
                {filteredContracts.map((contract) => {
                  const status = statusConfig[contract.status] || {
                    label: contract.status,
                    className: "bg-muted text-muted-foreground",
                  };
                  return (
                    <Link key={contract.id} href={`/contratos/${contract.id}`} className="block p-4 active:bg-muted/50 cursor-pointer hover:bg-muted/30">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 shrink-0">
                            <FileText className="h-5 w-5 text-primary" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold">{contract.code}</p>
                              <Badge variant="outline" className={cn("text-[10px] h-5 border", status.className)}>
                                {status.label}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{contract.property?.title || "N/A"}</p>
                          </div>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0" onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}>
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleEditContract(contract)}>
                              <Pencil className="h-3.5 w-3.5 mr-2" /> Editar
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => handleDeleteClick(contract)}>
                              <Trash2 className="h-3.5 w-3.5 mr-2" /> Excluir
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{contract.tenant?.name || "N/A"}</span>
                        <span className="font-semibold text-sm">{formatCurrency(contract.rentalValue)}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {formatDate(contract.startDate)} - {formatDate(contract.endDate)}
                      </div>
                    </Link>
                  );
                })}
              </div>

              {/* Desktop table view */}
              <div className="overflow-x-auto hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-xs">Código</TableHead>
                    <TableHead className="text-xs">Imóvel</TableHead>
                    <TableHead className="text-xs">Locatário</TableHead>
                    <TableHead className="text-xs">Proprietário</TableHead>
                    <TableHead className="text-xs">Valor Aluguel</TableHead>
                    <TableHead className="text-xs">Vigencia</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs">Cadastrado por</TableHead>
                    <TableHead className="text-xs w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredContracts.map((contract) => {
                    const status = statusConfig[contract.status] || {
                      label: contract.status,
                      className: "bg-muted text-muted-foreground",
                    };
                    return (
                      <TableRow
                        key={contract.id}
                        className="cursor-pointer"
                        onClick={() => router.push(`/contratos/${contract.id}`)}
                        onContextMenu={(e) => openCtxMenu(e, [
                          { label: "Abrir", icon: Eye, onClick: () => router.push(`/contratos/${contract.id}`) },
                          { label: "Abrir em nova guia", icon: ExternalLink, onClick: () => window.open(`/contratos/${contract.id}`, "_blank") },
                          { label: "Editar", icon: Pencil, onClick: () => handleEditContract(contract) },
                          { label: "Excluir", icon: Trash2, onClick: () => handleDeleteClick(contract), variant: "destructive", separator: true },
                        ])}
                      >
                        <TableCell className="font-medium text-xs">
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-muted-foreground" />
                            {contract.code}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[300px]">
                          <span className="block truncate" title={contract.property?.title || "N/A"}>
                            {contract.property?.title || "N/A"}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs max-w-[250px]">
                          <span className="block truncate" title={contract.tenant?.name || "N/A"}>
                            {contract.tenant?.name || "N/A"}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[250px]">
                          <span className="block truncate" title={contract.owner?.name || "N/A"}>
                            {contract.owner?.name || "N/A"}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs font-medium">
                          {formatCurrency(contract.rentalValue)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(contract.startDate)} - {formatDate(contract.endDate)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn("text-xs border", status.className)}>
                            {status.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {contract.createdBy?.name || "-"}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7">
                                <MoreVertical className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleEditContract(contract)}>
                                <Pencil className="h-3.5 w-3.5 mr-2" />
                                Editar
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => handleDeleteClick(contract)}
                              >
                                <Trash2 className="h-3.5 w-3.5 mr-2" />
                                Excluir
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              </div>
              </>
            )}

            {/* Paginacao */}
            {totalEntries > PAGE_SIZE && (
              <div className="flex items-center justify-between gap-2 px-4 py-3 border-t flex-wrap">
                <p className="text-xs text-muted-foreground">
                  Mostrando {Math.min((page - 1) * PAGE_SIZE + 1, totalEntries)}-{Math.min(page * PAGE_SIZE, totalEntries)} de {totalEntries.toLocaleString("pt-BR")}
                </p>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" className="h-8 text-xs" disabled={page <= 1 || loading} onClick={() => setPage(1)}>Primeira</Button>
                  <Button size="sm" variant="outline" className="h-8 text-xs" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>Anterior</Button>
                  <span className="text-xs text-muted-foreground px-2">Pagina {page} de {totalPages}</span>
                  <Button size="sm" variant="outline" className="h-8 text-xs" disabled={page >= totalPages || loading} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Proxima</Button>
                  <Button size="sm" variant="outline" className="h-8 text-xs" disabled={page >= totalPages || loading} onClick={() => setPage(totalPages)}>Ultima</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Contract Form Dialog */}
      <ContractForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contract={selectedContract}
        onSuccess={handleFormSuccess}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir Contrato</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir o contrato{" "}
              <strong>{contractToDelete?.code}</strong>? Esta acao nao pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Upload PDF Dialog */}
      <UploadPdf
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onSuccess={() => refresh()}
      />

      {/* Batch Upload PDF Dialog */}
      <BatchUploadPdf
        open={batchUploadOpen}
        onOpenChange={setBatchUploadOpen}
        onSuccess={() => refresh()}
      />

      {/* Import Spreadsheet Dialog */}
      <ImportSpreadsheet
        entityType="contracts"
        open={importOpen}
        onOpenChange={setImportOpen}
        onSuccess={() => refresh()}
      />

      {/* Import Contract PDFs Dialog */}
      <ImportContractPdf
        open={importContractPdfOpen}
        onOpenChange={setImportContractPdfOpen}
        onSuccess={() => refresh()}
      />

      <CtxMenuPortal />
    </div>
  );
}
