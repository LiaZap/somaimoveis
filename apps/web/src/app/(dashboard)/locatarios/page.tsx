"use client";

import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  Phone,
  Mail,
  MoreVertical,
  Pencil,
  Trash2,
  Users,
  FileCheck,
  AlertTriangle,
  UserPlus,
  ExternalLink,
  Eye,
} from "lucide-react";
import { useContextMenu } from "@/components/ui/context-menu-custom";
import { TenantForm } from "@/components/forms/tenant-form";
import { ImportSpreadsheet } from "@/components/forms/import-spreadsheet";
import { FileSpreadsheet } from "lucide-react";

interface Tenant {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  cpfCnpj: string;
  personType: string;
  occupation: string | null;
  monthlyIncome: number | null;
  active: boolean;
  currentProperty: string | null;
  contractEndDate: string | null;
  paymentStatus: string;
  createdAt: string;
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
}

const statusConfig: Record<string, { label: string; className: string }> = {
  PAGO: { label: "Em dia", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  PENDENTE: { label: "Pendente", className: "bg-yellow-100 text-yellow-700 border-yellow-200" },
  ATRASADO: { label: "Atrasado", className: "bg-red-100 text-red-700 border-red-200" },
  SEM_COBRANCA: { label: "Sem cobranca", className: "bg-gray-100 text-gray-600 border-gray-200" },
};

export default function LocatariosPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-12"><p className="text-sm text-muted-foreground">Carregando...</p></div>}>
      <LocatariosContent />
    </Suspense>
  );
}

function LocatariosContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | undefined>(undefined);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [tenantToDelete, setTenantToDelete] = useState<Tenant | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [openCtxMenu, CtxMenuPortal] = useContextMenu();
  // Paginacao server-side
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalEntries, setTotalEntries] = useState(0);
  const [stats, setStats] = useState({
    totalTenants: 0,
    activeContracts: 0,
    inadimplentes: 0,
    newThisMonth: 0,
  });

  async function fetchTenants() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      const response = await fetch(`/api/tenants?${params.toString()}`);
      if (response.ok) {
        const data = await response.json();
        setTenants(data.data || []);
        setTotalPages(data.pagination?.totalPages || 1);
        setTotalEntries(data.pagination?.total || 0);
      }
    } catch (error) {
      console.error("Erro ao buscar locatarios:", error);
    } finally {
      setLoading(false);
    }
  }

  async function fetchStats() {
    try {
      const res = await fetch("/api/tenants/stats");
      if (res.ok) {
        const data = await res.json();
        setStats({
          totalTenants: data.totalTenants || 0,
          activeContracts: data.activeContracts || 0,
          inadimplentes: data.inadimplentes || 0,
          newThisMonth: data.newThisMonth || 0,
        });
      }
    } catch (error) {
      console.error("Erro ao buscar stats:", error);
    }
  }

  async function refresh() {
    await Promise.all([fetchTenants(), fetchStats()]);
  }

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  useEffect(() => {
    fetchStats();
  }, []);

  useEffect(() => {
    fetchTenants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedSearch]);

  useEffect(() => {
    if (searchParams.get("novo") === "true") {
      setSelectedTenant(undefined);
      setFormOpen(true);
      router.replace("/locatarios");
    }
  }, [searchParams, router]);

  // Servidor ja filtrou — `tenants` ja sao as linhas da pagina atual
  const filteredTenants = tenants;
  const { totalTenants, activeContracts, inadimplentes, newThisMonth } = stats;

  function handleNewTenant() {
    setSelectedTenant(undefined);
    setFormOpen(true);
  }

  function handleEditTenant(tenant: Tenant) {
    setSelectedTenant(tenant);
    setFormOpen(true);
  }

  function handleDeleteClick(tenant: Tenant) {
    setTenantToDelete(tenant);
    setDeleteDialogOpen(true);
  }

  async function handleDeleteConfirm() {
    if (!tenantToDelete) return;
    try {
      const response = await fetch(`/api/tenants/${tenantToDelete.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || "Erro ao excluir locatario");
        return;
      }
      toast.success("Locatário excluído com sucesso");
      refresh();
    } catch (error) {
      toast.error("Erro ao excluir locatario");
    } finally {
      setDeleteDialogOpen(false);
      setTenantToDelete(null);
    }
  }

  function handleFormSuccess() {
    refresh();
  }

  return (
    <div className="flex flex-col">
      <Header title="Locatários" subtitle="Cadastro e gestão de inquilinos" />

      <div className="p-4 sm:p-6 space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            {
              label: "Total Locatarios",
              value: loading ? "..." : String(totalTenants),
              icon: Users,
            },
            {
              label: "Com Contrato Ativo",
              value: loading ? "..." : String(activeContracts),
              icon: FileCheck,
            },
            {
              label: "Inadimplentes",
              value: loading ? "..." : String(inadimplentes),
              icon: AlertTriangle,
              color: inadimplentes > 0 ? "text-red-500" : undefined,
            },
            {
              label: "Novos (mes)",
              value: loading ? "..." : String(newThisMonth),
              icon: UserPlus,
            },
          ].map((stat) => (
            <Card key={stat.label} className="border-0 shadow-sm">
              <CardContent className="p-4">
                <p className="text-xs font-medium text-muted-foreground">{stat.label}</p>
                <p className={`text-xl font-bold mt-1 ${"color" in stat && stat.color ? stat.color : ""}`}>
                  {stat.value}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Table */}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-0">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 p-4 border-b">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Buscar locatario..."
                  className="pl-9 h-8 w-full sm:w-[280px] text-xs"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs" onClick={() => setImportOpen(true)}>
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                  Importar
                </Button>
                <Button size="sm" className="gap-1.5 h-8 text-xs shrink-0" onClick={handleNewTenant}>
                  <Plus className="h-3.5 w-3.5" />
                  Novo Locatario
                </Button>
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">Carregando...</p>
              </div>
            ) : filteredTenants.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">
                  {search
                    ? "Nenhum locatario encontrado para a busca."
                    : "Nenhum locatario cadastrado."}
                </p>
              </div>
            ) : (
              <>
              {/* Mobile card view */}
              <div className="divide-y md:hidden">
                {filteredTenants.map((tenant) => {
                  const status = statusConfig[tenant.paymentStatus] || statusConfig.SEM_COBRANCA;
                  return (
                    <Link key={tenant.id} href={`/locatarios/${tenant.id}`} className="block p-4 active:bg-muted/50 cursor-pointer" onContextMenu={(e) => openCtxMenu(e, [
                      { label: "Abrir", icon: Eye, onClick: () => router.push(`/locatarios/${tenant.id}`) },
                      { label: "Abrir em nova guia", icon: ExternalLink, onClick: () => window.open(`/locatarios/${tenant.id}`, "_blank") },
                      { label: "Editar", icon: Pencil, onClick: () => handleEditTenant(tenant) },
                      { label: "Excluir", icon: Trash2, onClick: () => handleDeleteClick(tenant), variant: "destructive", separator: true },
                    ])}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Avatar className="h-10 w-10 shrink-0">
                            <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                              {getInitials(tenant.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1 max-w-[400px]">
                            <p className="text-sm font-semibold truncate" title={tenant.name}>{tenant.name}</p>
                            <p className="text-xs text-muted-foreground">{tenant.cpfCnpj}</p>
                          </div>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0" onClick={(e) => e.stopPropagation()}>
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleEditTenant(tenant)}>
                              <Pencil className="h-3.5 w-3.5 mr-2" /> Editar
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => handleDeleteClick(tenant)}>
                              <Trash2 className="h-3.5 w-3.5 mr-2" /> Excluir
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {tenant.email && (
                          <span className="flex items-center gap-1"><Mail className="h-3 w-3" /> {tenant.email}</span>
                        )}
                        {tenant.phone && (
                          <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {tenant.phone}</span>
                        )}
                      </div>
                      <div className="mt-2 flex items-center gap-3 text-xs">
                        {tenant.occupation && (
                          <span className="text-muted-foreground">{tenant.occupation}</span>
                        )}
                        <Badge variant="outline" className={`text-[10px] h-5 border ${status.className}`}>
                          {status.label}
                        </Badge>
                        {tenant.monthlyIncome != null && (
                          <span className="ml-auto font-semibold text-sm">{formatCurrency(tenant.monthlyIncome)}</span>
                        )}
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
                    <TableHead className="text-xs whitespace-nowrap">Locatário</TableHead>
                    <TableHead className="text-xs whitespace-nowrap">Contato</TableHead>
                    <TableHead className="text-xs whitespace-nowrap">Profissao</TableHead>
                    <TableHead className="text-xs text-right whitespace-nowrap">Renda Mensal</TableHead>
                    <TableHead className="text-xs text-center whitespace-nowrap">Status</TableHead>
                    <TableHead className="text-xs w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTenants.map((tenant) => {
                    const status = statusConfig[tenant.paymentStatus] || statusConfig.SEM_COBRANCA;
                    return (
                      <TableRow key={tenant.id} className="cursor-pointer" onClick={() => router.push(`/locatarios/${tenant.id}`)} onContextMenu={(e) => openCtxMenu(e, [
                        { label: "Abrir", icon: Eye, onClick: () => router.push(`/locatarios/${tenant.id}`) },
                        { label: "Abrir em nova guia", icon: ExternalLink, onClick: () => window.open(`/locatarios/${tenant.id}`, "_blank") },
                        { label: "Editar", icon: Pencil, onClick: () => handleEditTenant(tenant) },
                        { label: "Excluir", icon: Trash2, onClick: () => handleDeleteClick(tenant), variant: "destructive", separator: true },
                      ])}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className="h-8 w-8">
                              <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                                {getInitials(tenant.name)}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <Link href={`/locatarios/${tenant.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                                <span className="text-sm font-medium">{tenant.name}</span>
                              </Link>
                              <p className="text-xs text-muted-foreground">{tenant.cpfCnpj}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-0.5">
                            {tenant.email && (
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
                                <Mail className="h-3 w-3 shrink-0" /> {tenant.email}
                              </div>
                            )}
                            {tenant.phone && (
                              <div className="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
                                <Phone className="h-3 w-3 shrink-0" /> {tenant.phone}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {tenant.occupation || "-"}
                        </TableCell>
                        <TableCell className="text-right text-sm font-semibold">
                          {tenant.monthlyIncome != null
                            ? formatCurrency(tenant.monthlyIncome)
                            : "-"}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant="outline" className={`text-xs border ${status.className}`}>
                            {status.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7">
                                <MoreVertical className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleEditTenant(tenant)}>
                                <Pencil className="h-3.5 w-3.5 mr-2" />
                                Editar
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => handleDeleteClick(tenant)}
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

      {/* Tenant Form Dialog */}
      <TenantForm
        open={formOpen}
        onOpenChange={setFormOpen}
        tenant={selectedTenant}
        onSuccess={handleFormSuccess}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir Locatário</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir o locatario{" "}
              <strong>{tenantToDelete?.name}</strong>? Esta acao nao pode ser desfeita.
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

      {/* Import Spreadsheet Dialog */}
      <ImportSpreadsheet
        entityType="tenants"
        open={importOpen}
        onOpenChange={setImportOpen}
        onSuccess={() => refresh()}
      />

      <CtxMenuPortal />
    </div>
  );
}
