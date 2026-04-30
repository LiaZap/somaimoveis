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
import { PaymentDetailSheet } from "@/components/financeiro/payment-detail-sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  MoreVertical,
  Pencil,
  Trash2,
  CheckCircle2,
  Clock,
  AlertTriangle,
  TrendingUp,
  DollarSign,
  ArrowDownRight,
  CalendarPlus,
  Receipt,
  Building2,
  Landmark,
  Download,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PaymentForm } from "@/components/forms/payment-form";
import { GenerateChargesDialog } from "@/components/forms/generate-charges-dialog";

interface Payment {
  id: string;
  code: string;
  contractId: string;
  tenantId: string;
  ownerId: string;
  value: number;
  paidValue: number | null;
  fineValue: number | null;
  interestValue: number | null;
  discountValue: number | null;
  dueDate: string;
  paidAt: string | null;
  createdAt: string;
  status: string;
  paymentMethod: string | null;
  description: string | null;
  splitOwnerValue: number | null;
  splitAdminValue: number | null;
  notes: string | null;
  nossoNumero?: string;
  linhaDigitavel?: string;
  boletoStatus?: string;
  notifications?: { id: string; channel: string; sentAt: string }[];
  contract: {
    id: string;
    code: string;
    property: { title: string };
  };
  tenant: { id: string; name: string };
  owner: { id: string; name: string };
}

const statusConfig: Record<string, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  PAGO: { label: "Pago", className: "bg-emerald-100 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
  PENDENTE: { label: "Pendente", className: "bg-yellow-100 text-yellow-700 border-yellow-200", icon: Clock },
  ATRASADO: { label: "Atrasado", className: "bg-red-100 text-red-700 border-red-200", icon: AlertTriangle },
  CANCELADO: { label: "Cancelado", className: "bg-gray-100 text-gray-500 border-gray-200", icon: Clock },
  PARCIAL: { label: "Parcial", className: "bg-blue-100 text-blue-700 border-blue-200", icon: Clock },
};

const methodLabels: Record<string, string> = {
  BOLETO: "Boleto",
  PIX: "PIX",
  CARTAO: "Cartao",
  TRANSFERENCIA: "Transferencia",
  DINHEIRO: "Dinheiro",
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

interface PaymentBreakdown {
  aluguel: number;
  aluguelOriginal?: number;
  isProrata?: boolean;
  prorataDias?: number;
  creditos?: number;
  desconto?: number; // legacy
  debitos?: number;
  condominio: number;
  iptu: number;
  seguroFianca?: number;
  taxaBancaria?: number;
  intermediacao?: number;
  total: number;
  lancamentos?: { tipo: string; categoria: string; descricao: string; valor: number }[];
}

function parseBreakdown(notes: string | null): PaymentBreakdown | null {
  if (!notes) return null;
  try {
    const parsed = JSON.parse(notes);
    if (typeof parsed.aluguel === "number") return parsed as PaymentBreakdown;
    return null;
  } catch {
    return null;
  }
}

export default function FinanceiroPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-12"><p className="text-sm text-muted-foreground">Carregando...</p></div>}>
      <FinanceiroContent />
    </Suspense>
  );
}

function FinanceiroContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [activeTab, setActiveTab] = useState("todos");
  // Filtros de data
  const [dateField, setDateField] = useState<"dueDate" | "paidAt" | "createdAt">("dueDate");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Paginacao server-side
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalEntries, setTotalEntries] = useState(0);
  // Stats agregados (server-side)
  const [stats, setStats] = useState({
    totalFaturamento: 0,
    totalAReceber: 0,
    totalEmAtraso: 0,
    recebidoEsteMes: 0,
  });
  // Sheet lateral de detalhe (conferencia rapida)
  const [detailPaymentId, setDetailPaymentId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  function openDetail(paymentId: string) {
    setDetailPaymentId(paymentId);
    setDetailOpen(true);
  }
  const [monthShortcut, setMonthShortcut] = useState(""); // YYYY-MM ou ""

  // Aplica atalho de mes: preenche dateFrom (1o dia) e dateTo (ultimo dia)
  function applyMonthShortcut(monthYYYYMM: string) {
    setMonthShortcut(monthYYYYMM);
    if (!monthYYYYMM) {
      setDateFrom("");
      setDateTo("");
      return;
    }
    const [y, m] = monthYYYYMM.split("-").map(Number);
    const firstDay = new Date(y, m - 1, 1);
    const lastDay = new Date(y, m, 0); // dia 0 do proximo = ultimo do atual
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setDateFrom(fmt(firstDay));
    setDateTo(fmt(lastDay));
  }
  const [formOpen, setFormOpen] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<Payment | undefined>(undefined);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [paymentToDelete, setPaymentToDelete] = useState<Payment | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [boletoLoading, setBoletoLoading] = useState<Record<string, boolean>>({});
  const [notifyLoading, setNotifyLoading] = useState<Record<string, boolean>>({});

  function buildQueryParams() {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", String(PAGE_SIZE));
    if (activeTab !== "todos") params.set("tab", activeTab);
    if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (dateField) params.set("dateField", dateField);
    return params.toString();
  }

  async function fetchPayments() {
    setLoading(true);
    try {
      const response = await fetch(`/api/payments?${buildQueryParams()}`);
      if (response.ok) {
        const data = await response.json();
        setPayments(data.data || []);
        setTotalPages(data.pagination?.totalPages || 1);
        setTotalEntries(data.pagination?.total || 0);
      }
    } catch (error) {
      console.error("Erro ao buscar pagamentos:", error);
    } finally {
      setLoading(false);
    }
  }

  async function fetchStats() {
    try {
      const res = await fetch("/api/payments/stats");
      if (res.ok) {
        const data = await res.json();
        setStats({
          totalFaturamento: data.totalFaturamento || 0,
          totalAReceber: data.totalAReceber || 0,
          totalEmAtraso: data.totalEmAtraso || 0,
          recebidoEsteMes: data.recebidoEsteMes || 0,
        });
      }
    } catch (error) {
      console.error("Erro ao buscar stats:", error);
    }
  }

  async function refresh() {
    await Promise.all([fetchPayments(), fetchStats()]);
  }

  // Debounce de busca
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset paginacao ao mudar filtros
  useEffect(() => {
    setPage(1);
  }, [activeTab, debouncedSearch, dateField, dateFrom, dateTo]);

  // Stats iniciais (sem dependencia de filtros �?? mostra totalizadores globais)
  useEffect(() => {
    fetchStats();
  }, []);

  // Refetch ao mudar pagina ou filtros
  useEffect(() => {
    fetchPayments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, activeTab, debouncedSearch, dateField, dateFrom, dateTo]);

  useEffect(() => {
    if (searchParams.get("novo") === "true") {
      setSelectedPayment(undefined);
      setFormOpen(true);
      router.replace("/financeiro");
    }
  }, [searchParams, router]);

  // Stats vem do servidor (server-side) �?? ja filtrados/agregados.
  const { totalFaturamento, totalAReceber, totalEmAtraso, recebidoEsteMes } = stats;

  // Helper: pagamento está atrasado (PENDENTE com vencimento passado)
  // Mantido para badges visuais nas linhas individuais.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isOverdue = (p: Payment) => {
    if (p.status === "ATRASADO") return true;
    if (p.status === "PENDENTE") {
      const due = new Date(p.dueDate);
      due.setHours(0, 0, 0, 0);
      return due < today;
    }
    return false;
  };

  // Servidor ja aplicou filtros/busca/aba �?? `payments` ja sao as linhas da pagina atual
  const filteredPayments = payments;

  function handleNewPayment() {
    setSelectedPayment(undefined);
    setFormOpen(true);
  }

  function handleEditPayment(payment: Payment) {
    setSelectedPayment(payment);
    setFormOpen(true);
  }

  function handleDeleteClick(payment: Payment) {
    setPaymentToDelete(payment);
    setDeleteDialogOpen(true);
  }

  async function handleDeleteConfirm() {
    if (!paymentToDelete) return;
    try {
      const response = await fetch(`/api/payments/${paymentToDelete.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || "Erro ao excluir pagamento");
        return;
      }
      refresh();
    } catch (error) {
      toast.error("Erro ao excluir pagamento");
    } finally {
      setDeleteDialogOpen(false);
      setPaymentToDelete(null);
    }
  }

  async function handleMarkAsPaid(payment: Payment) {
    try {
      const response = await fetch(`/api/payments/${payment.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "PAGO",
          paidAt: new Date().toISOString(),
          paidValue: payment.value,
        }),
      });
      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || "Erro ao atualizar pagamento");
        return;
      }
      refresh();
    } catch (error) {
      toast.error("Erro ao atualizar pagamento");
    }
  }

  function handleFormSuccess() {
    refresh();
  }

  const handleEmitBoleto = async (paymentId: string) => {
    setBoletoLoading(prev => ({ ...prev, [paymentId]: true }));
    try {
      const res = await fetch(`/api/payments/${paymentId}/boleto`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Erro ao emitir boleto (${res.status})`);
      toast.success("Boleto emitido com sucesso!");
      refresh();
    } catch (err: any) {
      toast.error(err.message || "Erro ao emitir boleto", { duration: 15000 });
    } finally {
      setBoletoLoading(prev => ({ ...prev, [paymentId]: false }));
    }
  };

  const handleDownloadBoleto = async (paymentId: string, code: string) => {
    try {
      const res = await fetch(`/api/payments/${paymentId}/boleto`);
      if (!res.ok) throw new Error("Erro ao baixar boleto");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `boleto-${code}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error(err.message || "Erro ao baixar boleto");
    }
  };

  const handleEmitBoletosBatch = async () => {
    if (!confirm("Emitir boletos para todos os pagamentos pendentes?")) return;
    try {
      const res = await fetch("/api/payments/boleto/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Erro ao emitir boletos (${res.status})`);
      if (data.emitidos > 0) {
        toast.success(`${data.emitidos} boleto(s) emitido(s)`);
      }
      if (data.erros && data.erros.length > 0) {
        for (const e of data.erros) {
          toast.error(`${e.code}: ${e.error}`, { duration: 15000 });
        }
      }
      refresh();
    } catch (err: any) {
      toast.error(err.message || "Erro ao emitir boletos");
    }
  };

  const [batchNotifyLoading, setBatchNotifyLoading] = useState(false);

  const handleSendNotifyBatch = async () => {
    if (!confirm("Enviar cobranças (WhatsApp + Email) para todos os boletos emitidos que ainda não foram notificados?")) return;
    setBatchNotifyLoading(true);
    try {
      const res = await fetch("/api/payments/notify/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Erro ao enviar cobranças (${res.status})`);
      toast.success(data.message, { duration: 10000 });

      // Poll progress if processing in background
      if (data.processing) {
        const pollInterval = setInterval(async () => {
          try {
            const progressRes = await fetch("/api/payments/notify/batch");
            const progress = await progressRes.json();
            if (progress.done) {
              clearInterval(pollInterval);
              setBatchNotifyLoading(false);
              toast.success(`Envio concluído: ${progress.sent} enviado(s), ${progress.failed} falha(s)`, { duration: 15000 });
              if (progress.errors?.length > 0) {
                for (const e of progress.errors) {
                  toast.error(`${e.code}: ${e.error}`, { duration: 15000 });
                }
              }
              refresh();
            } else {
              toast.info(`Progresso: ${progress.sent + progress.failed}/${progress.total} processado(s)...`, { duration: 5000 });
            }
          } catch { /* ignore poll errors */ }
        }, 30000); // Check every 30 seconds
      } else {
        setBatchNotifyLoading(false);
      }
    } catch (err: any) {
      toast.error(err.message || "Erro ao enviar cobranças em lote", { duration: 15000 });
      setBatchNotifyLoading(false);
    }
  };

  const handleSendNotify = async (paymentId: string, channels: string[]) => {
    setNotifyLoading(prev => ({ ...prev, [paymentId]: true }));
    try {
      const res = await fetch(`/api/payments/${paymentId}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Erro ao enviar cobrança (${res.status})`);
      const successResults = data.results?.filter((r: any) => r.success) || [];
      const failResults = data.results?.filter((r: any) => !r.success) || [];
      if (successResults.length > 0) {
        const boletoMsg = data.boletoEmitido ? " (boleto emitido)" : "";
        const pdfMsg = data.pdfEnviado ? " + PDF" : "";
        toast.success(`Cobranca enviada via ${successResults.map((r: any) => r.channel).join(", ")}${pdfMsg}${boletoMsg}`);
      }
      if (failResults.length > 0) {
        for (const f of failResults) {
          toast.error(`${f.channel}: ${f.error}`);
        }
      }
      refresh();
    } catch (err: any) {
      toast.error(err.message || "Erro ao enviar cobranca");
    } finally {
      setNotifyLoading(prev => ({ ...prev, [paymentId]: false }));
    }
  };

  return (
    <div className="flex flex-col">
      <Header title="Financeiro" subtitle="Controle de pagamentos e receitas" />

      <div className="p-4 sm:p-6 space-y-4">
        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Faturamento Total</p>
                  <p className="text-2xl font-bold mt-1">
                    {loading ? "..." : formatCurrency(totalFaturamento)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Todos os pagos</p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100">
                  <TrendingUp className="h-5 w-5 text-emerald-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">A Receber</p>
                  <p className="text-2xl font-bold mt-1">
                    {loading ? "..." : formatCurrency(totalAReceber)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {payments.filter((p) => p.status === "PENDENTE").length} cobrancas pendentes
                  </p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-yellow-100">
                  <Clock className="h-5 w-5 text-yellow-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Em Atraso</p>
                  <p className="text-2xl font-bold mt-1 text-red-600">
                    {loading ? "..." : formatCurrency(totalEmAtraso)}
                  </p>
                  <div className="flex items-center gap-1 mt-1">
                    <ArrowDownRight className="h-3.5 w-3.5 text-red-500" />
                    <span className="text-xs text-red-500 font-medium">
                      {payments.filter((p) => isOverdue(p)).length} cobrança(s) atrasada(s)
                    </span>
                  </div>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-100">
                  <AlertTriangle className="h-5 w-5 text-red-500" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Recebido este Mes</p>
                  <p className="text-2xl font-bold mt-1">
                    {loading ? "..." : formatCurrency(recebidoEsteMes)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {recebidoEsteMes > 0 ? "este mes" : "?"}
                  </p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100">
                  <DollarSign className="h-5 w-5 text-violet-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Payments Table */}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-0">
            <div className="flex flex-col gap-3 p-4 border-b">
              <div className="flex items-center gap-2 flex-wrap">
                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-auto">
                  <TabsList className="h-9 sm:h-8">
                    <TabsTrigger value="todos" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">Todos</TabsTrigger>
                    <TabsTrigger value="pendentes" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">Pendentes</TabsTrigger>
                    <TabsTrigger value="nao_emitidos" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">Não Emitidos</TabsTrigger>
                    <TabsTrigger value="emitidos" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">Emitidos</TabsTrigger>
                    <TabsTrigger value="pagos" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">Pagos</TabsTrigger>
                    <TabsTrigger value="atrasados" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">Atrasados</TabsTrigger>
                  </TabsList>
                </Tabs>
                <Button size="sm" variant="outline" className="gap-1.5 h-10 sm:h-8 text-xs" onClick={() => setGenerateOpen(true)}>
                  <CalendarPlus className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Gerar Cobrancas</span>
                  <span className="sm:hidden">Gerar</span>
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5 h-10 sm:h-8 text-xs" onClick={handleEmitBoletosBatch}>
                  <Receipt className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Emitir Boletos</span>
                  <span className="sm:hidden">Boletos</span>
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5 h-10 sm:h-8 text-xs" onClick={handleSendNotifyBatch} disabled={batchNotifyLoading}>
                  <Send className="h-3.5 w-3.5" />
                  {batchNotifyLoading ? (
                    <span>Enviando...</span>
                  ) : (
                    <>
                      <span className="hidden sm:inline">Enviar Cobranças</span>
                      <span className="sm:hidden">Cobrar</span>
                    </>
                  )}
                </Button>
                <Button size="sm" className="gap-1.5 h-10 sm:h-8 text-xs" onClick={handleNewPayment}>
                  <Plus className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Nova Cobranca</span>
                  <span className="sm:hidden">Nova</span>
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Buscar pagamento..."
                    className="pl-9 h-10 sm:h-8 w-full sm:w-[200px] text-sm sm:text-xs"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>

                {/* Filtro por data */}
                <Select value={dateField} onValueChange={(v) => setDateField(v as typeof dateField)}>
                  <SelectTrigger className="h-10 sm:h-8 w-[130px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dueDate">Vencimento</SelectItem>
                    <SelectItem value="paidAt">Pagamento</SelectItem>
                    <SelectItem value="createdAt">Criado em</SelectItem>
                  </SelectContent>
                </Select>

                {/* Atalho rapido por mes (jan/fev/.../dez) */}
                <Input
                  type="month"
                  value={monthShortcut}
                  onChange={(e) => applyMonthShortcut(e.target.value)}
                  className="h-10 sm:h-8 w-[150px] text-xs"
                  title="Selecionar mes inteiro"
                />

                <span className="text-xs text-muted-foreground hidden md:inline">ou</span>

                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => {
                    setDateFrom(e.target.value);
                    setMonthShortcut("");
                  }}
                  className="h-10 sm:h-8 w-[140px] text-xs"
                  placeholder="De"
                  title="Data inicial"
                />
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => {
                    setDateTo(e.target.value);
                    setMonthShortcut("");
                  }}
                  className="h-10 sm:h-8 w-[140px] text-xs"
                  placeholder="Até"
                  title="Data final"
                />
                {(dateFrom || dateTo) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-10 sm:h-8 text-xs"
                    onClick={() => {
                      setDateFrom("");
                      setDateTo("");
                      setMonthShortcut("");
                    }}
                  >
                    Limpar datas
                  </Button>
                )}
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">Carregando...</p>
              </div>
            ) : filteredPayments.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">
                  {search
                    ? "Nenhum pagamento encontrado para a busca."
                    : "Nenhum pagamento cadastrado."}
                </p>
              </div>
            ) : (
              <>
              {/* Mobile card view */}
              <div className="divide-y md:hidden">
                {filteredPayments.map((payment) => {
                  const displayStatus = isOverdue(payment) ? "ATRASADO" : payment.status;
                  const status = statusConfig[displayStatus] || {
                    label: payment.status,
                    className: "bg-muted text-muted-foreground",
                    icon: Clock,
                  };
                  const StatusIcon = status.icon;
                  const breakdown = parseBreakdown(payment.notes);
                  return (
                    <div key={payment.id} className="p-4 active:bg-muted/50 cursor-pointer" onClick={() => openDetail(payment.id)}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold">{payment.tenant?.name || "N/A"}</p>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {payment.contract.code} - {payment.contract.property?.title || "N/A"}
                          </p>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0" onClick={(e) => e.stopPropagation()}>
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleEditPayment(payment); }}>
                              <Pencil className="h-3.5 w-3.5 mr-2" /> Editar
                            </DropdownMenuItem>
                            {payment.status !== "PAGO" && (
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleMarkAsPaid(payment); }}>
                                <CheckCircle2 className="h-3.5 w-3.5 mr-2" /> Marcar como Pago
                              </DropdownMenuItem>
                            )}
                            {!payment.nossoNumero && (payment.status === "PENDENTE" || payment.status === "ATRASADO") && (
                              <DropdownMenuItem
                                disabled={boletoLoading[payment.id]}
                                onClick={(e) => { e.stopPropagation(); handleEmitBoleto(payment.id); }}
                              >
                                <Receipt className="h-3.5 w-3.5 mr-2" />
                                {boletoLoading[payment.id] ? "Emitindo..." : "Emitir Boleto"}
                              </DropdownMenuItem>
                            )}
                            {payment.nossoNumero && (
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDownloadBoleto(payment.id, payment.code); }}>
                                <Receipt className="h-3.5 w-3.5 mr-2" /> Baixar Boleto
                              </DropdownMenuItem>
                            )}
                            {(payment.status === "PENDENTE" || payment.status === "ATRASADO") && (
                              <DropdownMenuItem
                                disabled={notifyLoading[payment.id]}
                                onClick={(e) => { e.stopPropagation(); handleSendNotify(payment.id, ["whatsapp", "email"]); }}
                              >
                                <Send className="h-3.5 w-3.5 mr-2" />
                                {notifyLoading[payment.id] ? "Enviando..." : "Enviar Cobranca"}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem variant="destructive" onClick={(e) => { e.stopPropagation(); handleDeleteClick(payment); }}>
                              <Trash2 className="h-3.5 w-3.5 mr-2" /> Excluir
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className={cn("text-[10px] h-5 border gap-1", status.className)}>
                            <StatusIcon className="h-3 w-3" />
                            {status.label}
                          </Badge>
                          {payment.boletoStatus && (
                            <Badge variant="outline" className="text-[10px] h-5 border gap-1 bg-blue-50 text-blue-700 border-blue-200">
                              <Receipt className="h-3 w-3" />
                              {payment.boletoStatus}
                            </Badge>
                          )}
                          {(payment.notifications?.length ?? 0) > 0 && (
                            <Badge variant="outline" className="text-[10px] h-5 border gap-1 bg-green-50 text-green-700 border-green-200">
                              <Send className="h-3 w-3" />
                              Enviado
                            </Badge>
                          )}
                          {breakdown && breakdown.condominio > 0 && (
                            <Badge variant="outline" className="text-[10px] h-5 border gap-1 bg-orange-50 text-orange-700 border-orange-200">
                              <Building2 className="h-3 w-3" />
                              Cond.
                            </Badge>
                          )}
                          {breakdown && breakdown.iptu > 0 && (
                            <Badge variant="outline" className="text-[10px] h-5 border gap-1 bg-purple-50 text-purple-700 border-purple-200">
                              <Landmark className="h-3 w-3" />
                              IPTU
                            </Badge>
                          )}
                          {breakdown && (breakdown.seguroFianca ?? 0) > 0 && (
                            <Badge variant="outline" className="text-[10px] h-5 border gap-1 bg-cyan-50 text-cyan-700 border-cyan-200">
                              Seguro
                            </Badge>
                          )}
                          {breakdown && (breakdown.creditos ?? breakdown.desconto ?? 0) > 0 && (
                            <Badge variant="outline" className="text-[10px] h-5 border gap-1 bg-green-50 text-green-700 border-green-200">
                              -Desc
                            </Badge>
                          )}
                          {breakdown && (breakdown.debitos ?? 0) > 0 && (
                            <Badge variant="outline" className="text-[10px] h-5 border gap-1 bg-red-50 text-red-700 border-red-200">
                              +Déb
                            </Badge>
                          )}
                          <span className="text-xs text-muted-foreground">Venc: {formatDate(payment.dueDate)}</span>
                        </div>
                        <span className="font-semibold text-sm">{formatCurrency(payment.value)}</span>
                      </div>
                      {breakdown && (
                        <div className="mt-1 text-[11px] text-muted-foreground space-y-0.5">
                          <p>
                            Aluguel: {formatCurrency(breakdown.aluguel)}
                            {breakdown.condominio > 0 ? ` + Cond: ${formatCurrency(breakdown.condominio)}` : ""}
                            {breakdown.iptu > 0 ? ` + IPTU: ${formatCurrency(breakdown.iptu)}` : ""}
                            {(breakdown.seguroFianca ?? 0) > 0 ? ` + Seguro: ${formatCurrency(breakdown.seguroFianca!)}` : ""}
                            {(breakdown.taxaBancaria ?? 0) > 0 ? ` + Tx Banc: ${formatCurrency(breakdown.taxaBancaria!)}` : ""}
                            {(breakdown.debitos ?? 0) > 0 ? ` + Déb: ${formatCurrency(breakdown.debitos!)}` : ""}
                            {(breakdown.creditos ?? breakdown.desconto ?? 0) > 0 ? ` - Créd: ${formatCurrency((breakdown.creditos ?? breakdown.desconto)!)}` : ""}
                          </p>
                          {breakdown.lancamentos && breakdown.lancamentos.length > 0 && (
                            <p className="text-[10px] text-muted-foreground/70">
                              {breakdown.lancamentos.map((l, i) => (
                                <span key={i}>{l.tipo === "CREDITO" ? "(-) " : "(+) "}{l.descricao}: {formatCurrency(l.valor)}{i < breakdown.lancamentos!.length - 1 ? " | " : ""}</span>
                              ))}
                            </p>
                          )}
                        </div>
                      )}
                      {payment.paidAt && (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Pago em {formatDate(payment.paidAt)}
                          {payment.paymentMethod ? ` via ${methodLabels[payment.paymentMethod] || payment.paymentMethod}` : ""}
                        </p>
                      )}
                      {payment.nossoNumero && (
                        <p className="mt-1 text-[11px] text-muted-foreground font-mono">
                          Boleto: {payment.nossoNumero}
                        </p>
                      )}
                      {payment.nossoNumero && (
                        <div className="mt-2 flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-3 text-xs gap-1 text-blue-600 border-blue-200"
                            onClick={(e) => { e.stopPropagation(); handleDownloadBoleto(payment.id, payment.code); }}
                          >
                            <Download className="h-3.5 w-3.5" />
                            PDF
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-3 text-xs gap-1 text-green-600 border-green-200"
                                disabled={notifyLoading[payment.id]}
                              >
                                <Send className="h-3.5 w-3.5" />
                                {notifyLoading[payment.id] ? "Enviando..." : "Cobrar"}
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleSendNotify(payment.id, ["whatsapp"]); }}>
                                WhatsApp
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleSendNotify(payment.id, ["email"]); }}>
                                Email
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleSendNotify(payment.id, ["whatsapp", "email"]); }}>
                                WhatsApp + Email
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Desktop table view */}
              <div className="overflow-x-auto hidden md:block">
              <Table className="table-fixed w-full">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-xs w-[75px]">Código</TableHead>
                    <TableHead className="text-xs w-[65px]">Contrato</TableHead>
                    <TableHead className="text-xs w-[110px]">Locatário</TableHead>
                    <TableHead className="text-xs text-right w-[85px]">Valor</TableHead>
                    <TableHead className="text-xs w-[130px]">Composição</TableHead>
                    <TableHead className="text-xs w-[80px]">Vencimento</TableHead>
                    <TableHead className="text-xs w-[80px]">Pagamento</TableHead>
                    <TableHead className="text-xs w-[110px]">Status</TableHead>
                    <TableHead className="text-xs w-[90px]">Nº Boleto</TableHead>
                    <TableHead className="text-xs w-[60px]">Metodo</TableHead>
                    <TableHead className="text-xs w-[120px]">Boleto</TableHead>
                    <TableHead className="text-xs w-[65px]">Envio</TableHead>
                    <TableHead className="text-xs w-[40px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPayments.map((payment) => {
                    const displayStatus = isOverdue(payment) ? "ATRASADO" : payment.status;
                    const status = statusConfig[displayStatus] || {
                      label: payment.status,
                      className: "bg-muted text-muted-foreground",
                      icon: Clock,
                    };
                    const StatusIcon = status.icon;
                    const breakdown = parseBreakdown(payment.notes);
                    return (
                      <TableRow key={payment.id} className="cursor-pointer hover:bg-muted/30" onClick={() => openDetail(payment.id)}>
                        <TableCell className="font-mono text-xs">{payment.code}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {payment.contract.code}
                        </TableCell>
                        <TableCell className="text-xs font-medium truncate max-w-0" title={payment.tenant?.name || ""}>
                          {payment.tenant?.name || "N/A"}
                        </TableCell>
                        <TableCell className="text-xs font-semibold text-right">
                          {formatCurrency(payment.value)}
                        </TableCell>
                        <TableCell className="overflow-hidden">
                          {breakdown ? (
                            <TooltipProvider delayDuration={200}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="cursor-help space-y-0.5">
                                    <span className="text-[10px] text-muted-foreground">Aluguel: {formatCurrency(breakdown.aluguel)}</span>
                                    <div className="flex items-center gap-1 flex-wrap">
                                      {(breakdown.taxaBancaria ?? 0) > 0 && (
                                        <span className="text-[10px] text-muted-foreground">+ Tx Banc: {formatCurrency(breakdown.taxaBancaria!)}</span>
                                      )}
                                      {(breakdown.debitos ?? 0) > 0 && (
                                        <span className="text-[10px] text-red-600">+ Déb: {formatCurrency(breakdown.debitos!)}</span>
                                      )}
                                      {(breakdown.creditos ?? breakdown.desconto ?? 0) > 0 && (
                                        <span className="text-[10px] text-green-600">- Créd: {formatCurrency((breakdown.creditos ?? breakdown.desconto)!)}</span>
                                      )}
                                    </div>
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="max-w-sm text-xs space-y-1 p-3">
                                  <p className="font-medium border-b pb-1 mb-1">Composição do Valor</p>
                                  {breakdown.isProrata ? (
                                    <p>Aluguel: {formatCurrency(breakdown.aluguel)} <span className="text-muted-foreground">({breakdown.prorataDias}/30 dias - original: {formatCurrency(breakdown.aluguelOriginal!)})</span></p>
                                  ) : (
                                    <p>Aluguel: {formatCurrency(breakdown.aluguel)}</p>
                                  )}
                                  {breakdown.condominio > 0 && <p className="text-orange-600">+ Condomínio: {formatCurrency(breakdown.condominio)}</p>}
                                  {breakdown.iptu > 0 && <p className="text-purple-600">+ IPTU: {formatCurrency(breakdown.iptu)}</p>}
                                  {(breakdown.seguroFianca ?? 0) > 0 && <p className="text-cyan-600">+ Seguro Fiança: {formatCurrency(breakdown.seguroFianca!)}</p>}
                                  {(breakdown.taxaBancaria ?? 0) > 0 && <p>+ Taxa Bancária: {formatCurrency(breakdown.taxaBancaria!)}</p>}
                                  {breakdown.lancamentos && breakdown.lancamentos.length > 0 && (
                                    <>
                                      <p className="font-medium border-t pt-1 mt-1">Lançamentos</p>
                                      {breakdown.lancamentos.map((l, i) => (
                                        <p key={i} className={l.tipo === "CREDITO" ? "text-green-600" : "text-red-600"}>
                                          {l.tipo === "CREDITO" ? "(-) " : "(+) "}{l.descricao}: {formatCurrency(l.valor)}
                                        </p>
                                      ))}
                                    </>
                                  )}
                                  <p className="font-semibold border-t pt-1 mt-1">= Total: {formatCurrency(breakdown.total)}</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatDate(payment.dueDate)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {payment.paidAt ? formatDate(payment.paidAt) : "-"}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-0.5">
                            <Badge variant="outline" className={cn("text-[10px] border gap-0.5", status.className)}>
                              <StatusIcon className="h-3 w-3" />
                              {status.label}
                            </Badge>
                            {payment.boletoStatus && (() => {
                              // Extrair tipo de liquidação do description (ex: "Sicredi: PIX | ...")
                              let tipoLabel = payment.boletoStatus;
                              if (payment.description && payment.description.startsWith("Sicredi:")) {
                                const tipo = payment.description.split("|")[0].replace("Sicredi:", "").trim();
                                if (tipo === "PIX") tipoLabel = "PIX";
                                else if (tipo === "REDE") tipoLabel = "Rede Sicredi";
                                else if (tipo === "COMPE" || tipo.includes("COMPE")) tipoLabel = "Compensando";
                                else if (tipo === "AVISO DE PAGAMENTO REDE") tipoLabel = "Rede Sicredi";
                                else if (tipo === "AVISO DE PAGAMENTO COMPE") tipoLabel = "Compensando";
                                else if (tipo) tipoLabel = tipo;
                              }
                              return (
                                <TooltipProvider delayDuration={200}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Badge variant="outline" className="text-[10px] border gap-0.5 bg-blue-50 text-blue-700 border-blue-200 cursor-default whitespace-nowrap">
                                        <Receipt className="h-2.5 w-2.5" />
                                        {tipoLabel}
                                      </Badge>
                                    </TooltipTrigger>
                                    {payment.description && payment.description.startsWith("Sicredi:") && (
                                      <TooltipContent side="bottom" className="max-w-xs">
                                        <p className="text-xs whitespace-pre-line">{payment.description.replace(/ \| /g, "\n")}</p>
                                      </TooltipContent>
                                    )}
                                  </Tooltip>
                                </TooltipProvider>
                              );
                            })()}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-[10px] text-muted-foreground overflow-hidden truncate max-w-0" title={payment.nossoNumero || ""}>
                          {payment.nossoNumero || "-"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {payment.paymentMethod ? (methodLabels[payment.paymentMethod] || payment.paymentMethod) : "-"}
                        </TableCell>
                        <TableCell className="overflow-visible">
                          <div className="flex items-center gap-0.5">
                          {payment.nossoNumero ? (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs gap-1 text-blue-600 hover:text-blue-800"
                                onClick={(e) => { e.stopPropagation(); handleDownloadBoleto(payment.id, payment.code); }}
                              >
                                <Download className="h-3.5 w-3.5" />
                                PDF
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs gap-1 text-green-600 hover:text-green-800"
                                    disabled={notifyLoading[payment.id]}
                                  >
                                    <Send className="h-3.5 w-3.5" />
                                    {notifyLoading[payment.id] ? "..." : "Cobrar"}
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleSendNotify(payment.id, ["whatsapp"]); }}>
                                    WhatsApp
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleSendNotify(payment.id, ["email"]); }}>
                                    Email
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleSendNotify(payment.id, ["whatsapp", "email"]); }}>
                                    WhatsApp + Email
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </>
                          ) : !payment.nossoNumero && (payment.status === "PENDENTE" || payment.status === "ATRASADO") ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs gap-1 text-muted-foreground"
                              disabled={boletoLoading[payment.id]}
                              onClick={(e) => { e.stopPropagation(); handleEmitBoleto(payment.id); }}
                            >
                              <Receipt className="h-3.5 w-3.5" />
                              {boletoLoading[payment.id] ? "..." : "Emitir"}
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const notifs = payment.notifications || [];
                            if (notifs.length === 0) {
                              return <span className="text-xs text-muted-foreground">-</span>;
                            }
                            const channels = [...new Set(notifs.map(n => n.channel))];
                            const lastSent = notifs[0]?.sentAt ? formatDate(notifs[0].sentAt) : "";
                            return (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge variant="outline" className="text-xs border gap-1 bg-green-50 text-green-700 border-green-200 cursor-default">
                                      <Send className="h-3 w-3" />
                                      Enviado
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>Enviado via {channels.join(" + ")} em {lastSent}</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="overflow-visible">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7">
                                <MoreVertical className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleEditPayment(payment); }}>
                                <Pencil className="h-3.5 w-3.5 mr-2" />
                                Editar
                              </DropdownMenuItem>
                              {payment.status !== "PAGO" && (
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleMarkAsPaid(payment); }}>
                                  <CheckCircle2 className="h-3.5 w-3.5 mr-2" />
                                  Marcar como Pago
                                </DropdownMenuItem>
                              )}
                              {!payment.nossoNumero && (payment.status === "PENDENTE" || payment.status === "ATRASADO") && (
                                <DropdownMenuItem
                                  disabled={boletoLoading[payment.id]}
                                  onClick={(e) => { e.stopPropagation(); handleEmitBoleto(payment.id); }}
                                >
                                  <Receipt className="h-3.5 w-3.5 mr-2" />
                                  {boletoLoading[payment.id] ? "Emitindo..." : "Emitir Boleto"}
                                </DropdownMenuItem>
                              )}
                              {payment.nossoNumero && (
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleDownloadBoleto(payment.id, payment.code); }}>
                                  <Receipt className="h-3.5 w-3.5 mr-2" />
                                  Baixar Boleto
                                </DropdownMenuItem>
                              )}
                              {(payment.status === "PENDENTE" || payment.status === "ATRASADO") && (
                                <DropdownMenuItem
                                  disabled={notifyLoading[payment.id]}
                                  onClick={(e) => { e.stopPropagation(); handleSendNotify(payment.id, ["whatsapp", "email"]); }}
                                >
                                  <Send className="h-3.5 w-3.5 mr-2" />
                                  {notifyLoading[payment.id] ? "Enviando..." : "Enviar Cobranca"}
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={(e) => { e.stopPropagation(); handleDeleteClick(payment); }}
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

      {/* Generate Charges Dialog */}
      <GenerateChargesDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        onSuccess={refresh}
      />

      {/* Payment Form Dialog */}
      <PaymentForm
        open={formOpen}
        onOpenChange={setFormOpen}
        payment={selectedPayment}
        onSuccess={handleFormSuccess}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir Pagamento</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir o pagamento{" "}
              <strong>{paymentToDelete?.code}</strong>? Esta acao nao pode ser desfeita.
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

      {/* Sheet lateral de detalhe (conferencia rapida) */}
      <PaymentDetailSheet
        paymentId={detailPaymentId}
        payments={payments as any}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onMarkPaid={(id) => {
          const p = payments.find((x) => x.id === id);
          if (p) handleMarkAsPaid(p as Payment);
        }}
      />
    </div>
  );
}
