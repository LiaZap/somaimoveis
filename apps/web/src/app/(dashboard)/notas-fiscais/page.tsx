"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Search,
  CheckCircle2,
  Clock,
  DollarSign,
  FileText,
  Download,
  Printer,
  AlertTriangle,
  Loader2,
  RefreshCw,
  EyeOff,
} from "lucide-react";

interface NotaFiscal {
  entryId: string;
  owner: { id: string; name: string; cpfCnpj: string };
  naoDeclaraImob?: boolean;
  contract: { id: string; code: string; rentalValue: number; adminFeePercent: number } | null;
  aluguelBruto: number;
  aluguelBrutoOriginal?: number;
  descontoAplicado?: number;
  sharePercent?: number;
  adminFeePercent: number;
  adminFeeValue: number;
  repasseValue: number;
  nfEmitida: boolean;
  realmenteEmitida?: boolean;
  nfNumero: string;
  nfData: string;
  invoiceId?: string | null;
  invoiceStatus?: string | null; // PENDENTE | PROCESSANDO | AUTORIZADA | REJEITADA | CANCELADA | null
  invoicePdfUrl?: string | null;
  rejeicaoCodigo?: string | null;
  rejeicaoMotivo?: string | null;
}

interface NotasResponse {
  month: string;
  total: number;
  emitidas: number;
  pendentes: number;
  rejeitadas?: number;
  processando?: number;
  totalAdminFee: number;
  provedor?: string | null;
  notas: NotaFiscal[];
}

interface EmissionError {
  ownerName: string;
  error: string;
}

type TabKey = "pendentes" | "rejeitadas" | "processando" | "emitidas" | "suprimidas";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(month: string): string {
  const [y, m] = month.split("-");
  const months = [
    "Janeiro", "Fevereiro", "Marco", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
  ];
  return `${months[parseInt(m) - 1]} ${y}`;
}

