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
  ShieldCheck,
  XCircle,
  Info,
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

// ====== Tipos do relatório de pré-validação (audit dry-run) ======
type AuditSeverity = "BLOQUEANTE" | "AVISO" | "INFO";

interface AuditValidation {
  severity: AuditSeverity;
  code: string;
  message: string;
}

interface AuditItem {
  contractId: string | null;
  ano: number;
  mes: number;
  ownerId: string;
  ownerName: string;
  ownerCpfCnpj: string;
  ownerCpfCnpjValido: boolean;
  ownerEmail: string | null;
  naoDeclaraImob: boolean;
  contractCode: string | null;
  contractStatus: string | null;
  availableContracts?: Array<{
    id: string;
    code: string;
    status: string;
    propertyAddress: string | null;
  }>;
  entryIds?: string[];
  propertyId?: string | null;
  propertyAddress: string | null;
  propertyEnderecoCompleto: boolean;
  propertyOrigem?: "OVERRIDE" | "CONTRACT" | "ENTRY_DIRECT" | "OWNER_UNIQUE" | "MISSING";
  availableProperties?: Array<{ id: string; address: string; type: string }>;
  ownerEnderecoCepValido?: boolean;
  sharePercent?: number;
  isCoproprietario?: boolean;
  valorNF: number;
  valorOrigem:
    | "REPASSE_NOTES"
    | "REPASSE_CALC"
    | "INTERMEDIACAO_ENTRY"
    | "INTERMEDIACAO_SOLTA"
    | "DEBITO_TAXA_ADM"
    | "DESCRIPTION_MATCH"
    | "MANUAL_OVERRIDE"
    | "MISSING";
  candidatosValor?: Array<{
    origem: string;
    value: number;
    entryId?: string;
    note?: string;
  }>;
  aliquotaIss: number;
  aliquotaIssOrigem: "MENSAL" | "ANTERIOR" | "GLOBAL" | "DEFAULT";
  aliquotaCompetenciaUsada: string | null;
  invoiceExistente: {
    id: string;
    numero: string | null;
    status: string;
  } | null;
  validations: AuditValidation[];
  canEmit: boolean;
  hasWarnings: boolean;
  jaEmitida?: boolean;
}

