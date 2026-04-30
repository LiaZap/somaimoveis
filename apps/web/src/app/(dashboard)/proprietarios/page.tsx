"use client";

import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
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
  Building2,
  Phone,
  Mail,
  MoreVertical,
  Pencil,
  Trash2,
  Users,
  DollarSign,
  UserPlus,
  ExternalLink,
  Eye,
} from "lucide-react";
import { OwnerForm } from "@/components/forms/owner-form";
import { ImportSpreadsheet } from "@/components/forms/import-spreadsheet";
import { useContextMenu } from "@/components/ui/context-menu-custom";
import { FileSpreadsheet } from "lucide-react";

interface Owner {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  cpfCnpj: string;
  personType: string;
  active: boolean;
  propertyCount: number;
  activeContractCount: number;
  monthlyIncome: number;
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

export default function ProprietariosPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-12"><p className="text-sm text-muted-foreground">Carregando...</p></div>}>
      <ProprietariosContent />
    </Suspense>
  );
}

function ProprietariosContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [owners, setOwners] = useState<Owner[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [selectedOwner, setSelectedOwner] = useState<Owner | undefined>(undefined);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [ownerToDelete, setOwnerToDelete] = useState<Owner | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [openCtxMenu, CtxMenuPortal] = useContextMenu();
  // Paginacao server-side
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalEntries, setTotalEntries] = useState(0);
  const [stats, setStats] = useState({
    totalOwners: 0,
    totalProperties: 0,
    totalMonthlyIncome: 0,
    newThisMonth: 0,
  });

  async function fetchOwners() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      const response = await fetch(`/api/owners?${params.toString()}`);
      if (response.ok) {
        const data = await response.json();
        setOwners(data.data || []);
        setTotalPages(data.pagination?.totalPages || 1);
        setTotalEntries(data.pagination?.total || 0);
      }
    } catch (error) {
      console.error("Erro ao buscar proprietarios:", error);
    } finally {
      setLoading(false);
    }
  }

  async function fetchStats() {
    try {
      const res = await fetch("/api/owners/stats");
      if (res.ok) {
        const data = await res.json();
        setStats({
          totalOwners: data.totalOwners || 0,
          totalProperties: data.totalProperties || 0,
          totalMonthlyIncome: data.totalMonthlyIncome || 0,
          newThisMonth: data.newThisMonth || 0,
        });
      }
    } catch (error) {
      console.error("Erro ao buscar stats:", error);
    }
  }

  async function refresh() {
    await Promise.all([fetchOwners(), fetchStats()]);
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
    fetchOwners();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedSearch]);

  useEffect(() => {
    if (searchParams.get("novo") === "true") {
      setSelectedOwner(undefined);
      setFormOpen(true);
      router.replace("/proprietarios");
    }
  }, [searchParams, router]);

  // Servidor ja filtrou — `owners` ja sao as linhas da pagina atual
  const filteredOwners = owners;

  const { totalOwners, totalProperties, totalMonthlyIncome, newThisMonth } = stats;

  function handleNewOwner() {
    setSelectedOwner(undefined);
    setFormOpen(true);
  }

  function handleEditOwner(owner: Owner) {
    setSelectedOwner(owner);
    setFormOpen(true);
  }

  function handleDeleteClick(owner: Owner) {
    setOwnerToDelete(owner);
    setDeleteDialogOpen(true);
  }

  async function handleDeleteConfirm() {
    if (!ownerToDelete) return;
    try {
      const response = await fetch(`/api/owners/${ownerToDelete.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || "Erro ao excluir proprietario");
        return;
      }
      toast.success("Proprietário excluído com sucesso");
      refresh();
    } catch (error) {
      toast.error("Erro ao excluir proprietario");
    } finally {
      setDeleteDialogOpen(false);
      setOwnerToDelete(null);
    }
  }

  function handleFormSuccess() {
    refresh();
  }

  return (
    <div className="flex flex-col">
      <Header title="Proprietários" subtitle="Cadastro e gestão de proprietários de imóveis" />

      <div className="p-4 sm:p-6 space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            {
              label: "Total Proprietarios",
              value: loading ? "..." : String(totalOwners),
              icon: Users,
            },
            {
              label: "Imoveis Vinculados",
              value: loading ? "..." : String(totalProperties),
              icon: Building2,
            },
            {
              label: "Repasse Mensal Total",
              value: loading
                ? "..."
                : formatCurrency(totalMonthlyIncome),
              icon: DollarSign,
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
                <p className="text-xl font-bold mt-1">{stat.value}</p>
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
                  placeholder="Buscar proprietario..."
                  className="pl-9 h-10 sm:h-8 w-full sm:w-[280px] text-sm sm:text-xs"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="gap-1.5 h-10 sm:h-8 text-xs" onClick={() => setImportOpen(true)}>
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                  Importar
                </Button>
                <Button size="sm" className="gap-1.5 h-10 sm:h-8 text-xs" onClick={handleNewOwner}>
                  <Plus className="h-3.5 w-3.5" />
                  Novo Proprietario
                </Button>
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">Carregando...</p>
              </div>
            ) : filteredOwners.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">
                  {search
                    ? "Nenhum proprietario encontrado para a busca."
                    : "Nenhum proprietario cadastrado."}
                </p>
              </div>
            ) : (
              <>
              {/* Mobile card view */}
              <div className="divide-y md:hidden">
                {filteredOwners.map((owner) => (
                  <Link key={owner.id} href={`/proprietarios/${owner.id}`} className="block p-4 active:bg-muted/50 cursor-pointer" onContextMenu={(e) => openCtxMenu(e, [
                    { label: "Abrir", icon: Eye, onClick: () => router.push(`/proprietarios/${owner.id}`) },
                    { label: "Abrir em nova guia", icon: ExternalLink, onClick: () => window.open(`/proprietarios/${owner.id}`, "_blank") },
                    { label: "Editar", icon: Pencil, onClick: () => handleEditOwner(owner) },
                    { label: "Excluir", icon: Trash2, onClick: () => handleDeleteClick(owner), variant: "destructive", separator: true },
                  ])}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar className="h-10 w-10 shrink-0">
                          <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                            {getInitials(owner.name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">{owner.name}</p>
                          <p className="text-xs text-muted-foreground">{owner.cpfCnpj}</p>
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0" onClick={(e) => e.preventDefault()}>
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleEditOwner(owner)}>
                            <Pencil className="h-3.5 w-3.5 mr-2" /> Editar
                          </DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onClick={() => handleDeleteClick(owner)}>
                            <Trash2 className="h-3.5 w-3.5 mr-2" /> Excluir
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {owner.email && (
                        <span className="flex items-center gap-1"><Mail className="h-3 w-3" /> {owner.email}</span>
                      )}
                      {owner.phone && (
                        <span className="flex items-center gap-1"><Phone className="h-3 w-3" /> {owner.phone}</span>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-4 text-xs">
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Building2 className="h-3 w-3" /> {owner.propertyCount} imov.
                      </span>
                      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px] h-5">
                        {owner.activeContractCount} contrato{owner.activeContractCount !== 1 ? "s" : ""}
                      </Badge>
                      <span className="ml-auto font-semibold text-sm">{formatCurrency(owner.monthlyIncome)}</span>
                    </div>
                  </Link>
                ))}
              </div>

              {/* Desktop table view */}
              <div className="overflow-x-auto hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-xs">Proprietário</TableHead>
                    <TableHead className="text-xs">Contato</TableHead>
                    <TableHead className="text-xs text-center">Imóveis</TableHead>
                    <TableHead className="text-xs text-center">Contratos Ativos</TableHead>
                    <TableHead className="text-xs text-right">Renda Mensal</TableHead>
                    <TableHead className="text-xs w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredOwners.map((owner) => (
                    <TableRow key={owner.id} className="cursor-pointer" onClick={() => router.push(`/proprietarios/${owner.id}`)} onContextMenu={(e) => openCtxMenu(e, [
                      { label: "Abrir", icon: Eye, onClick: () => router.push(`/proprietarios/${owner.id}`) },
                      { label: "Abrir em nova guia", icon: ExternalLink, onClick: () => window.open(`/proprietarios/${owner.id}`, "_blank") },
                      { label: "Editar", icon: Pencil, onClick: () => handleEditOwner(owner) },
                      { label: "Excluir", icon: Trash2, onClick: () => handleDeleteClick(owner), variant: "destructive", separator: true },
                    ])}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                              {getInitials(owner.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <Link href={`/proprietarios/${owner.id}`} className="text-sm font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{owner.name}</Link>
                            <p className="text-xs text-muted-foreground">{owner.cpfCnpj}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-0.5">
                          {owner.email && (
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Mail className="h-3 w-3" /> {owner.email}
                            </div>
                          )}
                          {owner.phone && (
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Phone className="h-3 w-3" /> {owner.phone}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-sm font-medium">{owner.propertyCount}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                          {owner.activeContractCount}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-sm font-semibold">
                        {formatCurrency(owner.monthlyIncome)}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7">
                              <MoreVertical className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleEditOwner(owner)}>
                              <Pencil className="h-3.5 w-3.5 mr-2" />
                              Editar
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => handleDeleteClick(owner)}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-2" />
                              Excluir
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
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

      {/* Owner Form Dialog */}
      <OwnerForm
        open={formOpen}
        onOpenChange={setFormOpen}
        owner={selectedOwner}
        onSuccess={handleFormSuccess}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir Proprietário</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir o proprietario{" "}
              <strong>{ownerToDelete?.name}</strong>? Esta acao nao pode ser desfeita.
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
        entityType="owners"
        open={importOpen}
        onOpenChange={setImportOpen}
        onSuccess={() => refresh()}
      />

      <CtxMenuPortal />
    </div>
  );
}