export default function NotasFiscaisPage() {
  const [data, setData] = useState<NotasResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(getCurrentMonth());
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("pendentes");
  const [checkingStatus, setCheckingStatus] = useState<Set<string>>(new Set());
  // Modal de erros de emissao — mostra TODAS as falhas (sem corte)
  const [emissionErrors, setEmissionErrors] = useState<EmissionError[] | null>(null);

  async function fetchNotas() {
    setLoading(true);
    try {
      // cache: "no-store" evita ler dados stale apos emit/cancel/check-status
      const res = await fetch(`/api/notas-fiscais?month=${month}`, { cache: "no-store" });
      if (res.ok) {
        const d = await res.json();
        setData(d);
      } else {
        toast.error("Erro ao carregar notas fiscais");
      }
    } catch {
      toast.error("Erro de conexao");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchNotas();
    setSelected(new Set());
  }, [month]);

  const isSpedy = (data?.provedor || "").toUpperCase() === "SPEDY";

  // Aplica busca primeiro — contadores e tabs todos respeitam esse filtro
  const filteredNotas = (data?.notas || []).filter((n) => {
    if (!search) return true;
    const term = search.toLowerCase();
    return (
      n.owner.name.toLowerCase().includes(term) ||
      n.owner.cpfCnpj.includes(term) ||
      (n.contract?.code || "").toLowerCase().includes(term)
    );
  });

  // Owners com naoDeclaraImob nao geram NF — agrupados em tab separada
  // pra ficar transparente o que esta sendo suprimido, mas nao poluem
  // o fluxo de pendentes/emitidas.
  const suprimidas = filteredNotas.filter((n) => n.naoDeclaraImob === true);
  const ativas = filteredNotas.filter((n) => n.naoDeclaraImob !== true);

  // Pendentes = sem invoice no banco OU invoice em estado nao-final (nao
  // AUTORIZADA, nao REJEITADA, nao PROCESSANDO, nao CANCELADA). Tambem
  // exclui marcadas manualmente como emitida.
  const pendentes = ativas.filter(
    (n) =>
      !n.nfEmitida &&
      n.invoiceStatus !== "REJEITADA" &&
      n.invoiceStatus !== "PROCESSANDO"
  );
  const rejeitadas = ativas.filter((n) => n.invoiceStatus === "REJEITADA");
  const processando = ativas.filter((n) => n.invoiceStatus === "PROCESSANDO");
  const emitidas = ativas.filter((n) => n.nfEmitida);

  function toggleSelect(entryId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }

  function selectAllPendentes() {
    setSelected(new Set(pendentes.map((n) => n.entryId)));
  }

  async function marcarEmitidas() {
    if (selected.size === 0) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/notas-fiscais", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month,
          entryIds: Array.from(selected),
          emitida: true,
        }),
      });
      const d = await res.json();
      if (res.ok) {
        toast.success(d.message);
        setSelected(new Set());
        fetchNotas();
      } else {
        toast.error(d.error || "Erro");
      }
    } catch {
      toast.error("Erro ao marcar NFs");
    } finally {
      setActionLoading(false);
    }
  }

  async function emitirNFsSelecionadas() {
    if (selected.size === 0) {
      toast.error("Selecione pelo menos uma NF");
      return;
    }
    if (!confirm(`Emitir ${selected.size} NF(s) eletronicamente via gov.br? A operacao nao pode ser desfeita.`)) {
      return;
    }
    setActionLoading(true);
    try {
      const res = await fetch("/api/invoices/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerEntryIds: Array.from(selected) }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error || "Erro ao emitir NFs");
        return;
      }
      if (d.mockMode) {
        toast.warning("MODO MOCK ativo (sem integracao real)");
      }
      const errors: EmissionError[] = (d.results || [])
        .filter((r: { success?: boolean }) => !r.success)
        .map((r: { ownerName?: string; error?: string }) => ({
          ownerName: r.ownerName || "Desconhecido",
          error: r.error || "Erro nao especificado",
        }));
      if (d.success > 0) {
        toast.success(d.message);
      }
      if (errors.length > 0) {
        // Abre modal com TODOS os erros (sem corte) — antes era slice(0, 5)
        setEmissionErrors(errors);
      }
      setSelected(new Set());
      fetchNotas();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Erro ao emitir NFs";
      toast.error(msg);
    } finally {
      setActionLoading(false);
    }
  }

  // Re-emite uma NF (retry apos rejeicao). Mesmo endpoint, apenas 1 entryId.
  async function reemitirNF(entryId: string, ownerName: string) {
    if (!confirm(`Tentar re-emitir a NF de ${ownerName}?`)) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/invoices/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerEntryIds: [entryId] }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error || "Erro ao re-emitir NF");
        return;
      }
      if (d.success > 0) {
        toast.success(`NF de ${ownerName} re-enviada`);
      } else {
        const firstError = (d.results || []).find((r: { success?: boolean }) => !r.success);
        toast.error(
          firstError?.error
            ? `Falha: ${firstError.error}`
            : "Falha desconhecida ao re-emitir"
        );
      }
      fetchNotas();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Erro ao re-emitir NF";
      toast.error(msg);
    } finally {
      setActionLoading(false);
    }
  }

  // Verifica status no provedor (util pra PROCESSANDO / REJEITADA com
  // estado eventualmente atualizado via webhook fora do nosso fluxo).
  async function verificarStatus(invoiceId: string) {
    setCheckingStatus((prev) => new Set(prev).add(invoiceId));
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/check-status`, {
        method: "POST",
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(d.error || "Erro ao verificar status");
        return;
      }
      toast.success(
        d.status
          ? `Status atualizado: ${d.status}`
          : "Status verificado"
      );
      fetchNotas();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Erro ao verificar status";
      toast.error(msg);
    } finally {
      setCheckingStatus((prev) => {
        const next = new Set(prev);
        next.delete(invoiceId);
        return next;
      });
    }
  }

  async function reverterEmitida(entryId: string) {
    try {
      const res = await fetch("/api/notas-fiscais", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, entryIds: [entryId], emitida: false }),
      });
      if (res.ok) {
        toast.success("NF revertida para pendente");
        fetchNotas();
      }
    } catch {
      toast.error("Erro");
    }
  }

  function imprimirTodas() {
    if (!data || data.notas.length === 0) {
      toast.error("Nenhuma NF para imprimir");
      return;
    }
    window.open(`/notas-fiscais/imprimir?month=${month}`, "_blank");
  }

  function imprimirSelecionadas() {
    if (selected.size === 0) {
      toast.error("Selecione pelo menos uma NF");
      return;
    }
    const ids = Array.from(selected).join(",");
    window.open(`/notas-fiscais/imprimir?month=${month}&entryIds=${ids}`, "_blank");
  }

  function imprimirIndividual(entryId: string) {
    window.open(`/notas-fiscais/imprimir?month=${month}&entryIds=${entryId}`, "_blank");
  }

  function baixarPdf(invoiceId: string) {
    window.open(`/api/invoices/${invoiceId}/download?format=pdf`, "_blank");
  }

  function baixarXml(invoiceId: string) {
    window.open(`/api/invoices/${invoiceId}/download?format=xml`, "_blank");
  }

  async function cancelarNF(invoiceId: string, ownerName: string) {
    const justification = window.prompt(
      `Cancelar a NF de ${ownerName} na prefeitura?\n\nInforme a justificativa do cancelamento (obrigatório):`
    );
    if (!justification || !justification.trim()) {
      return;
    }
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ justification: justification.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Erro ao cancelar NF");
        return;
      }
      toast.success("Solicitação de cancelamento enviada à prefeitura");
      fetchNotas();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Erro ao cancelar NF";
      toast.error(msg);
    }
  }

  function exportCSV() {
    if (!data) return;
    const rows = data.notas.map((n) => [
      n.owner.name,
      n.owner.cpfCnpj,
      n.contract?.code || "",
      n.aluguelBruto.toFixed(2),
      `${n.adminFeePercent}%`,
      n.adminFeeValue.toFixed(2),
      n.nfEmitida ? "EMITIDA" : "PENDENTE",
      n.nfNumero,
    ]);
    const header = "Proprietario;CPF/CNPJ;Contrato;Aluguel Bruto;Taxa %;Valor NF;Status;Numero NF";
    const csv = [header, ...rows.map((r) => r.join(";"))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `notas-fiscais-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV exportado");
  }

  return (
    <div className="flex flex-col">
      <Header title="Notas Fiscais" subtitle="Controle de emissao de notas fiscais de taxa de administracao" />

      <div className="p-4 sm:p-6 space-y-4">
        {/* Summary — contadores derivados de filteredNotas pra condizer
            com a tabela quando ha busca/filtro ativo. */}
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Total NFs</p>
                  <p className="text-2xl font-bold mt-1">
                    {loading ? "..." : ativas.length}
                  </p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-100">
                  <FileText className="h-5 w-5 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Pendentes</p>
                  <p className="text-2xl font-bold mt-1">
                    {loading ? "..." : pendentes.length}
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
                  <p className="text-xs font-medium text-muted-foreground">Rejeitadas</p>
                  <p className="text-2xl font-bold mt-1 text-red-600">
                    {loading ? "..." : rejeitadas.length}
                  </p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-100">
                  <AlertTriangle className="h-5 w-5 text-red-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Processando</p>
                  <p className="text-2xl font-bold mt-1 text-amber-600">
                    {loading ? "..." : processando.length}
                  </p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100">
                  <Loader2 className="h-5 w-5 text-amber-600 animate-spin" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Emitidas</p>
                  <p className="text-2xl font-bold mt-1">
                    {loading ? "..." : emitidas.length}
                  </p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Total Taxa Adm</p>
                  <p className="text-2xl font-bold mt-1">
                    {loading ? "..." : formatCurrency(data?.totalAdminFee || 0)}
                  </p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100">
                  <DollarSign className="h-5 w-5 text-violet-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters + Actions */}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-0">
            <div className="flex flex-col gap-3 p-4 border-b">
              <div className="flex items-center gap-2 flex-wrap">
                <Input
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  className="h-9 w-auto text-sm"
                />
                <Button size="sm" variant="outline" className="gap-1.5 h-9 text-xs" onClick={selectAllPendentes}>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Selecionar Pendentes
                </Button>
                {selected.size > 0 && (
                  <>
                    <Button
                      size="sm"
                      className="gap-1.5 h-9 text-xs bg-emerald-600 hover:bg-emerald-700"
                      onClick={emitirNFsSelecionadas}
                      disabled={actionLoading}
                      title="Emite NF eletronicamente via gov.br"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      {actionLoading ? "Emitindo..." : `Emitir ${selected.size} NF(s) eletronica(s)`}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 h-9 text-xs"
                      onClick={marcarEmitidas}
                      disabled={actionLoading}
                      title="Apenas marca como emitida (sem chamar gov.br) — para NFs ja emitidas manualmente"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Marcar como Emitida(s)
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 h-9 text-xs border-blue-400 text-blue-700 hover:bg-blue-50"
                      onClick={imprimirSelecionadas}
                    >
                      <Printer className="h-3.5 w-3.5" />
                      Imprimir Selecionadas ({selected.size})
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 h-9 text-xs"
                  onClick={imprimirTodas}
                >
                  <Printer className="h-3.5 w-3.5" />
                  Imprimir Todas
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5 h-9 text-xs" onClick={exportCSV}>
                  <Download className="h-3.5 w-3.5" />
                  CSV
                </Button>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Buscar proprietario ou contrato..."
                  className="pl-9 h-9 w-full sm:w-[280px] text-sm"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            {/* Tabs — pendentes / rejeitadas / processando / emitidas /
                suprimidas. Tab "Suprimidas" so aparece se houver owner com
                naoDeclaraImob. Tabs com 0 itens ainda aparecem (excepto
                Suprimidas) pra preservar previsibilidade da navegacao. */}
            <div className="px-4 py-2 border-b bg-slate-50">
              <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabKey)} className="w-full">
                <TabsList className="h-9">
                  <TabsTrigger value="pendentes" className="text-xs h-8 px-3">
                    Pendentes ({pendentes.length})
                  </TabsTrigger>
                  <TabsTrigger value="rejeitadas" className="text-xs h-8 px-3">
                    Rejeitadas ({rejeitadas.length})
                  </TabsTrigger>
                  <TabsTrigger value="processando" className="text-xs h-8 px-3">
                    Processando ({processando.length})
                  </TabsTrigger>
                  <TabsTrigger value="emitidas" className="text-xs h-8 px-3">
                    Emitidas ({emitidas.length})
                  </TabsTrigger>
                  {suprimidas.length > 0 && (
                    <TabsTrigger value="suprimidas" className="text-xs h-8 px-3">
                      Suprimidas ({suprimidas.length})
                    </TabsTrigger>
                  )}
                </TabsList>
              </Tabs>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">Carregando...</p>
              </div>
            ) : filteredNotas.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">
                  Nenhuma nota fiscal para {formatMonthLabel(month)}.
                </p>
              </div>
            ) : (
              <>
                {/* PENDENTES */}
                {activeTab === "pendentes" && (
                  pendentes.length === 0 ? (
                    <div className="flex items-center justify-center py-12">
                      <p className="text-sm text-muted-foreground">
                        Nenhuma nota pendente.
                      </p>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10"></TableHead>
                          <TableHead className="text-xs">Proprietario</TableHead>
                          <TableHead className="text-xs">Contrato</TableHead>
                          <TableHead className="text-xs text-right">Aluguel Bruto</TableHead>
                          <TableHead className="text-xs text-right">Taxa Adm</TableHead>
                          <TableHead className="text-xs text-right">Valor NF</TableHead>
                          <TableHead className="text-xs w-16"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pendentes.map((n) => {
                          const isPartial = n.sharePercent != null && n.sharePercent < 100;
                          const hasDesconto = (n.descontoAplicado || 0) > 0;
                          return (
                            <TableRow key={n.entryId}>
                              <TableCell>
                                <Checkbox
                                  checked={selected.has(n.entryId)}
                                  onCheckedChange={() => toggleSelect(n.entryId)}
                                />
                              </TableCell>
                              <TableCell className="text-xs">
                                <div className="font-medium flex items-center gap-1">
                                  {n.owner.name}
                                  {isPartial && (
                                    <Badge variant="outline" className="text-[9px] h-4 px-1 bg-blue-50 text-blue-700 border-blue-200">
                                      {n.sharePercent}%
                                    </Badge>
                                  )}
                                </div>
                                <div className="text-muted-foreground text-[11px]">{n.owner.cpfCnpj}</div>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {n.contract?.code || "-"}
                              </TableCell>
                              <TableCell className="text-xs text-right">
                                <div>{formatCurrency(n.aluguelBruto)}</div>
                                {(hasDesconto || isPartial) && n.aluguelBrutoOriginal != null && (
                                  <div className="text-[10px] text-muted-foreground">
                                    {hasDesconto && (
                                      <>
                                        Bruto {formatCurrency(n.aluguelBrutoOriginal)} -
                                        Desc {formatCurrency(n.descontoAplicado || 0)}
                                      </>
                                    )}
                                    {isPartial && (
                                      <>
                                        {hasDesconto ? " | " : ""}
                                        {n.sharePercent}% cota
                                      </>
                                    )}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="text-xs text-right text-muted-foreground">
                                {n.adminFeePercent}%
                              </TableCell>
                              <TableCell className="text-xs text-right font-semibold">
                                {formatCurrency(n.adminFeeValue)}
                              </TableCell>
                              <TableCell>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  onClick={() => imprimirIndividual(n.entryId)}
                                  title="Imprimir NF"
                                >
                                  <Printer className="h-3.5 w-3.5" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )
                )}

                {/* REJEITADAS */}
                {activeTab === "rejeitadas" && (
                  rejeitadas.length === 0 ? (
                    <div className="flex items-center justify-center py-12">
                      <p className="text-sm text-muted-foreground">
                        Nenhuma nota rejeitada.
                      </p>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">Proprietario</TableHead>
                          <TableHead className="text-xs">Contrato</TableHead>
                          <TableHead className="text-xs">Motivo da rejeicao</TableHead>
                          <TableHead className="text-xs text-right">Valor NF</TableHead>
                          <TableHead className="text-xs w-44"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rejeitadas.map((n) => (
                          <TableRow key={n.entryId}>
                            <TableCell className="text-xs">
                              <div className="font-medium">{n.owner.name}</div>
                              <div className="text-muted-foreground text-[11px]">{n.owner.cpfCnpj}</div>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {n.contract?.code || "-"}
                            </TableCell>
                            <TableCell className="text-xs text-red-700 max-w-md">
                              {n.rejeicaoCodigo && (
                                <span className="font-mono text-[10px] bg-red-50 px-1.5 py-0.5 rounded mr-1.5">
                                  {n.rejeicaoCodigo}
                                </span>
                              )}
                              {n.rejeicaoMotivo || "Motivo nao informado"}
                            </TableCell>
                            <TableCell className="text-xs text-right font-semibold">
                              {formatCurrency(n.adminFeeValue)}
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1 flex-wrap justify-end">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-[11px] border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                                  onClick={() => reemitirNF(n.entryId, n.owner.name)}
                                  disabled={actionLoading}
                                  title="Re-emitir NF apos correcao"
                                >
                                  <RefreshCw className="h-3 w-3 mr-1" />
                                  Tentar de novo
                                </Button>
                                {n.invoiceId && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-[11px]"
                                    onClick={() => verificarStatus(n.invoiceId!)}
                                    disabled={checkingStatus.has(n.invoiceId!)}
                                    title="Consulta status atual no provedor"
                                  >
                                    {checkingStatus.has(n.invoiceId) ? (
                                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                    ) : (
                                      <RefreshCw className="h-3 w-3 mr-1" />
                                    )}
                                    Verificar Status
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )
                )}

                {/* PROCESSANDO */}
                {activeTab === "processando" && (
                  processando.length === 0 ? (
                    <div className="flex items-center justify-center py-12">
                      <p className="text-sm text-muted-foreground">
                        Nenhuma nota em processamento.
                      </p>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">Proprietario</TableHead>
                          <TableHead className="text-xs">Contrato</TableHead>
                          <TableHead className="text-xs">Status</TableHead>
                          <TableHead className="text-xs text-right">Valor NF</TableHead>
                          <TableHead className="text-xs w-44"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {processando.map((n) => (
                          <TableRow key={n.entryId}>
                            <TableCell className="text-xs">
                              <div className="font-medium">{n.owner.name}</div>
                              <div className="text-muted-foreground text-[11px]">{n.owner.cpfCnpj}</div>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {n.contract?.code || "-"}
                            </TableCell>
                            <TableCell className="text-xs">
                              <div className="flex items-center gap-1.5 text-amber-700">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                <span>Aguardando provedor</span>
                              </div>
                            </TableCell>
                            <TableCell className="text-xs text-right font-semibold">
                              {formatCurrency(n.adminFeeValue)}
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1 justify-end">
                                {n.invoiceId && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-[11px]"
                                    onClick={() => verificarStatus(n.invoiceId!)}
                                    disabled={checkingStatus.has(n.invoiceId!)}
                                    title="Consulta status atual no provedor"
                                  >
                                    {checkingStatus.has(n.invoiceId) ? (
                                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                    ) : (
                                      <RefreshCw className="h-3 w-3 mr-1" />
                                    )}
                                    Verificar Status
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )
                )}

                {/* EMITIDAS */}
                {activeTab === "emitidas" && (
                  emitidas.length === 0 ? (
                    <div className="flex items-center justify-center py-12">
                      <p className="text-sm text-muted-foreground">
                        Nenhuma nota emitida.
                      </p>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">Proprietario</TableHead>
                          <TableHead className="text-xs">Contrato</TableHead>
                          <TableHead className="text-xs text-right">Valor NF</TableHead>
                          <TableHead className="text-xs">Data Emissao</TableHead>
                          <TableHead className="text-xs w-28"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {emitidas.map((n) => {
                          const showCancel =
                            n.invoiceId &&
                            n.invoiceStatus !== "CANCELADA" &&
                            n.invoiceStatus === "AUTORIZADA";
                          return (
                            <TableRow key={n.entryId}>
                              <TableCell className="text-xs">
                                <div className="font-medium">{n.owner.name}</div>
                                <div className="text-muted-foreground text-[11px]">{n.owner.cpfCnpj}</div>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {n.contract?.code || "-"}
                              </TableCell>
                              <TableCell className="text-xs text-right font-semibold">
                                {formatCurrency(n.adminFeeValue)}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {n.nfData || "-"}
                              </TableCell>
                              <TableCell>
                                <div className="flex gap-1 flex-wrap">
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7"
                                    onClick={() => imprimirIndividual(n.entryId)}
                                    title="Imprimir NF"
                                  >
                                    <Printer className="h-3.5 w-3.5" />
                                  </Button>
                                  {n.invoiceId && (
                                    <>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        onClick={() => baixarPdf(n.invoiceId!)}
                                        title="Baixar PDF"
                                      >
                                        <Download className="h-3.5 w-3.5" />
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 text-[11px] text-muted-foreground"
                                        onClick={() => baixarXml(n.invoiceId!)}
                                        title="Baixar XML"
                                      >
                                        XML
                                      </Button>
                                      {showCancel && (
                                        isSpedy ? (
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-7 text-[11px] text-muted-foreground hover:text-red-700"
                                            onClick={() => cancelarNF(n.invoiceId!, n.owner.name)}
                                            title="Cancelar NF na prefeitura"
                                          >
                                            Cancelar
                                          </Button>
                                        ) : (
                                          <TooltipProvider>
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <span className="inline-block">
                                                  <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-7 text-[11px] text-muted-foreground"
                                                    disabled
                                                  >
                                                    Cancelar
                                                  </Button>
                                                </span>
                                              </TooltipTrigger>
                                              <TooltipContent>
                                                Cancelamento automatico disponivel apenas
                                                via SPEDY. Cancele direto no portal do
                                                provedor ({data?.provedor || "atual"}).
                                              </TooltipContent>
                                            </Tooltip>
                                          </TooltipProvider>
                                        )
                                      )}
                                    </>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 text-[11px] text-muted-foreground hover:text-amber-700"
                                    onClick={() => reverterEmitida(n.entryId)}
                                    title="Apenas remove marca local (nao cancela na prefeitura)"
                                  >
                                    Reverter
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )
                )}

                {/* SUPRIMIDAS — owners com naoDeclaraImob. Apenas leitura,
                    sem checkbox / acoes (nao geram NF por decisao do cliente). */}
                {activeTab === "suprimidas" && (
                  suprimidas.length === 0 ? (
                    <div className="flex items-center justify-center py-12">
                      <p className="text-sm text-muted-foreground">
                        Nenhum proprietario com supressao de NF neste mes.
                      </p>
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">Proprietario</TableHead>
                          <TableHead className="text-xs">Contrato</TableHead>
                          <TableHead className="text-xs text-right">Valor (suprimido)</TableHead>
                          <TableHead className="text-xs">Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {suprimidas.map((n) => (
                          <TableRow key={n.entryId} className="opacity-70">
                            <TableCell className="text-xs">
                              <div className="font-medium flex items-center gap-1.5">
                                <EyeOff className="h-3 w-3 text-muted-foreground" />
                                {n.owner.name}
                              </div>
                              <div className="text-muted-foreground text-[11px]">{n.owner.cpfCnpj}</div>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {n.contract?.code || "-"}
                            </TableCell>
                            <TableCell className="text-xs text-right text-muted-foreground line-through">
                              {formatCurrency(n.adminFeeValue)}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-[10px] bg-slate-100 text-slate-600 border-slate-300">
                                Suprimida (nao declara imovel)
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Modal: TODAS as falhas de emissao (substitui o slice(0, 5)
          que escondia erros do usuario). */}
      <Dialog
        open={emissionErrors !== null}
        onOpenChange={(open) => {
          if (!open) setEmissionErrors(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-600" />
              Falhas na emissao
            </DialogTitle>
            <DialogDescription>
              {emissionErrors?.length || 0} NF(s) nao foram emitidas. Revise os
              motivos abaixo e corrija o que for necessario antes de tentar
              novamente.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto space-y-2">
            {emissionErrors?.map((err, idx) => (
              <div
                key={`${err.ownerName}-${idx}`}
                className="rounded-md border border-red-200 bg-red-50 p-3"
              >
                <div className="text-xs font-semibold text-red-900">
                  {err.ownerName}
                </div>
                <div className="text-xs text-red-700 mt-1 whitespace-pre-wrap break-words">
                  {err.error}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
