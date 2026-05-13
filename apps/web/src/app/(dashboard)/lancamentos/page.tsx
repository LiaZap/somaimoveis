"use client";

import React, { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Plus,
  Search,
  MoreVertical,
  Pencil,
  Trash2,
  ArrowDownRight,
  ArrowUpRight,
  Clock,
  CheckCircle2,
  XCircle,
  Repeat,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface EntryItem {
  id: string;
  entrySource: "tenant" | "owner"; // qual API originou
  tenantId?: string;
  ownerId?: string;
  type: "DEBITO" | "CREDITO";
  category: string;
  description: string | null;
  value: number;
  dueDate: string;
  status: "PENDENTE" | "PAGO" | "CANCELADO";
  notes: string | null;
  createdAt: string;
  installmentNumber: number | null;
  installmentTotal: number | null;
  parentEntryId: string | null;
  isRecurring: boolean;
  recurringDay: number | null;
  destination: string | null;
  personName: string; // nome do locatário ou proprietário
}

interface Person {
  id: string;
  name: string;
}

const statusConfig: Record<string, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  PENDENTE: { label: "Pendente", className: "bg-yellow-100 text-yellow-700 border-yellow-200", icon: Clock },
  PAGO: { label: "Pago", className: "bg-emerald-100 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
  CANCELADO: { label: "Cancelado", className: "bg-gray-100 text-gray-500 border-gray-200", icon: XCircle },
};

const categoryLabels: Record<string, string> = {
  ALUGUEL: "Aluguel",
  CONDOMINIO: "Condominio",
  IPTU: "IPTU",
  AGUA: "Agua",
  LUZ: "Luz",
  GAS: "Gas",
  MULTA: "Multa",
  REPARO: "Reparo",
  REPASSE: "Repasse",
  DESCONTO: "Desconto",
  SEGURO_FIANCA: "Seguro Fiança",
  SEGURO_INCENDIO: "Seguro Incêndio",
  TAXA_BANCARIA: "Taxa Bancaria",
  INTERMEDIACAO: "Intermediacao",
  ACORDO: "Acordo",
  OUTROS: "Outros",
};

const tenantCategories = [
  "ALUGUEL", "CONDOMINIO", "IPTU", "AGUA", "LUZ", "GAS",
  "MULTA", "REPARO", "DESCONTO", "SEGURO_FIANCA", "SEGURO_INCENDIO",
  "ACORDO", "OUTROS",
];

const ownerCategories = [
  "REPASSE", "REPARO", "TAXA_BANCARIA", "IPTU", "CONDOMINIO",
  "INTERMEDIACAO", "DESCONTO", "ACORDO", "OUTROS",
];

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

export default function LancamentosPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-12"><p className="text-sm text-muted-foreground">Carregando...</p></div>}>
      <LancamentosContent />
    </Suspense>
  );
}