interface AuditReport {
  summary: {
    month: string;
    totalItens: number;
    totalCanEmit: number;
    totalJaEmitidas?: number;
    totalBloqueados: number;
    totalComAvisos: number;
    totalSuprimidos: number;
    totalReEmissao: number;
    valorTotalAEmitir: number;
    valorTotalJaEmitidas?: number;
    valorTotalBloqueado: number;
    porOwner: Array<{
      ownerId: string;
      ownerName: string;
      qtdNotas: number;
      valorTotal: number;
      qtdBloqueados: number;
    }>;
  };
  items: AuditItem[];
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
  // Modal de pre-validacao (audit dry-run)
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditReport, setAuditReport] = useState<AuditReport | null>(null);
  const [auditFilter, setAuditFilter] = useState<"todos" | "bloqueados" | "avisos" | "ok" | "emitidas">("todos");
  // Resultado do ultimo auto-link (pra mostrar pulados/ambiguos)
  const [autoLinkResult, setAutoLinkResult] = useState<{
    vinculados: Array<{ entryId: string; ownerName: string; contractCode?: string; heuristic?: string }>;
    ambiguos: Array<{ entryId: string; ownerName: string; reason?: string; candidates?: Array<{ id: string; code: string }> }>;
    pulados: Array<{ entryId: string; ownerName: string; reason?: string }>;
    summary: { total: number; vinculados: number; ambiguos: number; pulados: number };
  } | null>(null);
  // Edicao de valor manual por item (groupKey -> string do input)
  const [valorEdits, setValorEdits] = useState<Record<string, string>>({});
  const [savingOverride, setSavingOverride] = useState<string | null>(null);

  function auditGroupKey(i: AuditItem): string {
    return `${i.contractId || "NULL"}_${i.ano}-${String(i.mes).padStart(2, "0")}_${i.ownerId}`;
  }

  async function autoLinkContratos() {
    setAuditLoading(true);
    try {
      const res = await fetch("/api/invoices/preview-audit/auto-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Erro no auto-link");
        return;
      }
      const s = data.summary;
      setAutoLinkResult(data);
      toast.success(
        `Auto-link: ${s.vinculados} vinculados, ${s.ambiguos} ambíguos, ${s.pulados} pulados`,
        { duration: 6000 }
      );
      // Re-roda pre-validacao pra atualizar os items
      await preValidarNotas();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro");
    } finally {
      setAuditLoading(false);
    }
  }

  async function vincularContrato(item: AuditItem, contractId: string) {
    const entryIds = item.entryIds || [];
    if (entryIds.length === 0) {
      toast.error("Sem entryIds pra vincular");
      return;
    }
    setSavingOverride(auditGroupKey(item));
    try {
      // PATCH em cada entry do grupo (REPASSE + INTERMEDIACAO juntos)
      const results = await Promise.all(
        entryIds.map((id) =>
          fetch(`/api/owner-entries/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contractId }),
          })
        )
      );
      const erros = results.filter((r) => !r.ok);
      if (erros.length > 0) {
        toast.error(`${erros.length}/${entryIds.length} entries falharam ao vincular`);
        return;
      }
      toast.success(`Contrato vinculado em ${entryIds.length} entry(ies)`);
      await preValidarNotas();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro");
    } finally {
      setSavingOverride(null);
    }
  }

  async function salvarOverrideProperty(item: AuditItem, propertyId: string | null) {
    const key = auditGroupKey(item);
    setSavingOverride(key);
    try {
      const res = await fetch("/api/invoices/preview-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month,
          propertyOverrides: { [key]: propertyId },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Erro");
        return;
      }
      toast.success(propertyId ? "Imóvel vinculado" : "Vínculo de imóvel removido");
      await preValidarNotas();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro");
    } finally {
      setSavingOverride(null);
    }
  }

  async function salvarOverrideValor(item: AuditItem, novoValor: number | null) {
    const key = auditGroupKey(item);
    setSavingOverride(key);
    try {
      const res = await fetch("/api/invoices/preview-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month,
          overrides: { [key]: novoValor },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Erro ao salvar");
        return;
      }
      toast.success(
        novoValor === null
          ? "Override removido"
          : `Valor R$ ${novoValor.toFixed(2)} salvo`
      );
      setValorEdits((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      // Re-roda pre-validacao pra atualizar
      await preValidarNotas();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro");
    } finally {
      setSavingOverride(null);
    }
  }

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

  function baixarMassaMes(format: "pdf" | "xml" | "both" = "both") {
    // Aciona download via window.open pra o navegador receber o ZIP
    const url = `/api/invoices/bulk-download?month=${month}&format=${format}`;
    window.open(url, "_blank");
  }

  async function preValidarNotas() {
    setAuditLoading(true);
    setAuditFilter("todos");
    try {
      const res = await fetch(`/api/invoices/preview-audit?month=${month}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Erro ao pre-validar");
        return;
      }
      setAuditReport(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro");
    } finally {
      setAuditLoading(false);
    }
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
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 h-9 text-xs border-amber-400 text-amber-700 hover:bg-amber-50"
                  onClick={preValidarNotas}
                  disabled={auditLoading}
                  title="Pre-valida tudo antes de emitir — checa CPF/CNPJ, valor, imovel, aliquota etc."
                >
                  {auditLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                  Pré-validar Notas
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
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-[11px] text-muted-foreground hover:text-foreground"
                                  onClick={() => reverterEmitida(n.entryId)}
                                  disabled={actionLoading}
                                  title="Move a nota de volta pra Pendentes. Util pra vincular contrato/imovel antes de tentar emitir de novo. Nao afeta a prefeitura."
                                >
                                  Voltar pra pendente
                                </Button>
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
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-[11px] text-muted-foreground hover:text-foreground"
                                  onClick={() => reverterEmitida(n.entryId)}
                                  disabled={actionLoading}
                                  title="Cancela o processamento local e volta pra Pendentes. Nao afeta a prefeitura."
                                >
                                  Voltar pra pendente
                                </Button>
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
                    <>
                      <div className="flex items-center justify-end gap-2 mb-2">
                        <span className="text-xs text-muted-foreground">
                          Baixar em massa ({emitidas.length} {emitidas.length === 1 ? "nota" : "notas"}):
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1"
                          onClick={() => baixarMassaMes("pdf")}
                          title="Baixa ZIP com todos os PDFs do mes"
                        >
                          PDFs
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1"
                          onClick={() => baixarMassaMes("xml")}
                          title="Baixa ZIP com todos os XMLs do mes"
                        >
                          XMLs
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 text-xs gap-1"
                          onClick={() => baixarMassaMes("both")}
                          title="Baixa ZIP com PDFs e XMLs do mes"
                        >
                          PDF + XML
                        </Button>
                      </div>
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
                    </>
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

      {/* Modal: Pre-validacao (audit dry-run). Mostra TUDO que vai sair
          de NF antes de emitir — bloqueios, avisos, valor por owner. */}
      <Dialog
        open={auditReport !== null}
        onOpenChange={(open) => { if (!open) { setAuditReport(null); setAutoLinkResult(null); } }}
      >
        <DialogContent className="!max-w-[1400px] w-[95vw] max-h-[92vh] overflow-hidden flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-5 pb-4 border-b bg-muted/30">
            <DialogTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-5 w-5 text-amber-600" />
              Pré-validação de Notas — {auditReport ? formatMonthLabel(auditReport.summary.month) : ""}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Relatório dry-run agrupado por (contrato, mês). Revise antes de emitir.
            </DialogDescription>
          </DialogHeader>

          {auditReport && (
            <>
              {/* Summary cards */}
              <div className="px-6 py-4 border-b bg-background">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  <div className="rounded-lg border bg-emerald-50/60 border-emerald-200 px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-xs text-emerald-700 font-medium mb-1">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Prontos
                    </div>
                    <div className="text-2xl font-bold text-emerald-900 leading-none">{auditReport.summary.totalCanEmit}</div>
                    <div className="text-[11px] text-emerald-700 mt-1.5 tabular-nums">{formatCurrency(auditReport.summary.valorTotalAEmitir)}</div>
                  </div>
                  <div className="rounded-lg border bg-blue-50/60 border-blue-200 px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-xs text-blue-700 font-medium mb-1">
                      <FileText className="h-3.5 w-3.5" />
                      Emitidas
                    </div>
                    <div className="text-2xl font-bold text-blue-900 leading-none">{auditReport.summary.totalJaEmitidas || 0}</div>
                    <div className="text-[11px] text-blue-700 mt-1.5 tabular-nums">{formatCurrency(auditReport.summary.valorTotalJaEmitidas || 0)}</div>
                  </div>
                  <div className="rounded-lg border bg-red-50/60 border-red-200 px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-xs text-red-700 font-medium mb-1">
                      <XCircle className="h-3.5 w-3.5" />
                      Bloqueados
                    </div>
                    <div className="text-2xl font-bold text-red-900 leading-none">{auditReport.summary.totalBloqueados}</div>
                    <div className="text-[11px] text-red-700 mt-1.5 tabular-nums">{formatCurrency(auditReport.summary.valorTotalBloqueado)}</div>
                  </div>
                  <div className="rounded-lg border bg-amber-50/60 border-amber-200 px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-xs text-amber-700 font-medium mb-1">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Avisos
                    </div>
                    <div className="text-2xl font-bold text-amber-900 leading-none">{auditReport.summary.totalComAvisos}</div>
                    <div className="text-[11px] text-amber-700/70 mt-1.5">precisam atenção</div>
                  </div>
                  <div className="rounded-lg border bg-gray-50/60 border-gray-200 px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-xs text-gray-600 font-medium mb-1">
                      <EyeOff className="h-3.5 w-3.5" />
                      Suprimidos
                    </div>
                    <div className="text-2xl font-bold text-gray-700 leading-none">{auditReport.summary.totalSuprimidos}</div>
                    <div className="text-[11px] text-gray-500 mt-1.5">não declaram</div>
                  </div>
                  <div className="rounded-lg border bg-violet-50/60 border-violet-200 px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-xs text-violet-700 font-medium mb-1">
                      <RefreshCw className="h-3.5 w-3.5" />
                      Re-emissões
                    </div>
                    <div className="text-2xl font-bold text-violet-900 leading-none">{auditReport.summary.totalReEmissao}</div>
                    <div className="text-[11px] text-violet-700/70 mt-1.5">após cancel/rejeição</div>
                  </div>
                </div>
              </div>

              {/* Top owners — scroll horizontal pra evitar quebra */}
              {auditReport.summary.porOwner.length > 0 && (
                <div className="px-6 py-3 border-b bg-muted/20 shrink-0">
                  <div className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-2">
                    <DollarSign className="h-3.5 w-3.5" />
                    Top proprietários por valor
                  </div>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {auditReport.summary.porOwner.slice(0, 8).map((o) => (
                      <div
                        key={o.ownerId}
                        className="shrink-0 bg-background border rounded-md px-3 py-2 min-w-[180px]"
                      >
                        <div className="text-xs font-medium truncate max-w-[220px]" title={o.ownerName}>
                          {o.ownerName}
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-1">
                          <span className="text-[11px] text-muted-foreground">
                            {o.qtdNotas} {o.qtdNotas === 1 ? "nota" : "notas"}
                          </span>
                          <span className="text-xs font-semibold tabular-nums">
                            {formatCurrency(o.valorTotal)}
                          </span>
                        </div>
                        {o.qtdBloqueados > 0 && (
                          <div className="text-[10px] text-red-600 mt-0.5">
                            {o.qtdBloqueados} bloqueado{o.qtdBloqueados > 1 ? "s" : ""}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Toolbar: filtros + ação massiva */}
              <div className="px-6 py-3 border-b bg-background flex items-center gap-2 flex-wrap shrink-0">
                <div className="flex gap-1">
                  {(["todos", "ok", "avisos", "bloqueados", "emitidas"] as const).map((f) => {
                    const counts: Record<typeof f, number> = {
                      todos: auditReport.items.length,
                      ok: auditReport.summary.totalCanEmit - auditReport.summary.totalComAvisos,
                      avisos: auditReport.summary.totalComAvisos,
                      bloqueados: auditReport.summary.totalBloqueados,
                      emitidas: auditReport.summary.totalJaEmitidas || 0,
                    };
                    const labels: Record<typeof f, string> = {
                      todos: "Todos",
                      ok: "OK",
                      avisos: "Avisos",
                      bloqueados: "Bloqueados",
                      emitidas: "Emitidas",
                    };
                    const colors: Record<typeof f, string> = {
                      todos: "",
                      ok: "data-[active=true]:bg-emerald-600 data-[active=true]:text-white",
                      avisos: "data-[active=true]:bg-amber-600 data-[active=true]:text-white",
                      bloqueados: "data-[active=true]:bg-red-600 data-[active=true]:text-white",
                      emitidas: "data-[active=true]:bg-blue-600 data-[active=true]:text-white",
                    };
                    return (
                      <Button
                        key={f}
                        size="sm"
                        data-active={auditFilter === f}
                        variant={auditFilter === f ? "default" : "outline"}
                        className={`h-8 text-xs gap-1.5 ${colors[f]}`}
                        onClick={() => setAuditFilter(f)}
                      >
                        <span>{labels[f]}</span>
                        <span className={`px-1.5 py-0 rounded text-[10px] tabular-nums ${
                          auditFilter === f ? "bg-white/20" : "bg-muted text-muted-foreground"
                        }`}>
                          {counts[f]}
                        </span>
                      </Button>
                    );
                  })}
                </div>
                <div className="ml-auto" />
                <Button
                  size="sm"
                  className="h-8 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                  onClick={autoLinkContratos}
                  disabled={auditLoading}
                  title="Tenta vincular contratos automaticamente em entries sem contractId"
                >
                  {auditLoading
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <CheckCircle2 className="h-3.5 w-3.5" />}
                  Vincular contratos
                </Button>
              </div>

              {/* Painel: resultado do ultimo auto-link (vinculados, ambiguos, pulados) */}
              {autoLinkResult && (
                <details className="mx-6 mt-3 border rounded-md bg-muted/30 text-xs shrink-0" open>
                  <summary className="cursor-pointer px-4 py-2.5 flex items-center gap-3 hover:bg-muted/50 transition-colors">
                    <span className="font-medium">📋 Último auto-link:</span>
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-1 text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full text-[11px]">
                        <CheckCircle2 className="h-3 w-3" /> {autoLinkResult.summary.vinculados} vinculados
                      </span>
                      {autoLinkResult.summary.ambiguos > 0 && (
                        <span className="flex items-center gap-1 text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full text-[11px]">
                          <AlertTriangle className="h-3 w-3" /> {autoLinkResult.summary.ambiguos} ambíguos
                        </span>
                      )}
                      {autoLinkResult.summary.pulados > 0 && (
                        <span className="flex items-center gap-1 text-red-700 bg-red-100 px-2 py-0.5 rounded-full text-[11px]">
                          <XCircle className="h-3 w-3" /> {autoLinkResult.summary.pulados} pulados
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="ml-auto text-muted-foreground hover:text-foreground text-[11px]"
                      onClick={(e) => { e.preventDefault(); setAutoLinkResult(null); }}
                    >
                      Fechar
                    </button>
                  </summary>
                  <div className="px-4 pb-3 pt-1 space-y-3 max-h-[200px] overflow-y-auto">
                    {autoLinkResult.summary.ambiguos > 0 && (
                      <div>
                        <div className="font-medium text-amber-700 mb-1.5 text-[11px]">
                          Ambíguos — vincule manualmente nos cards abaixo:
                        </div>
                        <ul className="space-y-1 text-[11px]">
                          {autoLinkResult.ambiguos.slice(0, 20).map((a, idx) => (
                            <li key={idx} className="bg-amber-50/40 rounded px-2 py-1">
                              <strong>{a.ownerName}</strong> — {a.reason}
                              {a.candidates && a.candidates.length > 0 && (
                                <span className="text-muted-foreground"> · {a.candidates.map((c) => c.code).join(", ")}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {autoLinkResult.summary.pulados > 0 && (
                      <div>
                        <div className="font-medium text-red-700 mb-1.5 text-[11px]">
                          Pulados — owner sem contrato cadastrado:
                        </div>
                        <ul className="space-y-1 text-[11px]">
                          {autoLinkResult.pulados.slice(0, 20).map((p, idx) => (
                            <li key={idx} className="bg-red-50/40 rounded px-2 py-1">
                              <strong>{p.ownerName}</strong> — {p.reason}
                            </li>
                          ))}
                          {autoLinkResult.pulados.length > 20 && (
                            <li className="text-muted-foreground italic px-2">
                              ...e mais {autoLinkResult.pulados.length - 20}
                            </li>
                          )}
                        </ul>
                      </div>
                    )}
                  </div>
                </details>
              )}

              {/* Lista de itens */}
              <div className="overflow-y-auto flex-1 space-y-3 px-6 py-4 bg-muted/10">
                {auditReport.items
                  .filter((i) => {
                    if (auditFilter === "todos") return true;
                    if (auditFilter === "emitidas") return i.jaEmitida === true;
                    if (auditFilter === "bloqueados") return !i.canEmit && !i.jaEmitida && !i.naoDeclaraImob;
                    if (auditFilter === "avisos") return i.canEmit && i.hasWarnings;
                    if (auditFilter === "ok") return i.canEmit && !i.hasWarnings;
                    return true;
                  })
                  .map((i) => {
                    const borderColor = i.jaEmitida
                      ? "border-blue-200 bg-white"
                      : !i.canEmit
                      ? "border-red-200 bg-white"
                      : i.hasWarnings
                      ? "border-amber-200 bg-white"
                      : "border-emerald-200 bg-white";
                    const accentColor = i.jaEmitida
                      ? "bg-blue-500"
                      : !i.canEmit
                      ? "bg-red-500"
                      : i.hasWarnings
                      ? "bg-amber-500"
                      : "bg-emerald-500";
                    const statusIcon = i.jaEmitida
                      ? <FileText className="h-4 w-4 text-blue-600" />
                      : !i.canEmit
                      ? <XCircle className="h-4 w-4 text-red-600" />
                      : i.hasWarnings
                      ? <AlertTriangle className="h-4 w-4 text-amber-600" />
                      : <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
                    const itemKey = `${i.contractId || "null"}-${(i.entryIds || []).join("_")}-${i.ano}-${i.mes}-${i.ownerId}`;
                    return (
                      <div key={itemKey} className={`border rounded-lg overflow-hidden shadow-sm ${borderColor}`}>
                        {/* Accent bar lateral */}
                        <div className="flex">
                          <div className={`w-1 shrink-0 ${accentColor}`} />
                          <div className="flex-1 p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-sm">
                              {statusIcon}
                              <span className="font-semibold text-foreground truncate">{i.ownerName}</span>
                              {i.contractCode ? (
                                <Badge variant="outline" className="text-[10px] h-5 font-mono">
                                  {i.contractCode}
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px] h-5 border-amber-300 text-amber-700 bg-amber-50">
                                  sem contrato
                                </Badge>
                              )}
                              {i.isCoproprietario && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] h-5 bg-purple-50 border-purple-300 text-purple-800"
                                  title="Co-proprietário — valor proporcional à cota"
                                >
                                  Coprop {i.sharePercent}%
                                </Badge>
                              )}
                              {i.jaEmitida && i.invoiceExistente?.numero && (
                                <Badge variant="outline" className="text-[10px] h-5 border-blue-300 text-blue-700 bg-blue-50">
                                  NF #{i.invoiceExistente.numero}
                                </Badge>
                              )}
                            </div>

                            {/* Meta info grid */}
                            <div className="mt-2.5 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                              <div className="flex gap-2">
                                <span className="text-muted-foreground min-w-[68px]">CPF/CNPJ:</span>
                                <span className={i.ownerCpfCnpjValido ? "font-medium" : "text-red-600 font-medium"}>
                                  {i.ownerCpfCnpj || "(vazio)"}
                                  {!i.ownerCpfCnpjValido && " ⚠️"}
                                </span>
                              </div>
                              <div className="flex gap-2">
                                <span className="text-muted-foreground min-w-[68px]">Alíquota:</span>
                                <span className="font-medium">{i.aliquotaIss.toFixed(2).replace(".", ",")}%</span>
                                <span className="text-[10px] text-muted-foreground">
                                  ({i.aliquotaIssOrigem}{i.aliquotaCompetenciaUsada && i.aliquotaIssOrigem === "ANTERIOR" && ` · ${i.aliquotaCompetenciaUsada}`})
                                </span>
                              </div>
                              <div className="flex gap-2 md:col-span-2 min-w-0">
                                <span className="text-muted-foreground min-w-[68px] shrink-0">Imóvel:</span>
                                {i.propertyAddress ? (
                                  <span className="font-medium truncate" title={i.propertyAddress}>{i.propertyAddress}</span>
                                ) : (
                                  <span className="text-amber-600 font-medium">⚠️ sem imóvel — ibsCbs omitido</span>
                                )}
                              </div>
                              <div className="flex gap-2">
                                <span className="text-muted-foreground min-w-[68px]">Origem valor:</span>
                                <span className="font-mono text-[10px] uppercase bg-muted px-1.5 py-0.5 rounded">
                                  {i.valorOrigem}
                                </span>
                              </div>
                              {i.invoiceExistente && !i.jaEmitida && (
                                <div className="flex gap-2">
                                  <span className="text-muted-foreground min-w-[68px]">NF anterior:</span>
                                  <span className="font-medium">
                                    #{i.invoiceExistente.numero || "?"} ({i.invoiceExistente.status})
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="text-right shrink-0 border-l pl-4">
                            <div className="text-xs text-muted-foreground uppercase tracking-wide">Valor NF</div>
                            <div className="text-2xl font-bold tabular-nums leading-tight mt-0.5">
                              {formatCurrency(i.valorNF)}
                            </div>
                            {i.valorOrigem === "MANUAL_OVERRIDE" && (
                              <div className="text-[10px] text-emerald-600 mt-0.5 font-medium">✏️ valor manual</div>
                            )}
                          </div>
                        </div>

                        {/* Candidatos alternativos de valor (mostra se houver mais de 1 ou se MISSING) */}
                        {((i.candidatosValor && i.candidatosValor.length > 1) || i.valorOrigem === "MISSING") && (
                          <div className="mt-2 rounded border bg-muted/30 p-2 text-xs">
                            <div className="font-medium text-muted-foreground mb-1">
                              Candidatos de valor encontrados:
                            </div>
                            {!i.candidatosValor || i.candidatosValor.length === 0 ? (
                              <div className="text-amber-700">
                                ⚠️ Nenhum candidato encontrado. Digite o valor manualmente abaixo.
                              </div>
                            ) : (
                              <div className="space-y-0.5">
                                {i.candidatosValor.map((c, idx) => (
                                  <div key={idx} className="flex items-center justify-between gap-2">
                                    <span className="font-mono text-[10px] opacity-70">{c.origem}</span>
                                    <span className="text-muted-foreground truncate flex-1 mx-2 text-[10px]">
                                      {c.note}
                                    </span>
                                    <button
                                      type="button"
                                      className="font-semibold tabular-nums underline decoration-dotted hover:text-emerald-700"
                                      onClick={() => {
                                        setValorEdits((prev) => ({
                                          ...prev,
                                          [auditGroupKey(i)]: c.value.toFixed(2),
                                        }));
                                      }}
                                      title="Clique pra preencher o input com este valor"
                                    >
                                      {formatCurrency(c.value)}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Input de override manual */}
                        <div className="mt-2 flex items-center gap-2">
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder={`Sobrescrever valor (atual: ${formatCurrency(i.valorNF)})`}
                            className="h-7 text-xs flex-1 max-w-[280px]"
                            value={valorEdits[auditGroupKey(i)] ?? ""}
                            onChange={(e) => {
                              const key = auditGroupKey(i);
                              setValorEdits((prev) => ({ ...prev, [key]: e.target.value }));
                            }}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            disabled={
                              savingOverride === auditGroupKey(i) ||
                              !valorEdits[auditGroupKey(i)] ||
                              isNaN(Number(valorEdits[auditGroupKey(i)])) ||
                              Number(valorEdits[auditGroupKey(i)]) <= 0
                            }
                            onClick={() => {
                              const v = Number(valorEdits[auditGroupKey(i)]);
                              salvarOverrideValor(i, v);
                            }}
                          >
                            {savingOverride === auditGroupKey(i)
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : "Salvar valor"}
                          </Button>
                          {i.valorOrigem === "MANUAL_OVERRIDE" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-[11px] text-red-600"
                              onClick={() => salvarOverrideValor(i, null)}
                              disabled={savingOverride === auditGroupKey(i)}
                            >
                              Remover override
                            </Button>
                          )}
                        </div>

                        {/* Vincular imovel — quando property nao foi resolvida
                            e ha imoveis ATIVOS do owner */}
                        {(!i.propertyId || i.propertyOrigem === "MISSING") && i.availableProperties && i.availableProperties.length > 0 && (
                          <div className="mt-2 rounded border bg-orange-50/50 border-orange-200 p-2 text-xs">
                            <div className="font-medium text-orange-900 mb-1.5">
                              🏠 Sem imóvel resolvido (E0932 certo) — escolha o imóvel deste proprietário:
                            </div>
                            <div className="space-y-1">
                              {i.availableProperties.map((p) => (
                                <div key={p.id} className="flex items-center justify-between gap-2">
                                  <span className="text-[11px] truncate flex-1">
                                    <span className="text-muted-foreground">[{p.type}]</span> {p.address}
                                  </span>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 text-[10px] px-2"
                                    disabled={savingOverride === auditGroupKey(i)}
                                    onClick={() => salvarOverrideProperty(i, p.id)}
                                  >
                                    {savingOverride === auditGroupKey(i)
                                      ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                      : "Vincular"}
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Property override ativa? Mostra link pra remover */}
                        {i.propertyOrigem === "OVERRIDE" && (
                          <div className="mt-1 text-[10px] flex items-center gap-2">
                            <span className="text-emerald-700">🏠 Imóvel manual: {i.propertyAddress}</span>
                            <button
                              type="button"
                              className="text-red-600 underline"
                              onClick={() => salvarOverrideProperty(i, null)}
                            >
                              Remover override
                            </button>
                          </div>
                        )}

                        {/* Vincular contrato — quando entry esta sem contrato
                            e ha contratos ATIVOS disponiveis no owner */}
                        {!i.contractCode && i.availableContracts && i.availableContracts.length > 0 && (
                          <div className="mt-2 rounded border bg-amber-50/50 border-amber-200 p-2 text-xs">
                            <div className="font-medium text-amber-900 mb-1.5">
                              ⚠️ Sem contrato vinculado — escolha um contrato ATIVO deste proprietário:
                            </div>
                            <div className="space-y-1">
                              {i.availableContracts.map((c) => (
                                <div key={c.id} className="flex items-center justify-between gap-2">
                                  <span className="text-[11px] truncate flex-1">
                                    <strong>{c.code}</strong>{" "}
                                    <span className="text-muted-foreground">
                                      ({c.status}) {c.propertyAddress ? `· ${c.propertyAddress}` : ""}
                                    </span>
                                  </span>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 text-[10px] px-2"
                                    disabled={savingOverride === auditGroupKey(i)}
                                    onClick={() => vincularContrato(i, c.id)}
                                  >
                                    {savingOverride === auditGroupKey(i)
                                      ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                      : "Vincular"}
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Validações */}
                        {i.validations.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {i.validations.map((v, idx) => (
                              <div
                                key={idx}
                                className={`text-xs flex items-start gap-1.5 ${
                                  v.severity === "BLOQUEANTE" ? "text-red-700"
                                  : v.severity === "AVISO" ? "text-amber-700"
                                  : "text-blue-700"
                                }`}
                              >
                                {v.severity === "BLOQUEANTE" ? <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                                  : v.severity === "AVISO" ? <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                                  : <Info className="h-3 w-3 mt-0.5 shrink-0" />}
                                <span className="break-words">
                                  <span className="font-mono text-[10px] opacity-60">{v.code}</span> · {v.message}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {/* Empty state */}
                  {auditReport.items.filter((i) => {
                    if (auditFilter === "todos") return true;
                    if (auditFilter === "emitidas") return i.jaEmitida === true;
                    if (auditFilter === "bloqueados") return !i.canEmit && !i.jaEmitida && !i.naoDeclaraImob;
                    if (auditFilter === "avisos") return i.canEmit && i.hasWarnings;
                    if (auditFilter === "ok") return i.canEmit && !i.hasWarnings;
                    return true;
                  }).length === 0 && (
                    <div className="text-center py-16 text-muted-foreground">
                      <div className="text-4xl mb-3">🎉</div>
                      <div className="text-sm">Nenhum item nesta categoria</div>
                    </div>
                  )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