function LancamentosContent() {
  const [entries, setEntries] = useState<EntryItem[]>([]);
  const [tenants, setTenants] = useState<Person[]>([]);
  const [owners, setOwners] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [activeTab, setActiveTab] = useState("todos");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [sourceFilter, setSourceFilter] = useState("todos"); // todos, locatario, proprietario
  // Filtro por mes (YYYY-MM ou "todos")
  const [monthFilter, setMonthFilter] = useState("todos");
  // Server-side pagination
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  const [totalPages, setTotalPages] = useState(1);
  const [totalEntries, setTotalEntries] = useState(0);
  const [totalDebitos, setTotalDebitos] = useState(0);
  const [totalCreditos, setTotalCreditos] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [entryToDelete, setEntryToDelete] = useState<EntryItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Form state
  const [formTarget, setFormTarget] = useState<"locatario" | "proprietario">("locatario");
  const [formPersonId, setFormPersonId] = useState("");
  const [formType, setFormType] = useState<"DEBITO" | "CREDITO">("DEBITO");
  const [formCategory, setFormCategory] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formValue, setFormValue] = useState("");
  const [formDueDate, setFormDueDate] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formInstallments, setFormInstallments] = useState("1");
  const [formValueMode, setFormValueMode] = useState<"TOTAL" | "PARCELA">("TOTAL");
  const [formIsRecurring, setFormIsRecurring] = useState(false);
  const [formDestination, setFormDestination] = useState("");
  const [editingEntry, setEditingEntry] = useState<EntryItem | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  function buildQueryParams() {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", String(PAGE_SIZE));
    if (sourceFilter !== "todos") params.set("source", sourceFilter);
    if (activeTab === "debitos") params.set("type", "DEBITO");
    if (activeTab === "creditos") params.set("type", "CREDITO");
    if (statusFilter !== "todos") params.set("status", statusFilter);
    if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
    if (monthFilter !== "todos") params.set("month", monthFilter);
    return params.toString();
  }

  async function fetchEntries() {
    setLoading(true);
    try {
      const qs = buildQueryParams();
      const res = await fetch(`/api/entries?${qs}`);
      if (!res.ok) throw new Error("Failed to fetch entries");
      const data = await res.json();
      setEntries(
        (data.data || []).map((e: any) => ({
          ...e,
          // Normalize date fields to ISO strings for display utilities
          dueDate: e.dueDate ? new Date(e.dueDate).toISOString() : null,
          createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : new Date().toISOString(),
        })),
      );
      setTotalPages(data.pagination?.totalPages || 1);
      setTotalEntries(data.pagination?.total || 0);
    } catch (error) {
      console.error("Erro ao buscar lancamentos:", error);
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    await Promise.all([fetchEntries(), fetchStats()]);
  }

  async function fetchStats() {
    try {
      const params = new URLSearchParams();
      if (sourceFilter !== "todos") params.set("source", sourceFilter);
      if (activeTab === "debitos") params.set("type", "DEBITO");
      if (activeTab === "creditos") params.set("type", "CREDITO");
      if (statusFilter !== "todos") params.set("status", statusFilter);
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      if (monthFilter !== "todos") params.set("month", monthFilter);
      const res = await fetch(`/api/entries/stats?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      setTotalDebitos(data.totalDebitos || 0);
      setTotalCreditos(data.totalCreditos || 0);
    } catch (error) {
      console.error("Erro ao buscar stats:", error);
    }
  }

  async function fetchPeople() {
    try {
      const [tenantRes, ownerRes] = await Promise.all([
        fetch("/api/tenants"),
        fetch("/api/owners"),
      ]);
      if (tenantRes.ok) {
        const data = await tenantRes.json();
        setTenants(data);
      }
      if (ownerRes.ok) {
        const data = await ownerRes.json();
        setOwners(data);
      }
    } catch (error) {
      console.error("Erro ao buscar pessoas:", error);
    }
  }

  // Initial mount: fetch people only once
  useEffect(() => {
    fetchPeople();
  }, []);

  // Debounce search input (avoid fetching on every keystroke)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to page 1 when filters or search change
  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [sourceFilter, activeTab, statusFilter, debouncedSearch, monthFilter]);

  // Clear selection when navigating to a different page
  useEffect(() => {
    setSelectedIds(new Set());
  }, [page]);

  // Refetch entries + stats when filters/page/search change
  useEffect(() => {
    fetchEntries();
    fetchStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sourceFilter, activeTab, statusFilter, debouncedSearch, monthFilter]);

  // Server already filtered — entries are the page rows
  const filteredEntries = entries;

  // Group installments: entries with same parentEntryId or parent itself
  interface EntryGroup {
    key: string;
    entries: EntryItem[];
    personName: string;
    category: string;
    description: string | null;
    type: "DEBITO" | "CREDITO";
    entrySource: "tenant" | "owner";
    totalValue: number;
    installmentTotal: number;
    isRecurring: boolean;
    hasMultiple: boolean;
    // Status summary
    paidCount: number;
    pendingCount: number;
  }

  const groupedEntries: EntryGroup[] = (() => {
    const groupMap = new Map<string, EntryItem[]>();
    const standalone: EntryItem[] = [];

    for (const entry of filteredEntries) {
      if (entry.installmentTotal && entry.installmentTotal > 1) {
        // Has installments - group by parentEntryId or own id if it's the parent
        const groupKey = entry.parentEntryId || entry.id;
        if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
        groupMap.get(groupKey)!.push(entry);
      } else {
        standalone.push(entry);
      }
    }

    const result: EntryGroup[] = [];

    // Add grouped installments
    for (const [key, items] of groupMap) {
      items.sort((a, b) => (a.installmentNumber || 0) - (b.installmentNumber || 0));
      const first = items[0];
      result.push({
        key,
        entries: items,
        personName: first.personName,
        category: first.category,
        description: first.description,
        type: first.type,
        entrySource: first.entrySource,
        totalValue: items.reduce((sum, e) => sum + e.value, 0),
        installmentTotal: first.installmentTotal || items.length,
        isRecurring: first.isRecurring,
        hasMultiple: true,
        paidCount: items.filter((e) => e.status === "PAGO").length,
        pendingCount: items.filter((e) => e.status === "PENDENTE").length,
      });
    }

    // Add standalone entries
    for (const entry of standalone) {
      result.push({
        key: entry.id,
        entries: [entry],
        personName: entry.personName,
        category: entry.category,
        description: entry.description,
        type: entry.type,
        entrySource: entry.entrySource,
        totalValue: entry.value,
        installmentTotal: 1,
        isRecurring: entry.isRecurring,
        hasMultiple: false,
        paidCount: entry.status === "PAGO" ? 1 : 0,
        pendingCount: entry.status === "PENDENTE" ? 1 : 0,
      });
    }

    // Sort by first entry's createdAt (most recent first)
    result.sort((a, b) => new Date(b.entries[0].createdAt).getTime() - new Date(a.entries[0].createdAt).getTime());
    return result;
  })();

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Summary comes from server (totalDebitos / totalCreditos / totalEntries)

  function resetForm() {
    setFormTarget("locatario");
    setFormPersonId("");
    setFormType("DEBITO");
    setFormCategory("");
    setFormDescription("");
    setFormValue("");
    setFormDueDate("");
    setFormNotes("");
    setFormInstallments("1");
    setFormValueMode("TOTAL");
    setFormIsRecurring(false);
    setFormDestination("");
  }

  function handleNewEntry() {
    resetForm();
    setEditingEntry(null);
    setFormOpen(true);
  }

  function handleEditEntry(entry: EntryItem) {
    setEditingEntry(entry);
    setFormTarget(entry.entrySource === "owner" ? "proprietario" : "locatario");
    setFormPersonId(entry.ownerId || entry.tenantId || "");
    setFormType(entry.type);
    setFormCategory(entry.category);
    setFormDescription(entry.description || "");
    setFormValue(String(entry.value));
    setFormDueDate(entry.dueDate ? entry.dueDate.split("T")[0] : "");
    setFormNotes(entry.notes || "");
    setFormInstallments("1");
    setFormValueMode("TOTAL");
    setFormIsRecurring(entry.isRecurring);
    setFormDestination(entry.destination || "");
    setEditOpen(true);
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingEntry) return;
    setSubmitting(true);
    try {
      const apiBase = editingEntry.entrySource === "owner" ? "/api/owner-entries" : "/api/tenant-entries";
      const response = await fetch(`${apiBase}/${editingEntry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: formType,
          category: formCategory,
          description: formDescription || null,
          value: parseFloat(formValue),
          dueDate: formDueDate,
          notes: formNotes || null,
          isRecurring: formIsRecurring,
          destination: formDestination || null,
        }),
      });
      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || "Erro ao atualizar lancamento");
        return;
      }
      toast.success("Lançamento atualizado");
      setEditOpen(false);
      setEditingEntry(null);
      fetchEntries();
      fetchStats();
    } catch {
      toast.error("Erro ao atualizar lancamento");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMarkAsPaid(entry: EntryItem) {
    try {
      const apiBase = entry.entrySource === "owner" ? "/api/owner-entries" : "/api/tenant-entries";
      const response = await fetch(`${apiBase}/${entry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "PAGO",
          paidAt: new Date().toISOString(),
        }),
      });
      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || "Erro ao marcar como pago");
        return;
      }
      toast.success(`Lançamento de ${entry.personName} marcado como pago`);
      fetchEntries();
      fetchStats();
    } catch {
      toast.error("Erro ao marcar como pago");
    }
  }

  async function handleMarkAsPending(entry: EntryItem) {
    try {
      const apiBase = entry.entrySource === "owner" ? "/api/owner-entries" : "/api/tenant-entries";
      const response = await fetch(`${apiBase}/${entry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "PENDENTE",
          paidAt: null,
        }),
      });
      if (!response.ok) {
        toast.error("Erro ao reverter status");
        return;
      }
      toast.success("Status revertido para pendente");
      fetchEntries();
      fetchStats();
    } catch {
      toast.error("Erro ao reverter status");
    }
  }

  async function handleCancel(entry: EntryItem) {
    try {
      const apiBase = entry.entrySource === "owner" ? "/api/owner-entries" : "/api/tenant-entries";
      const response = await fetch(`${apiBase}/${entry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CANCELADO" }),
      });
      if (!response.ok) {
        toast.error("Erro ao cancelar lançamento");
        return;
      }
      toast.success("Lançamento cancelado");
      fetchEntries();
      fetchStats();
    } catch {
      toast.error("Erro ao cancelar lançamento");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formPersonId || !formCategory || !formValue || !formDueDate) return;

    setSubmitting(true);
    try {
      // Se modo parcela, o valor total = valor da parcela * numero de parcelas
      const numInstallments = parseInt(formInstallments) || 1;
      const rawValue = parseFloat(formValue);
      const totalValue = formValueMode === "PARCELA" && numInstallments > 1
        ? rawValue * numInstallments
        : rawValue;

      const isOwner = formTarget === "proprietario";
      const apiUrl = isOwner ? "/api/owner-entries" : "/api/tenant-entries";
      const bodyData = isOwner
        ? {
            ownerId: formPersonId,
            type: formType,
            category: formCategory,
            description: formDescription || null,
            value: totalValue,
            dueDate: formDueDate,
            notes: formNotes || null,
            installments: numInstallments,
            isRecurring: formIsRecurring,
            destination: formDestination || null,
          }
        : {
            tenantId: formPersonId,
            type: formType,
            category: formCategory,
            description: formDescription || null,
            value: totalValue,
            dueDate: formDueDate,
            notes: formNotes || null,
            installments: numInstallments,
            isRecurring: formIsRecurring,
            destination: formDestination || null,
          };

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyData),
      });
      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || "Erro ao criar lancamento");
        return;
      }
      setFormOpen(false);
      resetForm();
      refresh();
    } catch (error) {
      toast.error("Erro ao criar lancamento");
    } finally {
      setSubmitting(false);
    }
  }

  function handleDeleteClick(entry: EntryItem) {
    setEntryToDelete(entry);
    setDeleteDialogOpen(true);
  }

  async function handleDeleteConfirm() {
    if (!entryToDelete) return;
    try {
      const apiBase = entryToDelete.entrySource === "owner" ? "/api/owner-entries" : "/api/tenant-entries";
      const response = await fetch(`${apiBase}/${entryToDelete.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || "Erro ao excluir lancamento");
        return;
      }
      refresh();
    } catch (error) {
      toast.error("Erro ao excluir lancamento");
    } finally {
      setDeleteDialogOpen(false);
      setEntryToDelete(null);
    }
  }

  function toggleSelectAll() {
    if (selectedIds.size === filteredEntries.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredEntries.map((e) => e.id)));
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    let errors = 0;
    for (const id of ids) {
      try {
        // Find the entry to determine which API to call
        const entry = entries.find((e) => e.id === id);
        const apiBase = entry?.entrySource === "owner" ? "/api/owner-entries" : "/api/tenant-entries";
        const res = await fetch(`${apiBase}/${id}`, { method: "DELETE" });
        if (!res.ok) errors++;
      } catch {
        errors++;
      }
    }
    if (errors > 0) toast.error(`${errors} lançamento(s) não puderam ser excluídos`);
    else toast.success(`${ids.length} lançamento(s) excluído(s)`);
    setSelectedIds(new Set());
    setBulkDeleteDialogOpen(false);
    refresh();
  }

  function renderEntryActions(entry: EntryItem) {
    return (
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => handleEditEntry(entry)}>
          <Pencil className="h-3.5 w-3.5 mr-2" /> Editar
        </DropdownMenuItem>
        {entry.status === "PENDENTE" && (
          <DropdownMenuItem onClick={() => handleMarkAsPaid(entry)}>
            <CheckCircle2 className="h-3.5 w-3.5 mr-2 text-emerald-600" /> Marcar como Pago
          </DropdownMenuItem>
        )}
        {entry.status === "PAGO" && (
          <DropdownMenuItem onClick={() => handleMarkAsPending(entry)}>
            <Clock className="h-3.5 w-3.5 mr-2 text-amber-600" /> Reverter p/ Pendente
          </DropdownMenuItem>
        )}
        {entry.status !== "CANCELADO" && (
          <DropdownMenuItem onClick={() => handleCancel(entry)}>
            <XCircle className="h-3.5 w-3.5 mr-2 text-gray-500" /> Cancelar
          </DropdownMenuItem>
        )}
        <DropdownMenuItem variant="destructive" onClick={() => handleDeleteClick(entry)}>
          <Trash2 className="h-3.5 w-3.5 mr-2" /> Excluir
        </DropdownMenuItem>
      </DropdownMenuContent>
    );
  }

  return (
    <div className="flex flex-col">
      <Header title="Lançamentos" subtitle="Debitos e creditos de locatarios e proprietarios" />

      <div className="p-4 sm:p-6 space-y-4">
        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Total Lançamentos</p>
                  <p className="text-2xl font-bold mt-1">{loading && totalEntries === 0 ? "..." : totalEntries.toLocaleString("pt-BR")}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Total Debitos</p>
                  <p className="text-2xl font-bold mt-1 text-red-600">
                    {loading ? "..." : formatCurrency(totalDebitos)}
                  </p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-100">
                  <ArrowDownRight className="h-5 w-5 text-red-500" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Total Creditos</p>
                  <p className="text-2xl font-bold mt-1 text-emerald-600">
                    {loading ? "..." : formatCurrency(totalCreditos)}
                  </p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100">
                  <ArrowUpRight className="h-5 w-5 text-emerald-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Entries Table */}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-0">
            <div className="flex flex-col gap-3 p-4 border-b">
              <div className="flex items-center gap-2 flex-wrap">
                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-auto">
                  <TabsList className="h-9 sm:h-8">
                    <TabsTrigger value="todos" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">Todos</TabsTrigger>
                    <TabsTrigger value="debitos" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">Debitos</TabsTrigger>
                    <TabsTrigger value="creditos" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">Creditos</TabsTrigger>
                  </TabsList>
                </Tabs>
                <Select value={sourceFilter} onValueChange={setSourceFilter}>
                  <SelectTrigger className="h-10 sm:h-8 w-[150px] text-xs">
                    <SelectValue placeholder="Pessoa" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todos">Todos</SelectItem>
                    <SelectItem value="locatario">Locatarios</SelectItem>
                    <SelectItem value="proprietario">Proprietarios</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-10 sm:h-8 w-[140px] text-xs">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todos">Todos</SelectItem>
                    <SelectItem value="PENDENTE">Pendente</SelectItem>
                    <SelectItem value="PAGO">Pago</SelectItem>
                    <SelectItem value="CANCELADO">Cancelado</SelectItem>
                  </SelectContent>
                </Select>
                {/* Filtro por mes (dueDate) */}
                <Select value={monthFilter} onValueChange={setMonthFilter}>
                  <SelectTrigger className="h-10 sm:h-8 w-[150px] text-xs">
                    <SelectValue placeholder="Mes" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todos">Todos os meses</SelectItem>
                    {(() => {
                      const now = new Date();
                      const opts: React.ReactElement[] = [];
                      // 12 meses passados + 2 futuros
                      for (let d = -12; d <= 2; d++) {
                        const dt = new Date(now.getFullYear(), now.getMonth() + d, 1);
                        const ym = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
                        const label = dt.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
                        opts.push(<SelectItem key={ym} value={ym}>{label}</SelectItem>);
                      }
                      return opts;
                    })()}
                  </SelectContent>
                </Select>
                {selectedIds.size > 0 && (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="gap-1.5 h-10 sm:h-8 text-xs ml-auto"
                    onClick={() => setBulkDeleteDialogOpen(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Excluir {selectedIds.size} selecionado(s)
                  </Button>
                )}
                <Button size="sm" className={cn("gap-1.5 h-10 sm:h-8 text-xs", selectedIds.size === 0 && "ml-auto")} onClick={handleNewEntry}>
                  <Plus className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Novo Lancamento</span>
                  <span className="sm:hidden">Novo</span>
                </Button>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Buscar por nome ou descricao..."
                  className="pl-9 h-10 sm:h-8 w-full sm:w-[280px] text-sm sm:text-xs"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">Carregando...</p>
              </div>
            ) : filteredEntries.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">
                  {search
                    ? "Nenhum lancamento encontrado para a busca."
                    : "Nenhum lancamento cadastrado."}
                </p>
              </div>
            ) : (
              <>
                {/* Mobile card view */}
                <div className="divide-y md:hidden">
                  {groupedEntries.map((group) => {
                    const isExpanded = expandedGroups.has(group.key);
                    const isDebito = group.type === "DEBITO";
                    const firstEntry = group.entries[0];

                    if (!group.hasMultiple) {
                      const entry = firstEntry;
                      const status = statusConfig[entry.status] || statusConfig.PENDENTE;
                      const StatusIcon = status.icon;
                      return (
                        <div key={entry.id} className="p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center shrink-0 pt-0.5">
                              <Checkbox checked={selectedIds.has(entry.id)} onCheckedChange={() => toggleSelect(entry.id)} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-semibold">{entry.personName}</p>
                                <Badge variant="outline" className={cn("text-[10px] h-5 border", entry.entrySource === "owner" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-slate-50 text-slate-600 border-slate-200")}>
                                  {entry.entrySource === "owner" ? "Prop." : "Loc."}
                                </Badge>
                                <Badge variant="outline" className={cn("text-[10px] h-5 border", isDebito ? "bg-red-50 text-red-700 border-red-200" : "bg-emerald-50 text-emerald-700 border-emerald-200")}>
                                  {isDebito ? "Debito" : "Credito"}
                                </Badge>
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {categoryLabels[entry.category] || entry.category}{entry.description ? ` - ${entry.description}` : ""}
                              </p>
                            </div>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0"><MoreVertical className="h-4 w-4" /></Button>
                              </DropdownMenuTrigger>
                              {renderEntryActions(entry)}
                            </DropdownMenu>
                          </div>
                          <div className="mt-2 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className={cn("text-[10px] h-5 border gap-1", status.className)}>
                                <StatusIcon className="h-3 w-3" />{status.label}
                              </Badge>
                              <span className="text-xs text-muted-foreground">Venc: {formatDate(entry.dueDate)}</span>
                            </div>
                            <span className={cn("font-semibold text-sm", isDebito ? "text-red-600" : "text-emerald-600")}>
                              {isDebito ? "- " : "+ "}{formatCurrency(entry.value)}
                            </span>
                          </div>
                        </div>
                      );
                    }

                    // Grouped installments - mobile
                    return (
                      <React.Fragment key={group.key}>
                        <div className="p-4 cursor-pointer" onClick={() => toggleGroup(group.key)}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center shrink-0 pt-0.5">
                              {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-semibold">{group.personName}</p>
                                <Badge variant="outline" className={cn("text-[10px] h-5 border", group.entrySource === "owner" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-slate-50 text-slate-600 border-slate-200")}>
                                  {group.entrySource === "owner" ? "Prop." : "Loc."}
                                </Badge>
                                <Badge variant="outline" className="text-[10px] h-5 border bg-blue-50 text-blue-700 border-blue-200">
                                  {group.entries.length}x parcelas
                                </Badge>
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {categoryLabels[group.category] || group.category}{group.description ? ` - ${group.description}` : ""}
                              </p>
                            </div>
                          </div>
                          <div className="mt-2 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              {group.paidCount > 0 && group.paidCount < group.entries.length ? (
                                <Badge variant="outline" className="text-[10px] h-5 border gap-1 bg-amber-50 text-amber-700 border-amber-200">
                                  <Clock className="h-3 w-3" /> {group.paidCount}/{group.entries.length} pagos
                                </Badge>
                              ) : group.paidCount === group.entries.length ? (
                                <Badge variant="outline" className={cn("text-[10px] h-5 border gap-1", statusConfig.PAGO.className)}>
                                  <CheckCircle2 className="h-3 w-3" /> Pago
                                </Badge>
                              ) : (
                                <Badge variant="outline" className={cn("text-[10px] h-5 border gap-1", statusConfig.PENDENTE.className)}>
                                  <Clock className="h-3 w-3" /> Pendente
                                </Badge>
                              )}
                            </div>
                            <span className={cn("font-semibold text-sm", isDebito ? "text-red-600" : "text-emerald-600")}>
                              {isDebito ? "- " : "+ "}{formatCurrency(group.totalValue)}
                            </span>
                          </div>
                        </div>
                        {isExpanded && group.entries.map((entry) => {
                          const status = statusConfig[entry.status] || statusConfig.PENDENTE;
                          const StatusIcon = status.icon;
                          return (
                            <div key={entry.id} className="p-4 pl-10 bg-muted/30 border-l-2 border-blue-200">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <Checkbox checked={selectedIds.has(entry.id)} onCheckedChange={() => toggleSelect(entry.id)} />
                                  <Badge variant="outline" className="text-[10px] h-5 border bg-blue-50 text-blue-700 border-blue-200">
                                    {entry.installmentNumber}/{entry.installmentTotal}
                                  </Badge>
                                  <span className="text-xs text-muted-foreground">{formatDate(entry.dueDate)}</span>
                                  <Badge variant="outline" className={cn("text-[10px] h-5 border gap-1", status.className)}>
                                    <StatusIcon className="h-3 w-3" />{status.label}
                                  </Badge>
                                </div>
                                <span className={cn("font-semibold text-sm", isDebito ? "text-red-600" : "text-emerald-600")}>
                                  {isDebito ? "- " : "+ "}{formatCurrency(entry.value)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </div>

                {/* Desktop table view */}
                <div className="overflow-x-auto hidden md:block">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-10">
                          <Checkbox
                            checked={filteredEntries.length > 0 && selectedIds.size === filteredEntries.length}
                            onCheckedChange={toggleSelectAll}
                          />
                        </TableHead>
                        <TableHead className="text-xs w-6"></TableHead>
                        <TableHead className="text-xs">Data</TableHead>
                        <TableHead className="text-xs">Pessoa</TableHead>
                        <TableHead className="text-xs">Tipo</TableHead>
                        <TableHead className="text-xs">Categoria</TableHead>
                        <TableHead className="text-xs">Descricao</TableHead>
                        <TableHead className="text-xs">Parcelas</TableHead>
                        <TableHead className="text-xs text-right">Valor (R$)</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs w-10"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {groupedEntries.map((group) => {
                        const isExpanded = expandedGroups.has(group.key);
                        const isDebito = group.type === "DEBITO";
                        const firstEntry = group.entries[0];

                        if (!group.hasMultiple) {
                          // Single entry - render normally
                          const entry = firstEntry;
                          const status = statusConfig[entry.status] || statusConfig.PENDENTE;
                          const StatusIcon = status.icon;
                          return (
                            <TableRow key={entry.id}>
                              <TableCell>
                                <Checkbox
                                  checked={selectedIds.has(entry.id)}
                                  onCheckedChange={() => toggleSelect(entry.id)}
                                />
                              </TableCell>
                              <TableCell></TableCell>
                              <TableCell className="text-xs">
                                {formatDate(entry.dueDate)}
                              </TableCell>
                              <TableCell className="text-xs">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-medium">{entry.personName}</span>
                                  <Badge variant="outline" className={cn("text-[10px] h-4 border px-1", entry.entrySource === "owner" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-slate-50 text-slate-600 border-slate-200")}>
                                    {entry.entrySource === "owner" ? "Prop." : "Loc."}
                                  </Badge>
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className={cn("text-xs border", isDebito ? "bg-red-50 text-red-700 border-red-200" : "bg-emerald-50 text-emerald-700 border-emerald-200")}>
                                  {isDebito ? "Debito" : "Credito"}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">{categoryLabels[entry.category] || entry.category}</TableCell>
                              <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">{entry.description || "-"}</TableCell>
                              <TableCell className="text-xs">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-muted-foreground">-</span>
                                  {entry.isRecurring && <span title="Recorrente"><Repeat className="h-3.5 w-3.5 text-purple-500" /></span>}
                                </div>
                              </TableCell>
                              <TableCell className={cn("text-xs font-semibold text-right", isDebito ? "text-red-600" : "text-emerald-600")}>
                                {isDebito ? "- " : "+ "}{formatCurrency(entry.value)}
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className={cn("text-xs border gap-1", status.className)}>
                                  <StatusIcon className="h-3 w-3" />
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
                                  {renderEntryActions(entry)}
                                </DropdownMenu>
                              </TableCell>
                            </TableRow>
                          );
                        }

                        // Group header row (installments grouped)
                        const allIds = group.entries.map((e) => e.id);
                        const allSelected = allIds.every((id) => selectedIds.has(id));
                        return (
                          <React.Fragment key={group.key}>
                            <TableRow
                              className="cursor-pointer hover:bg-muted/50"
                              onClick={() => toggleGroup(group.key)}
                            >
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                <Checkbox
                                  checked={allSelected}
                                  onCheckedChange={() => {
                                    if (allSelected) {
                                      setSelectedIds((prev) => {
                                        const next = new Set(prev);
                                        allIds.forEach((id) => next.delete(id));
                                        return next;
                                      });
                                    } else {
                                      setSelectedIds((prev) => {
                                        const next = new Set(prev);
                                        allIds.forEach((id) => next.add(id));
                                        return next;
                                      });
                                    }
                                  }}
                                />
                              </TableCell>
                              <TableCell className="px-0">
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                )}
                              </TableCell>
                              <TableCell className="text-xs">
                                {formatDate(firstEntry.dueDate)}
                              </TableCell>
                              <TableCell className="text-xs">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-medium">{group.personName}</span>
                                  <Badge variant="outline" className={cn("text-[10px] h-4 border px-1", group.entrySource === "owner" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-slate-50 text-slate-600 border-slate-200")}>
                                    {group.entrySource === "owner" ? "Prop." : "Loc."}
                                  </Badge>
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className={cn("text-xs border", isDebito ? "bg-red-50 text-red-700 border-red-200" : "bg-emerald-50 text-emerald-700 border-emerald-200")}>
                                  {isDebito ? "Debito" : "Credito"}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">{categoryLabels[group.category] || group.category}</TableCell>
                              <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">{group.description || "-"}</TableCell>
                              <TableCell className="text-xs">
                                <div className="flex items-center gap-1.5">
                                  <Badge variant="outline" className="text-xs border bg-blue-50 text-blue-700 border-blue-200">
                                    {group.entries.length}x parcelas
                                  </Badge>
                                  {group.paidCount > 0 && (
                                    <Badge variant="outline" className="text-[10px] h-4 border bg-emerald-50 text-emerald-700 border-emerald-200 px-1">
                                      {group.paidCount} pago{group.paidCount > 1 ? "s" : ""}
                                    </Badge>
                                  )}
                                  {group.isRecurring && <span title="Recorrente"><Repeat className="h-3.5 w-3.5 text-purple-500" /></span>}
                                </div>
                              </TableCell>
                              <TableCell className={cn("text-xs font-semibold text-right", isDebito ? "text-red-600" : "text-emerald-600")}>
                                {isDebito ? "- " : "+ "}{formatCurrency(group.totalValue)}
                              </TableCell>
                              <TableCell>
                                {group.pendingCount === group.entries.length ? (
                                  <Badge variant="outline" className={cn("text-xs border gap-1", statusConfig.PENDENTE.className)}>
                                    <Clock className="h-3 w-3" /> Pendente
                                  </Badge>
                                ) : group.paidCount === group.entries.length ? (
                                  <Badge variant="outline" className={cn("text-xs border gap-1", statusConfig.PAGO.className)}>
                                    <CheckCircle2 className="h-3 w-3" /> Pago
                                  </Badge>
                                ) : (
                                  <Badge variant="outline" className="text-xs border gap-1 bg-amber-50 text-amber-700 border-amber-200">
                                    <Clock className="h-3 w-3" /> {group.paidCount}/{group.entries.length}
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell></TableCell>
                            </TableRow>

                            {/* Expanded installment rows */}
                            {isExpanded && group.entries.map((entry) => {
                              const status = statusConfig[entry.status] || statusConfig.PENDENTE;
                              const StatusIcon = status.icon;
                              return (
                                <TableRow key={entry.id} className="bg-muted/30">
                                  <TableCell>
                                    <Checkbox
                                      checked={selectedIds.has(entry.id)}
                                      onCheckedChange={() => toggleSelect(entry.id)}
                                    />
                                  </TableCell>
                                  <TableCell></TableCell>
                                  <TableCell className="text-xs pl-8">{formatDate(entry.dueDate)}</TableCell>
                                  <TableCell className="text-xs text-muted-foreground">{entry.personName}</TableCell>
                                  <TableCell></TableCell>
                                  <TableCell></TableCell>
                                  <TableCell></TableCell>
                                  <TableCell className="text-xs">
                                    <Badge variant="outline" className="text-xs border bg-blue-50 text-blue-700 border-blue-200">
                                      {entry.installmentNumber}/{entry.installmentTotal}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className={cn("text-xs font-semibold text-right", isDebito ? "text-red-600" : "text-emerald-600")}>
                                    {isDebito ? "- " : "+ "}{formatCurrency(entry.value)}
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant="outline" className={cn("text-xs border gap-1", status.className)}>
                                      <StatusIcon className="h-3 w-3" />
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
                                      {renderEntryActions(entry)}
                                    </DropdownMenu>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </React.Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}

            {/* Pagination */}
            {totalEntries > PAGE_SIZE && (
              <div className="flex items-center justify-between gap-2 px-4 py-3 border-t flex-wrap">
                <p className="text-xs text-muted-foreground">
                  Mostrando {Math.min((page - 1) * PAGE_SIZE + 1, totalEntries)}-{Math.min(page * PAGE_SIZE, totalEntries)} de {totalEntries.toLocaleString("pt-BR")}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage(1)}
                  >
                    Primeira
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Anterior
                  </Button>
                  <span className="text-xs text-muted-foreground px-2">
                    Pagina {page} de {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={page >= totalPages || loading}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Proxima
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={page >= totalPages || loading}
                    onClick={() => setPage(totalPages)}
                  >
                    Ultima
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* New Entry Dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Novo Lancamento</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Para quem?</Label>
              <Select
                value={formTarget}
                onValueChange={(v) => {
                  setFormTarget(v as "locatario" | "proprietario");
                  setFormPersonId("");
                  setFormCategory("");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="locatario">Locatario</SelectItem>
                  <SelectItem value="proprietario">Proprietario</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="personId">
                {formTarget === "proprietario" ? "Proprietario" : "Locatario"}
              </Label>
              <Select value={formPersonId} onValueChange={setFormPersonId}>
                <SelectTrigger id="personId">
                  <SelectValue
                    placeholder={
                      formTarget === "proprietario"
                        ? "Selecione o proprietario"
                        : "Selecione o locatario"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {(formTarget === "proprietario" ? owners : tenants).map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="type">Tipo</Label>
                <Select value={formType} onValueChange={(v) => setFormType(v as "DEBITO" | "CREDITO")}>
                  <SelectTrigger id="type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="DEBITO">Debito</SelectItem>
                    <SelectItem value="CREDITO">Credito</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="category">Categoria</Label>
                <Select value={formCategory} onValueChange={setFormCategory}>
                  <SelectTrigger id="category">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    {(formTarget === "proprietario" ? ownerCategories : tenantCategories).map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {categoryLabels[cat] || cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Descricao</Label>
              <Input
                id="description"
                placeholder="Descricao do lancamento"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="destination">Destino</Label>
              <Select value={formDestination} onValueChange={setFormDestination}>
                <SelectTrigger id="destination">
                  <SelectValue placeholder="Para Imobiliária (padrão)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="IMOBILIARIA">Para Imobiliária</SelectItem>
                  <SelectItem value="PROPRIETARIO">Para Proprietário</SelectItem>
                  <SelectItem value="INQUILINO">Para Inquilino</SelectItem>
                  <SelectItem value="TERCEIRO">Para Terceiro</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {parseInt(formInstallments) > 1 && (
              <div className="space-y-2">
                <Label>Tipo de Valor</Label>
                <Select value={formValueMode} onValueChange={(v) => setFormValueMode(v as "TOTAL" | "PARCELA")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TOTAL">Valor Total (divide pelas parcelas)</SelectItem>
                    <SelectItem value="PARCELA">Valor da Parcela</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="value">
                  {formValueMode === "PARCELA" && parseInt(formInstallments) > 1
                    ? "Valor da Parcela (R$)"
                    : "Valor Total (R$)"}
                </Label>
                <Input
                  id="value"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0,00"
                  value={formValue}
                  onChange={(e) => setFormValue(e.target.value)}
                  required
                />
                {parseInt(formInstallments) > 1 && formValue && (
                  <p className="text-xs text-muted-foreground">
                    {formValueMode === "TOTAL"
                      ? `${parseInt(formInstallments)}x de ${formatCurrency(parseFloat(formValue) / parseInt(formInstallments))}`
                      : `Total: ${formatCurrency(parseFloat(formValue) * parseInt(formInstallments))}`}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="dueDate">Data de Vencimento</Label>
                <Input
                  id="dueDate"
                  type="date"
                  value={formDueDate}
                  onChange={(e) => setFormDueDate(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="installments">Número de Parcelas</Label>
                <Input
                  id="installments"
                  type="number"
                  min="1"
                  max="60"
                  value={formInstallments}
                  onChange={(e) => setFormInstallments(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="isRecurring">Recorrente</Label>
                <div className="flex items-center h-10">
                  <Switch
                    id="isRecurring"
                    checked={formIsRecurring}
                    onCheckedChange={setFormIsRecurring}
                  />
                  <span className="ml-2 text-sm text-muted-foreground">
                    {formIsRecurring ? "Sim" : "Nao"}
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Observações</Label>
              <Input
                id="notes"
                placeholder="Observações adicionais (opcional)"
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={submitting || !formPersonId || !formCategory || !formValue || !formDueDate}>
                {submitting ? "Salvando..." : "Criar Lancamento"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir Lancamento</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir este lancamento de{" "}
              <strong>{entryToDelete?.personName}</strong>? Esta acao nao pode ser desfeita.
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

      {/* Bulk Delete Confirmation Dialog */}
      <AlertDialog open={bulkDeleteDialogOpen} onOpenChange={setBulkDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir Lancamentos</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir <strong>{selectedIds.size}</strong> lancamento(s) selecionado(s)? Esta acao nao pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Excluir Todos
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit Entry Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Editar Lancamento</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Pessoa</Label>
              <Input value={editingEntry?.personName || ""} disabled className="bg-muted" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Tipo</Label>
                <Select value={formType} onValueChange={(v) => setFormType(v as "DEBITO" | "CREDITO")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="DEBITO">Debito</SelectItem>
                    <SelectItem value="CREDITO">Credito</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Categoria</Label>
                <Select value={formCategory} onValueChange={setFormCategory}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>
                    {(formTarget === "proprietario" ? ownerCategories : tenantCategories).map((cat) => (
                      <SelectItem key={cat} value={cat}>{categoryLabels[cat] || cat}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Descricao</Label>
              <Input value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="Descricao do lancamento" />
            </div>

            <div className="space-y-2">
              <Label>Destino</Label>
              <Select value={formDestination} onValueChange={setFormDestination}>
                <SelectTrigger><SelectValue placeholder="Para Imobiliária (padrão)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="IMOBILIARIA">Para Imobiliaria</SelectItem>
                  <SelectItem value="PROPRIETARIO">Para Proprietario</SelectItem>
                  <SelectItem value="INQUILINO">Para Inquilino</SelectItem>
                  <SelectItem value="TERCEIRO">Para Terceiro</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Valor (R$)</Label>
                <Input type="number" step="0.01" min="0" value={formValue} onChange={(e) => setFormValue(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label>Data de Vencimento</Label>
                <Input type="date" value={formDueDate} onChange={(e) => setFormDueDate(e.target.value)} required />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Recorrente</Label>
              <div className="flex items-center h-10">
                <Switch checked={formIsRecurring} onCheckedChange={setFormIsRecurring} />
                <span className="ml-2 text-sm text-muted-foreground">{formIsRecurring ? "Sim" : "Nao"}</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Observacoes</Label>
              <Input value={formNotes} onChange={(e) => setFormNotes(e.target.value)} placeholder="Observacoes adicionais (opcional)" />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>Cancelar</Button>
              <Button type="submit" disabled={submitting || !formCategory || !formValue || !formDueDate}>
                {submitting ? "Salvando..." : "Salvar Alteracoes"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
