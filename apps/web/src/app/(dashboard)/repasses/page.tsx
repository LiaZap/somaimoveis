"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { isAdmin as isAdminRole } from "@/lib/rbac";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Search,
  CheckCircle2,
  Clock,
  DollarSign,
  Users,
  Download,
  Upload,
  Send,
  ChevronDown,
  ChevronRight,
  Banknote,
  Copy,
  FileText,
  Shield,
  Pencil,
  X,
  AlertCircle,
  Plus,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface PayoutBeneficiary {
  id: string;
  name: string;
  pixKey: string;
  pixKeyType: string;
  percentage: number;
}

interface OwnerData {
  id: string;
  name: string;
  cpfCnpj: string;
  phone: string | null;
  email: string | null;
  bankName: string | null;
  bankAgency: string | null;
  bankAccount: string | null;
  bankPix: string | null;
  bankPixType: string | null;
  thirdPartyName: string | null;
  thirdPartyDocument: string | null;
  thirdPartyBank: string | null;
  thirdPartyAgency: string | null;
  thirdPartyAccount: string | null;
  thirdPartyPixKeyType: string | null;
  thirdPartyPix: string | null;
  paymentDay: number;
  notes: string | null;
  payoutBeneficiaries?: PayoutBeneficiary[];
}

interface OwnerEntry {
  id: string;
  type: string;
  category: string;
  description: string;
  value: number;
  dueDate: string | null;
  paidAt: string | null;
  status: string;
  ownerId: string;
  contractId: string | null;
  propertyId: string | null;
  notes: string | null;
  // Status do boleto (Payment) que originou este repasse. null quando nao
  // houver boleto correspondente (ex: lancamento manual sem contractId).
  paymentStatus?: "PAGO" | "PENDENTE" | "ATRASADO" | "CANCELADO" | "PARCIAL" | null;
  paymentPaidAt?: string | null;
}

interface OwnerGroup {
  owner: OwnerData;
  entries: OwnerEntry[];
  debitEntries?: OwnerEntry[];
  totalPendente: number;
  totalPago: number;
  totalDebitos?: number;
  totalLiquido?: number;
  isCoOwner?: boolean;
  sharePercent?: number | null;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
}

function formatDate(dateString: string | null): string {
  if (!dateString) return "-";
  const date = new Date(dateString);
  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
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

function getPixDisplay(owner: OwnerData): string {
  const pix = owner.thirdPartyPix || owner.bankPix;
  const tipo = owner.thirdPartyPixKeyType || owner.bankPixType;
  if (!pix) return "Nao cadastrado";
  return tipo ? `${tipo}: ${pix}` : pix;
}

function getBankDisplay(owner: OwnerData): string {
  const name = owner.thirdPartyBank || owner.bankName;
  const ag = owner.thirdPartyAgency || owner.bankAgency;
  const cc = owner.thirdPartyAccount || owner.bankAccount;
  if (!name && !ag && !cc) return "";
  return [name, ag ? `Ag: ${ag}` : "", cc ? `CC: ${cc}` : ""]
    .filter(Boolean)
    .join(" | ");
}

function getRecipientName(owner: OwnerData): string {
  return owner.thirdPartyName || owner.name;
}

/** Detecta o tipo de pagamento preferencial: PIX tem prioridade sobre TED */
function getOwnerPaymentTypes(owner: OwnerData): ("PIX" | "TED")[] {
  const pix = owner.thirdPartyPix || owner.bankPix;
  if (pix) return ["PIX"];
  const ag = owner.thirdPartyAgency || owner.bankAgency;
  const cc = owner.thirdPartyAccount || owner.bankAccount;
  if (ag && cc) return ["TED"];
  return [];
}

/** Aviso visual quando o boleto que originou o repasse ainda nao foi pago. */
function getBoletoStatusBadge(
  entry: OwnerEntry
): { label: string; className: string; tooltip: string } | null {
  if (!["REPASSE", "GARANTIA"].includes(entry.category)) return null;
  const ps = entry.paymentStatus;
  if (!ps || ps === "PAGO") return null;
  if (ps === "ATRASADO") {
    return {
      label: "Boleto vencido",
      className: "bg-red-50 text-red-700 border-red-200",
      tooltip: "O inquilino ainda nao pagou e o boleto esta vencido.",
    };
  }
  if (ps === "CANCELADO") {
    return {
      label: "Boleto cancelado",
      className: "bg-slate-100 text-slate-600 border-slate-200",
      tooltip: "O boleto foi cancelado. Verifique antes de repassar.",
    };
  }
  return {
    label: "Boleto nao pago",
    className: "bg-amber-50 text-amber-700 border-amber-200",
    tooltip: "Aguardando pagamento do inquilino. Nao repassar antes.",
  };
}

/** True quando o repasse esta liberado para pagamento (boleto pago, sem
 *  vinculo, ou marcado manualmente como "aluguel garantido este mes"). */
function isRepassReleased(entry: OwnerEntry): boolean {
  if (!["REPASSE", "GARANTIA"].includes(entry.category)) return true;
  // Override manual: imobiliaria garantiu o aluguel deste mes
  if (entry.notes) {
    try {
      const n = JSON.parse(entry.notes);
      if (n.aluguelGarantidoMes === true) return true;
    } catch {}
  }
  if (entry.paymentStatus == null) return true;
  return entry.paymentStatus === "PAGO";
}

/** Le a flag "aluguel garantido este mes" das notes da OwnerEntry. */
function isAluguelGarantidoMes(entry: OwnerEntry): boolean {
  if (!entry.notes) return false;
  try {
    const n = JSON.parse(entry.notes);
    return n.aluguelGarantidoMes === true;
  } catch {
    return false;
  }
}

/** Detecta REPASSE com value=0 porque a intermediacao consumiu o aluguel todo.
 *  Retorna nota explicativa quando aplicavel, ou null caso contrario. */
function getIntermediacaoConsumidaInfo(
  entry: OwnerEntry
): { intermediacao: number; saldoNovo?: number; nota?: string } | null {
  if (!["REPASSE", "GARANTIA"].includes(entry.category)) return null;
  if (entry.value > 0) return null;
  if (!entry.notes) return null;
  try {
    const n = JSON.parse(entry.notes);
    const interm = typeof n.intermediacao === "number" ? n.intermediacao : 0;
    if (interm <= 0) return null;
    return {
      intermediacao: interm,
      saldoNovo: typeof n.intermediacaoSaldoNovo === "number" ? n.intermediacaoSaldoNovo : undefined,
      nota: typeof n.intermediacaoNota === "string" ? n.intermediacaoNota : undefined,
    };
  } catch {
    return null;
  }
}

export default function RepassesPage() {
  const { data: session } = useSession();
  // canAdmin: pode usar acoes destrutivas (Sincronizar, Importar Retorno,
  // Propagar Descontos, Desfazer Sync) e ver agregados da empresa.
  // CORRETOR/FINANCEIRO veem listagem + demonstrativo + export, mas sem
  // botoes destrutivos nem totais agregados da empresa.
  const canAdmin = isAdminRole((session?.user as any)?.role);

  const [groups, setGroups] = useState<OwnerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("pix");
  const [month, setMonth] = useState(getCurrentMonth());
  const [expandedOwners, setExpandedOwners] = useState<Set<string>>(new Set());
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"PAGO" | "PENDENTE">("PAGO");
  const [actionLoading, setActionLoading] = useState(false);
  const [cnabLoading, setCnabLoading] = useState(false);
  const [cnabNextSeq, setCnabNextSeq] = useState<number | null>(null);
  const [cnabSeqEditing, setCnabSeqEditing] = useState(false);
  const [cnabSeqInput, setCnabSeqInput] = useState("");
  const [guaranteeLoading, setGuaranteeLoading] = useState<Record<string, boolean>>({});
  const [retornoLoading, setRetornoLoading] = useState(false);
  const [retornoResult, setRetornoResult] = useState<any>(null);
  const [retornoDialogOpen, setRetornoDialogOpen] = useState(false);
  const retornoFileRef = useRef<HTMLInputElement>(null);
  const [syncLoading, setSyncLoading] = useState(false);

  async function handleSyncRepasses() {
    if (!confirm(`Sincronizar repasses de ${formatMonthLabel(month)}?\n\nIsso gera repasses para pagamentos PAGO que ainda nao tem repasse correspondente (pagamentos legados ou criados manualmente).`)) return;
    setSyncLoading(true);
    try {
      const res = await fetch(`/api/repasses/sync?month=${month}`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao sincronizar");
      if (data.repassesCriados === 0) {
        toast.info(data.mensagem);
      } else {
        toast.success(data.mensagem);
      }
      fetchRepasses();
    } catch (err: any) {
      toast.error(err.message || "Erro ao sincronizar repasses");
    } finally {
      setSyncLoading(false);
    }
  }

  async function handlePropagateDiscounts() {
    if (!confirm(
      `Propagar lançamentos do locatário para o proprietário em ${formatMonthLabel(month)}?\n\n` +
      `Verifica TenantEntries com destino=PROPRIETARIO que ainda não têm OwnerEntry criada (usa ID exato, sem heurística).\n\n` +
      `• Desconto do locatário → Débito no proprietário\n` +
      `• Cobrança extra do locatário → Crédito no proprietário`
    )) return;

    setSyncLoading(true);
    try {
      const res = await fetch(`/api/repasses/propagate-discounts?month=${month}`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao propagar");

      if (data.propagados === 0) {
        toast.info(data.mensagem);
      } else {
        toast.success(data.mensagem);
      }
      fetchRepasses();
    } catch (err: any) {
      toast.error(err.message || "Erro ao propagar descontos");
    } finally {
      setSyncLoading(false);
    }
  }

  async function handleUndoSync() {
    // Primeiro dryRun para mostrar quantos seriam removidos
    try {
      const opts = confirm(
        `Desfazer sincronizacao de lancamentos?\n\n` +
        `OK = Desfazer apenas ${formatMonthLabel(month)}\n` +
        `Cancelar = escolher outra opcao`
      );

      const queryMonth = opts
        ? `month=${month}`
        : confirm("Desfazer TODOS os meses? (remove todas as entries criadas pelo sync)\n\nOK = Todos os meses\nCancelar = Abortar")
        ? "all=true"
        : null;

      if (!queryMonth) return;

      // DryRun primeiro
      const dry = await fetch(`/api/repasses/undo-sync?${queryMonth}&dryRun=true`, {
        method: "DELETE",
      });
      const dryData = await dry.json();
      if (!dry.ok) throw new Error(dryData.error || "Erro no preview");

      if (dryData.total === 0) {
        toast.info("Nenhum lancamento criado pelo sync encontrado.");
        return;
      }

      if (!confirm(`Remover ${dryData.total} lancamento(s) PENDENTE(s) criado(s) pelo sync?\n\nIsso e IRREVERSIVEL mas nao afeta lancamentos pagos ou criados manualmente.`)) return;

      setSyncLoading(true);
      const res = await fetch(`/api/repasses/undo-sync?${queryMonth}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao desfazer sync");

      toast.success(`${data.removidos} lancamento(s) removido(s)`);
      fetchRepasses();
    } catch (err: any) {
      toast.error(err.message || "Erro ao desfazer sync");
    } finally {
      setSyncLoading(false);
    }
  }

  async function handleGuarantee(ownerId: string, ownerName: string) {
    if (!confirm(`Garantir aluguel atrasado de ${ownerName} para ${formatMonthLabel(month)}?\n\nIsso cria um crédito de garantia na conta do proprietário.`)) return;
    setGuaranteeLoading((prev) => ({ ...prev, [ownerId]: true }));
    try {
      const res = await fetch("/api/payments/guarantee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerId, month }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao garantir");
      toast.success(data.message);
      fetchRepasses();
    } catch (err: any) {
      toast.error(err.message || "Erro ao garantir aluguel");
    } finally {
      setGuaranteeLoading((prev) => ({ ...prev, [ownerId]: false }));
    }
  }

  async function handleRetornoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input para permitir re-upload do mesmo arquivo
    e.target.value = "";

    setRetornoLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("autoConfirm", "true");

      const res = await fetch("/api/repasses/cnab240-retorno", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Erro ao processar retorno");

      setRetornoResult(data);
      setRetornoDialogOpen(true);

      if (data.resumo.marcadosPago > 0) {
        const debitosTxt = data.resumo.debitosMarcados > 0
          ? ` + ${data.resumo.debitosMarcados} debito(s) do mes`
          : "";
        toast.success(
          `${data.resumo.marcadosPago} repasse(s) marcado(s) como PAGO automaticamente${debitosTxt}`
        );
        fetchRepasses();
      }
    } catch (err: any) {
      toast.error(err.message || "Erro ao importar retorno");
    } finally {
      setRetornoLoading(false);
    }
  }

  async function fetchRepasses() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (month) params.set("month", month);
      if (activeTab === "pix" || activeTab === "ted" || activeTab === "aguardando") {
        params.set("status", "PENDENTE");
      } else if (activeTab === "pagos" || activeTab === "confirmados") {
        params.set("status", "PAGO");
      }
      const response = await fetch(`/api/repasses?${params}`);
      if (response.ok) {
        const data = await response.json();
        setGroups(data);
      } else {
        const errText = await response.text().catch(() => "");
        console.error("Erro ao buscar repasses:", response.status, errText);
        toast.error(`Erro ao carregar repasses (${response.status})`);
      }
    } catch (error) {
      console.error("Erro ao buscar repasses:", error);
      toast.error("Erro de conexão ao carregar repasses");
    } finally {
      setLoading(false);
    }
  }

  // Auto-sync silencioso quando o admin abre /repasses ou troca de mes:
  // garante que todo Payment do mes (PAGO, PENDENTE, ATRASADO) tenha
  // OwnerEntry REPASSE correspondente. Cobre o caso de contratos cujo
  // billing/generate falhou ou Payments criados manualmente.
  async function autoSyncAndFetch() {
    if (canAdmin && month) {
      try {
        const res = await fetch(`/api/repasses/sync?month=${month}`, { method: "POST" });
        if (res.ok) {
          const data = await res.json();
          if (data.repassesCriados > 0) {
            toast.info(
              `${data.repassesCriados} repasse(s) sincronizado(s) automaticamente — boletos atrasados/pendentes agora aparecem na lista.`
            );
          }
        }
      } catch {
        // sync silencioso falhou — segue pro fetch normal
      }
    }
    await fetchRepasses();
  }

  useEffect(() => {
    autoSyncAndFetch();
    setSelectedEntries(new Set());
    setExpandedOwners(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, activeTab]);

  useEffect(() => {
    fetch("/api/repasses/cnab240").then(r => r.json()).then(d => {
      if (d.proximoSequencial) setCnabNextSeq(d.proximoSequencial);
    }).catch(() => {});
  }, []);

  const isPendente = activeTab === "pix" || activeTab === "ted";
  const isPagos = activeTab === "pagos" || activeTab === "confirmados";
  const isSelectable = isPendente || isPagos;

  // Summary — usa totalPago+totalPendente como bruto real
  // (totalPendente sozinho zera quando todos owners estao PAGO)
  const totalPendente = groups.reduce((sum, g) => sum + g.totalPendente, 0);
  const totalPago = groups.reduce((sum, g) => sum + g.totalPago, 0);
  const totalDebitos = groups.reduce((sum, g) => sum + (g.totalDebitos || 0), 0);
  // Bruto = todos creditos brutos (PAGO + PENDENTE), antes de descontar debitos
  const totalBruto = totalPago + totalPendente;
  // Liquido = bruto - debitos (= o que efetivamente devera ser repassado)
  const totalLiquido = groups.reduce((sum, g) => sum + (g.totalLiquido ?? g.totalPendente), 0);
  const totalProprietarios = groups.length;
  const totalEntries = groups.reduce((sum, g) => sum + g.entries.length, 0);

  // Filter by search
  const filteredGroups = groups.filter((g) => {
    // Filter by payment type on pix/ted tabs
    if (activeTab === "pix" || activeTab === "ted") {
      const types = getOwnerPaymentTypes(g.owner);
      if (!types.includes(activeTab === "pix" ? "PIX" : "TED")) return false;
      // Ocultar negativados das abas PIX/TED (viram débito no próximo mês)
      const liq = g.totalLiquido ?? g.totalPendente;
      if (liq <= 0) return false;
      // Ocultar repasses cujo boleto ainda nao foi pago — eles aparecem
      // exclusivamente na aba "Aguardando boleto" para nao induzir o admin
      // a transferir antes da liquidacao.
      const allBlocked = g.entries.every((e) => !isRepassReleased(e));
      if (allBlocked) return false;
    }
    if (activeTab === "aguardando") {
      // So mostra grupos com pelo menos 1 repasse cujo boleto nao foi pago
      const hasUnpaidBoleto = g.entries.some(
        (e) =>
          ["REPASSE", "GARANTIA"].includes(e.category) &&
          e.paymentStatus &&
          e.paymentStatus !== "PAGO"
      );
      if (!hasUnpaidBoleto) return false;
    }
    // Aba "Repassados": owners PAGO mas SEM confirmacao do banco
    // (admin clicou OK no confirm do CNAB mas .RET ainda nao foi importado)
    if (activeTab === "pagos") {
      if ((g as any).bankConfirmed === true) return false;
    }
    // Aba "Confirmados": apenas owners cujo .RET do Sicredi confirmou sucesso
    if (activeTab === "confirmados") {
      if ((g as any).bankConfirmed !== true) return false;
    }
    if (!search) return true;
    const term = search.toLowerCase();
    return (
      g.owner.name.toLowerCase().includes(term) ||
      g.owner.cpfCnpj.includes(term) ||
      (g.owner.thirdPartyName || "").toLowerCase().includes(term)
    );
  });

  function toggleOwner(ownerId: string) {
    setExpandedOwners((prev) => {
      const next = new Set(prev);
      if (next.has(ownerId)) next.delete(ownerId);
      else next.add(ownerId);
      return next;
    });
  }

  // Determina se a entry pode ser selecionada no "Selecionar Todos":
  //  - REPASSE/GARANTIA: usa isRepassReleased (boleto pago ou garantido)
  //  - Outras categorias (IPTU, AGUA, LUZ, etc): so libera se o REPASSE
  //    do MESMO contractId estiver liberado. Lei do Leo: nao adianta
  //    repassar IPTU se o aluguel ainda nao foi pago — o inquilino nao
  //    pagou e a imobiliaria nao recebeu nada pra repassar.
  function isEntryReleasable(entry: OwnerEntry, groupEntries: OwnerEntry[]): boolean {
    if (["REPASSE", "GARANTIA"].includes(entry.category)) {
      return isRepassReleased(entry);
    }
    if (!entry.contractId) return true; // entry sem contrato (manual avulsa)
    const repasseDoMesmoContract = groupEntries.find(
      (e) => ["REPASSE", "GARANTIA"].includes(e.category) && e.contractId === entry.contractId
    );
    if (!repasseDoMesmoContract) return true; // sem REPASSE relacionado, libera
    return isRepassReleased(repasseDoMesmoContract);
  }

  function toggleSelectAll(ownerId: string, entries: OwnerEntry[]) {
    const targetStatus = isPagos ? "PAGO" : "PENDENTE";
    const pendingIds = entries
      .filter((e) => e.status === targetStatus && isEntryReleasable(e, entries))
      .map((e) => e.id);
    const allSelected = pendingIds.every((id) => selectedEntries.has(id));

    setSelectedEntries((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        pendingIds.forEach((id) => next.delete(id));
      } else {
        pendingIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  function toggleEntry(entryId: string) {
    setSelectedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }

  function selectAllPending() {
    const targetStatus = isPagos ? "PAGO" : "PENDENTE";
    const allIds = groups.flatMap((g) =>
      g.entries
        .filter((e) => e.status === targetStatus && isEntryReleasable(e, g.entries))
        .map((e) => e.id)
    );
    setSelectedEntries(new Set(allIds));
  }

  function clearSelection() {
    setSelectedEntries(new Set());
  }

  function openConfirmDialog(action: "PAGO" | "PENDENTE") {
    setConfirmAction(action);
    setConfirmDialogOpen(true);
  }

  // Marca entries selecionadas como "Confirmado pelo Banco" manualmente.
  // Usado quando o admin sabe que o banco efetivou mas nao tem o .RET
  // pra importar (ou quer mover manual da aba Nao Confirmados pra Confirmados).
  async function handleConfirmBankManual() {
    setActionLoading(true);
    try {
      const res = await fetch("/api/repasses/confirm-bank-manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryIds: Array.from(selectedEntries) }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Erro ao confirmar pelo banco");
        return;
      }
      toast.success(data.message || `${data.total} confirmado(s)`);
      setSelectedEntries(new Set());
      fetchRepasses();
    } catch {
      toast.error("Erro ao confirmar pelo banco");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleBatchUpdate() {
    setActionLoading(true);
    try {
      const response = await fetch("/api/repasses", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryIds: Array.from(selectedEntries),
          status: confirmAction,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data.error || "Erro ao atualizar repasses");
        return;
      }
      toast.success(data.message);
      if (data.carryForward?.length > 0) {
        const lista = data.carryForward.map((cf: { owner: string; valor: number }) => `${cf.owner}: R$ ${cf.valor.toFixed(2)}`).join("\n");
        toast.info(`Saldo negativo transferido para próximo mês:\n${lista}`, { duration: 8000 });
      }
      setSelectedEntries(new Set());
      fetchRepasses();
    } catch (error) {
      toast.error("Erro ao atualizar repasses");
    } finally {
      setActionLoading(false);
      setConfirmDialogOpen(false);
    }
  }

  async function handleExportCSV() {
    try {
      const params = new URLSearchParams({ format: "csv" });
      if (month) params.set("month", month);
      if (selectedEntries.size > 0) {
        // Get unique owner IDs from selected entries
        const ownerIds = new Set<string>();
        groups.forEach((g) => {
          if (g.entries.some((e) => selectedEntries.has(e.id))) {
            ownerIds.add(g.owner.id);
          }
        });
        params.set("ownerIds", Array.from(ownerIds).join(","));
      }

      const response = await fetch(`/api/repasses/export?${params}`);
      if (!response.ok) throw new Error("Erro ao exportar");

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `remessa-pix-${month || "todos"}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Arquivo CSV exportado com sucesso!");
    } catch (error) {
      toast.error("Erro ao exportar remessa PIX");
    }
  }

  function openSeqEdit() {
    setCnabSeqInput(String(cnabNextSeq || 1));
    setCnabSeqEditing(true);
  }

  async function saveSeqEdit() {
    const num = parseInt(cnabSeqInput);
    if (isNaN(num) || num < 1) { toast.error("Número inválido"); return; }
    try {
      const res = await fetch("/api/repasses/cnab240", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sequencial: num }),
      });
      if (res.ok) {
        setCnabNextSeq(num);
        setCnabSeqEditing(false);
        toast.success(`Sequencial definido: ${num}`);
      } else {
        toast.error("Erro ao ajustar sequencial");
      }
    } catch {
      toast.error("Erro ao ajustar sequencial");
    }
  }

  async function handleGenerateCnab(forma: "PIX" | "TED") {
    setCnabLoading(true);
    try {
      // SEMPRE filtra owners pela forma do CNAB que esta sendo gerado.
      // Na aba "PIX"/"TED" filteredGroups ja vem filtrado, mas em
      // "Aguardando"/"Todos" pode misturar — entao reforcamos aqui
      // pra garantir que CNAB PIX nunca toque em owner TED e vice-versa.
      let cnabGroups = filteredGroups.filter((g) =>
        getOwnerPaymentTypes(g.owner).includes(forma)
      );
      if (selectedEntries.size > 0) {
        cnabGroups = cnabGroups.filter((g) => g.entries.some((e) => selectedEntries.has(e.id)));
      }

      if (cnabGroups.length === 0) {
        toast.error(`Nenhum proprietário com dados para ${forma} encontrado.`);
        setCnabLoading(false);
        return;
      }

      const ownerIds = cnabGroups.map((g) => g.owner.id);

      const response = await fetch("/api/repasses/cnab240", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month,
          ownerIds,
          formaPagamento: forma,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        if (data.erros?.length > 0) {
          const errosList = data.erros
            .map((e: { proprietario: string; motivo: string }) => `${e.proprietario}: ${e.motivo}`)
            .join("\n");
          toast.error(`${data.error}\n${errosList}`);
        } else {
          toast.error(data.error || "Erro ao gerar remessa CNAB");
        }
        return;
      }

      const blob = await response.blob();
      const totalPgtos = response.headers.get("X-Total-Pagamentos") || "0";
      const valorTotal = response.headers.get("X-Valor-Total") || "0";
      const errosHeader = response.headers.get("X-Erros");
      const erros = errosHeader ? JSON.parse(errosHeader) : [];

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disposition = response.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename="(.+)"/);
      a.download = filenameMatch ? filenameMatch[1] : `remessa-${month}.rem`;
      a.click();
      URL.revokeObjectURL(url);

      let msg = `Remessa CNAB 240 gerada: ${totalPgtos} pagamento(s), R$ ${parseFloat(valorTotal).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
      if (erros.length > 0) {
        msg += `. ${erros.length} proprietario(s) ignorado(s) por dados bancarios incompletos.`;
      }
      toast.success(msg);
      // Atualizar próximo sequencial
      fetch("/api/repasses/cnab240").then(r => r.json()).then(d => {
        if (d.proximoSequencial) setCnabNextSeq(d.proximoSequencial);
      }).catch(() => {});

      // Pergunta se quer marcar os repasses incluidos no CNAB como PAGO.
      // O proprio CNAB envia o pagamento — assim que o admin confirmar
      // o envio do arquivo pro Sicredi, faz sentido marcar como pago
      // pra nao precisar voltar e marcar manualmente.
      //
      // Filtra APENAS owners cuja forma de pagamento bate com a forma do
      // CNAB que foi gerado. Antes da correcao, se o admin estivesse na
      // aba "Todos" ou "Aguardando", o cnabGroups incluia owners de TED
      // e PIX juntos — e clicar OK marcava os TEDs como pagos tambem.
      const entryIdsNoCnab = cnabGroups
        .filter((g) => getOwnerPaymentTypes(g.owner).includes(forma))
        .flatMap((g) =>
          g.entries
            .filter((e) => e.status === "PENDENTE" && isRepassReleased(e))
            .map((e) => e.id)
        );
      if (entryIdsNoCnab.length > 0) {
        const confirmou = window.confirm(
          `CNAB gerado. Marcar os ${entryIdsNoCnab.length} repasse(s) incluidos como PAGOS agora?\n\n` +
          `⚠️ ATENÇÃO: confira PRIMEIRO se o sequencial do CNAB está correto antes de aceitar.\n\n` +
          `Use isso apenas DEPOIS de confirmar o envio do arquivo pro Sicredi. Os débitos do mês desses proprietários também serão marcados como pagos.\n\n` +
          `Se errar, dá pra reverter com /api/admin/revert-batch-pago (últimos 60 min).`
        );
        if (confirmou) {
          try {
            const r = await fetch("/api/repasses", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ entryIds: entryIdsNoCnab, status: "PAGO" }),
            });
            const data = await r.json();
            if (r.ok) {
              toast.success(data.message || "Repasses marcados como PAGOS");
              fetchRepasses();
            } else {
              toast.error(data.error || "Erro ao marcar repasses como PAGOS");
            }
          } catch {
            toast.error("Erro ao marcar repasses como PAGOS");
          }
        }
      }
    } catch (error) {
      toast.error("Erro ao gerar remessa CNAB 240");
    } finally {
      setCnabLoading(false);
    }
  }

  async function handleDeleteEntry(entryId: string, description: string) {
    // Em vez de DELETE (que apaga permanentemente e some do historico de
    // meses anteriores), usa CANCELAR — preserva o registro mas remove do
    // calculo de totais. Caso reportado: ao apagar uma entry exibida na aba
    // do mes corrente que tinha dueDate em mes anterior, sumia tambem da
    // aba do mes passado.
    if (!confirm(`Cancelar lançamento "${description}"?\n\nA entry sera marcada como CANCELADA (preserva historico). Para excluir permanentemente, use a tela de Lançamentos.`)) return;
    try {
      const res = await fetch(`/api/owner-entries/${entryId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CANCELADO" }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Erro ao cancelar");
      }
      toast.success("Lançamento cancelado");
      fetchRepasses();
    } catch (err: any) {
      toast.error(err.message || "Erro ao cancelar lançamento");
    }
  }

  async function handleEditEntryValue(entry: OwnerEntry) {
    const novoValorStr = window.prompt(
      `Editar valor de "${entry.description}"\n\nValor atual: ${formatCurrency(entry.value)}\n\nNovo valor (R$):`,
      entry.value.toFixed(2).replace(".", ",")
    );
    if (!novoValorStr) return;
    const novoValor = parseFloat(novoValorStr.replace(",", "."));
    if (!Number.isFinite(novoValor) || novoValor < 0) {
      toast.error("Valor inválido");
      return;
    }
    const novaDesc = window.prompt(
      "Descrição (opcional, deixe igual se não quiser mudar):",
      entry.description
    );
    if (novaDesc === null) return; // cancelou
    try {
      const res = await fetch(`/api/owner-entries/${entry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: novoValor, description: novaDesc.trim() || entry.description }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Erro ao salvar");
      }
      toast.success("Lançamento atualizado");
      fetchRepasses();
    } catch (err: any) {
      toast.error(err.message || "Erro ao atualizar lançamento");
    }
  }

  // Marca/desmarca a flag "aluguel garantido este mes" no notes JSON da
  // OwnerEntry. Quando ativa, o repasse pode ser liberado mesmo sem o
  // pagamento do inquilino (a imobiliaria adianta).
  async function handleToggleAluguelGarantido(entry: OwnerEntry) {
    let notesData: Record<string, unknown> = {};
    if (entry.notes) {
      try { notesData = JSON.parse(entry.notes); } catch {}
    }
    const novoEstado = !notesData.aluguelGarantidoMes;
    notesData.aluguelGarantidoMes = novoEstado;
    try {
      const res = await fetch(`/api/owner-entries/${entry.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: JSON.stringify(notesData) }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Erro ao salvar");
      }
      toast.success(
        novoEstado
          ? "Aluguel garantido pela imobiliária neste mês"
          : "Aluguel garantido desativado neste mês"
      );
      fetchRepasses();
    } catch (err: any) {
      toast.error(err.message || "Erro ao atualizar");
    }
  }

  async function handleCreateEntry(ownerId: string, ownerName: string) {
    // Buscar contratos ativos do proprietario
    let contractsList: { id: string; code: string; property: { title: string } | null }[] = [];
    try {
      const r = await fetch(`/api/contracts?ownerId=${ownerId}&status=ATIVO`);
      if (r.ok) {
        const data = await r.json();
        contractsList = Array.isArray(data) ? data : data.data || [];
      }
    } catch {
      // ignore, segue sem contratos
    }

    const description = prompt(`Novo lançamento para ${ownerName}\n\nDescrição:`);
    if (!description) return;
    const valueStr = prompt("Valor (R$):");
    if (!valueStr) return;
    const value = parseFloat(valueStr.replace(",", "."));
    if (isNaN(value) || value <= 0) { toast.error("Valor inválido"); return; }

    const typeStr = prompt("Tipo:\n1 - Crédito (proprietário recebe)\n2 - Débito (descontar do repasse)") || "1";
    const type = typeStr === "2" ? "DEBITO" : "CREDITO";
    const category = prompt("Categoria (REPASSE, IPTU, CONDOMINIO, REPARO, TAXA_BANCARIA, DESCONTO, ACORDO, OUTROS):") || "OUTROS";

    // Perguntar contrato para vincular (se houver mais de um)
    let contractId: string | null = null;
    if (contractsList.length === 1) {
      contractId = contractsList[0].id;
    } else if (contractsList.length > 1) {
      const options = contractsList
        .map((c, i) => `${i + 1} - ${c.code} (${c.property?.title || "sem imovel"})`)
        .join("\n");
      const ans = prompt(
        `Vincular a qual contrato? (digite 0 para nao vincular)\n\n${options}\n\nDigite o numero:`
      );
      const idx = parseInt(ans || "0");
      if (!isNaN(idx) && idx >= 1 && idx <= contractsList.length) {
        contractId = contractsList[idx - 1].id;
      }
    }

    try {
      const [y, m] = month.split("-").map(Number);
      const dueDate = new Date(y, m - 1, 10);
      const res = await fetch("/api/owner-entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          category: category.toUpperCase(),
          description,
          value,
          ownerId,
          contractId,
          dueDate: dueDate.toISOString(),
          status: "PENDENTE",
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Erro ao criar");
      }
      toast.success(`Lançamento criado: ${description} - ${formatCurrency(value)}`);
      fetchRepasses();
    } catch (err: any) {
      toast.error(err.message || "Erro ao criar lançamento");
    }
  }

  function copyPixKey(owner: OwnerData) {
    const pix = owner.thirdPartyPix || owner.bankPix;
    if (pix) {
      navigator.clipboard.writeText(pix);
      toast.success(`Chave PIX copiada: ${pix}`);
    }
  }

  const selectedTotal = groups.reduce((sum, g) => {
    const selectedCredits = g.entries
      .filter((e) => selectedEntries.has(e.id))
      .reduce((s, e) => s + e.value, 0);
    if (selectedCredits === 0) return sum;
    // Se selecionou entries deste proprietário, descontar débitos pendentes
    const debitos = (g.debitEntries || []).reduce((s, d) => s + d.value, 0);
    return sum + selectedCredits - debitos;
  }, 0);

  return (
    <div className="flex flex-col">
      <Header title="Repasses" subtitle="Gerenciamento de repasses aos proprietarios" />

      <div className="p-4 sm:p-6 space-y-4">
        {/* Summary Cards — agregados da empresa, so admin ve */}
        {canAdmin && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">A Repassar (Liquido)</p>
                  <p className="text-2xl font-bold mt-1">
                    {loading ? "..." : formatCurrency(totalLiquido)}
                  </p>
                  {totalDebitos > 0 && (
                    <p className="text-xs text-red-500 mt-0.5">
                      Bruto: {formatCurrency(totalBruto)} | Debitos: -{formatCurrency(totalDebitos)}
                    </p>
                  )}
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
                  <p className="text-xs font-medium text-muted-foreground">Ja Repassado</p>
                  <p className="text-2xl font-bold mt-1">
                    {loading ? "..." : formatCurrency(totalPago)}
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
                  <p className="text-xs font-medium text-muted-foreground">Proprietarios</p>
                  <p className="text-2xl font-bold mt-1">
                    {loading ? "..." : totalProprietarios}
                  </p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-100">
                  <Users className="h-5 w-5 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-sm">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Total Lancamentos</p>
                  <p className="text-2xl font-bold mt-1">
                    {loading ? "..." : totalEntries}
                  </p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100">
                  <DollarSign className="h-5 w-5 text-violet-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
        )}

        {/* Selection bar */}
        {selectedEntries.size > 0 && (
          <Card className="border-0 shadow-sm bg-primary/5">
            <CardContent className="p-3 sm:p-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    {selectedEntries.size} selecionado(s)
                  </Badge>
                  <span className="text-sm font-semibold">
                    Total líquido: {formatCurrency(selectedTotal)}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 h-8 text-xs"
                    onClick={clearSelection}
                  >
                    Limpar
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 h-8 text-xs"
                    onClick={handleExportCSV}
                  >
                    <Download className="h-3.5 w-3.5" />
                    CSV
                  </Button>
                  <div className="flex items-center gap-1">
                    {cnabNextSeq != null && (
                      cnabSeqEditing ? (
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            min={1}
                            value={cnabSeqInput}
                            onChange={(e) => setCnabSeqInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") saveSeqEdit(); if (e.key === "Escape") setCnabSeqEditing(false); }}
                            className="h-7 w-16 text-xs text-center"
                            autoFocus
                          />
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={saveSeqEdit}>OK</Button>
                        </div>
                      ) : (
                        <button onClick={openSeqEdit} className="text-[10px] text-muted-foreground mr-1 hover:text-primary hover:underline" title="Clique para ajustar o sequencial">Seq: {cnabNextSeq}</button>
                      )
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 h-8 text-xs"
                      onClick={() => handleGenerateCnab(activeTab === "pix" ? "PIX" : "TED")}
                      disabled={cnabLoading}
                    >
                      <FileText className="h-3.5 w-3.5" />
                      {cnabLoading ? "..." : `CNAB ${activeTab === "pix" ? "PIX" : "TED"}`}
                    </Button>
                  </div>
                  {isPagos ? (
                    <>
                      {activeTab === "pagos" && (
                        <Button
                          size="sm"
                          className="gap-1.5 h-8 text-xs bg-emerald-600 hover:bg-emerald-700"
                          onClick={handleConfirmBankManual}
                          disabled={actionLoading}
                          title="Marca os selecionados como confirmados pelo banco (move pra aba 'Confirmados Banco')"
                        >
                          ✅ Marcar Confirmado Banco
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 h-8 text-xs border-amber-300 text-amber-700 hover:bg-amber-50"
                        onClick={() => openConfirmDialog("PENDENTE")}
                      >
                        <Clock className="h-3.5 w-3.5" />
                        Reverter para Pendente
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      className="gap-1.5 h-8 text-xs bg-emerald-600 hover:bg-emerald-700"
                      onClick={() => openConfirmDialog("PAGO")}
                      title="Use quando o repasse foi feito FORA do CNAB (manual via PIX/TED no banco). Move para a aba 'Não Confirmados' ate o banco confirmar via .RET."
                    >
                      <Send className="h-3.5 w-3.5" />
                      Marcar como Pago (Manual)
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Filters */}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-0">
            <div className="flex flex-col gap-3 p-4 border-b">
              <div className="flex items-center gap-2 flex-wrap">
                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-auto">
                  <TabsList className="h-9 sm:h-8">
                    <TabsTrigger value="pix" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">
                      A Repassar PIX
                    </TabsTrigger>
                    <TabsTrigger value="ted" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">
                      A Repassar TED
                    </TabsTrigger>
                    <TabsTrigger value="aguardando" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">
                      Aguardando boleto
                    </TabsTrigger>
                    <TabsTrigger value="pagos" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">
                      ⏳ Não Confirmados
                    </TabsTrigger>
                    <TabsTrigger value="confirmados" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">
                      ✅ Confirmados Banco
                    </TabsTrigger>
                    <TabsTrigger value="todos" className="text-xs h-8 sm:h-7 px-2.5 sm:px-3">
                      Todos
                    </TabsTrigger>
                  </TabsList>
                </Tabs>

                <Input
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  className="h-10 sm:h-8 w-auto text-sm sm:text-xs"
                />

                <input
                  ref={retornoFileRef}
                  type="file"
                  accept=".ret,.RET,.txt"
                  className="hidden"
                  onChange={handleRetornoUpload}
                />
                {/* Acoes destrutivas — somente ADMIN. CORRETOR/FINANCEIRO
                    veem listagem + demonstrativo + export, sem essas. */}
                {canAdmin && (<>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 h-10 sm:h-8 text-xs"
                  onClick={() => retornoFileRef.current?.click()}
                  disabled={retornoLoading}
                >
                  <Upload className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">
                    {retornoLoading ? "Processando..." : "Importar Retorno"}
                  </span>
                  <span className="sm:hidden">
                    {retornoLoading ? "..." : "Retorno"}
                  </span>
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 h-10 sm:h-8 text-xs"
                  onClick={handleSyncRepasses}
                  disabled={syncLoading}
                  title="Gerar repasses para pagamentos PAGO que ainda nao tem repasse"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${syncLoading ? "animate-spin" : ""}`} />
                  <span className="hidden sm:inline">
                    {syncLoading ? "Sincronizando..." : "Sincronizar"}
                  </span>
                  <span className="sm:hidden">
                    {syncLoading ? "..." : "Sync"}
                  </span>
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 h-10 sm:h-8 text-xs text-blue-700 hover:text-blue-800 hover:bg-blue-50 border-blue-300"
                  onClick={handlePropagateDiscounts}
                  disabled={syncLoading}
                  title="Propagar descontos do locatario (destination=PROPRIETARIO) para o proprietario"
                >
                  <Shield className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Propagar Descontos</span>
                  <span className="sm:hidden">Descontos</span>
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 h-10 sm:h-8 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
                  onClick={handleUndoSync}
                  disabled={syncLoading}
                  title="Remover lancamentos auto-criados pelo Sincronizar"
                >
                  <X className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Desfazer Sync</span>
                  <span className="sm:hidden">Desfazer</span>
                </Button>
                </>)}

                {canAdmin && isSelectable && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 h-10 sm:h-8 text-xs"
                      onClick={selectAllPending}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Selecionar Todos</span>
                      <span className="sm:hidden">Todos</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 h-10 sm:h-8 text-xs"
                      onClick={handleExportCSV}
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Exportar CSV</span>
                      <span className="sm:hidden">CSV</span>
                    </Button>
                    {isPendente && (
                      <div className="flex items-center gap-1">
                        {cnabNextSeq != null && (
                          cnabSeqEditing ? (
                            <div className="flex items-center gap-1">
                              <Input
                                type="number"
                                min={1}
                                value={cnabSeqInput}
                                onChange={(e) => setCnabSeqInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") saveSeqEdit(); if (e.key === "Escape") setCnabSeqEditing(false); }}
                                className="h-7 w-16 text-xs text-center"
                                autoFocus
                              />
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={saveSeqEdit}>OK</Button>
                            </div>
                          ) : (
                            <button onClick={openSeqEdit} className="text-[10px] text-muted-foreground mr-1 hover:text-primary hover:underline" title="Clique para ajustar o sequencial">Seq: {cnabNextSeq}</button>
                          )
                        )}
                        <Button
                          size="sm"
                          className={cn("gap-1.5 h-10 sm:h-8 text-xs", activeTab === "pix" ? "bg-blue-600 hover:bg-blue-700" : "bg-indigo-600 hover:bg-indigo-700")}
                          onClick={() => handleGenerateCnab(activeTab === "pix" ? "PIX" : "TED")}
                          disabled={cnabLoading}
                        >
                          <FileText className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">
                            {cnabLoading ? "Gerando..." : `Gerar CNAB ${activeTab === "pix" ? "PIX" : "TED"}`}
                          </span>
                          <span className="sm:hidden">
                            {cnabLoading ? "..." : "CNAB"}
                          </span>
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Buscar proprietario..."
                  className="pl-9 h-10 sm:h-8 w-full sm:w-[250px] text-sm sm:text-xs"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">Carregando...</p>
              </div>
            ) : filteredGroups.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-sm text-muted-foreground">
                  {search
                    ? "Nenhum proprietario encontrado."
                    : `Nenhum repasse ${activeTab === "pix" ? "PIX a repassar" : activeTab === "ted" ? "TED a repassar" : activeTab === "pagos" ? "repassado aguardando confirmação do banco" : activeTab === "confirmados" ? "confirmado pelo banco" : activeTab === "aguardando" ? "aguardando boleto" : ""} para ${formatMonthLabel(month)}.`}
                </p>
              </div>
            ) : (
              <>
                {/* Mobile view */}
                <div className="divide-y md:hidden">
                  {filteredGroups.map((group) => {
                    const isExpanded = expandedOwners.has(group.owner.id);
                    const pendingEntries = group.entries.filter(
                      (e) => e.status === "PENDENTE"
                    );
                    const selectableEntries = isPagos
                      ? group.entries.filter((e) => e.status === "PAGO")
                      : pendingEntries;
                    const allSelected =
                      selectableEntries.length > 0 &&
                      selectableEntries.every((e) => selectedEntries.has(e.id));
                    const isNegativoMobile = (group.totalLiquido ?? group.totalPendente) < 0;

                    return (
                      <div key={group.owner.id} className={cn(isNegativoMobile && "bg-red-50/50")}>
                        {/* Owner header */}
                        <div
                          className="p-4 cursor-pointer active:bg-muted/50"
                          onClick={() => toggleOwner(group.owner.id)}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-start gap-3 min-w-0">
                              {isSelectable && selectableEntries.length > 0 && !isNegativoMobile && (
                                <Checkbox
                                  checked={allSelected}
                                  onCheckedChange={() =>
                                    toggleSelectAll(group.owner.id, group.entries)
                                  }
                                  onClick={(e) => e.stopPropagation()}
                                  className="mt-0.5"
                                />
                              )}
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <p className="text-sm font-semibold truncate">
                                    {group.owner.name}
                                  </p>
                                  {group.isCoOwner ? (
                                    <Badge variant="outline" className="text-[9px] h-4 px-1 bg-blue-50 text-blue-700 border-blue-200 shrink-0">
                                      {group.sharePercent}%
                                    </Badge>
                                  ) : null}
                                </div>
                                {group.owner.thirdPartyName && (
                                  <p className="text-[11px] text-muted-foreground">
                                    Recebedor: {group.owner.thirdPartyName}
                                  </p>
                                )}
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {group.entries.length} lancamento(s) | Dia {group.owner.paymentDay}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <div className="text-right">
                                {group.totalPendente > 0 && (
                                  <p className="text-sm font-bold text-yellow-600">
                                    {formatCurrency(group.totalLiquido ?? group.totalPendente)}
                                  </p>
                                )}
                                {(group.totalDebitos ?? 0) > 0 && (
                                  <p className="text-[11px] text-red-500">
                                    Debitos: -{formatCurrency(group.totalDebitos!)}
                                  </p>
                                )}
                                {group.totalPago > 0 && (
                                  <p className="text-xs text-emerald-600">
                                    Pago: {formatCurrency(group.totalPago)}
                                  </p>
                                )}
                              </div>
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Expanded entries */}
                        {isExpanded && (
                          <div className="bg-muted/30 border-t">
                            {/* Aviso de observacao do proprietario */}
                            {group.owner.notes && (
                              <div className="px-4 py-2 bg-amber-50 border-b border-amber-200">
                                <div className="flex items-start gap-2 text-xs text-amber-900">
                                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                  <div>
                                    <strong>Atencao:</strong> {group.owner.notes}
                                  </div>
                                </div>
                              </div>
                            )}
                            {/* Bank info */}
                            <div className="px-4 py-2 border-b bg-muted/50">
                              <div className="flex items-center justify-between">
                                <div className="text-xs text-muted-foreground">
                                  <div className="flex items-center gap-1.5">
                                    <Banknote className="h-3.5 w-3.5" />
                                    <span className="font-medium">
                                      {getRecipientName(group.owner)}
                                    </span>
                                    {getOwnerPaymentTypes(group.owner).map((t) => (
                                      <Badge key={t} variant={t === "PIX" ? "default" : "secondary"} className="text-[10px] px-1.5 py-0 h-4">
                                        {t}
                                      </Badge>
                                    ))}
                                  </div>
                                  {(group.owner.thirdPartyPix || group.owner.bankPix) ? (
                                    <p className="mt-0.5 ml-5">
                                      PIX: {getPixDisplay(group.owner)}
                                    </p>
                                  ) : getBankDisplay(group.owner) ? (
                                    <p className="mt-0.5 ml-5">
                                      {getBankDisplay(group.owner)}
                                    </p>
                                  ) : (
                                    <p className="mt-0.5 ml-5 text-amber-600">
                                      Dados bancarios nao cadastrados
                                    </p>
                                  )}
                                  {group.owner.payoutBeneficiaries && group.owner.payoutBeneficiaries.length > 0 && (() => {
                                    const sumPct = group.owner.payoutBeneficiaries!.reduce((s, b) => s + b.percentage, 0);
                                    const ownerPct = Math.max(0, Math.round((100 - sumPct) * 100) / 100);
                                    return (
                                      <p className="mt-1 ml-5 text-[10px] text-purple-700">
                                        Split: titular {ownerPct.toFixed(2)}%
                                        {group.owner.payoutBeneficiaries!.map((b, idx) => (
                                          <span key={idx}> | {b.name.split(" ")[0]} {b.percentage}%</span>
                                        ))}
                                      </p>
                                    );
                                  })()}
                                </div>
                                {(group.owner.bankPix || group.owner.thirdPartyPix) && (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8"
                                    onClick={() => copyPixKey(group.owner)}
                                  >
                                    <Copy className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                              </div>
                            </div>

                            {/* Entry list */}
                            {group.entries.map((entry) => (
                              <div
                                key={entry.id}
                                className="px-4 py-2.5 border-b last:border-0 flex items-center justify-between gap-2"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  {entry.status === "PENDENTE" && (
                                    isRepassReleased(entry) ? (
                                      <Checkbox
                                        checked={selectedEntries.has(entry.id)}
                                        onCheckedChange={() => toggleEntry(entry.id)}
                                      />
                                    ) : (
                                      <Checkbox
                                        checked={false}
                                        disabled
                                        title="Aguardando pagamento do boleto"
                                      />
                                    )
                                  )}
                                  <div className="min-w-0">
                                    <p className="text-xs truncate">{entry.description}</p>
                                    <p className="text-[11px] text-muted-foreground">
                                      Venc: {formatDate(entry.dueDate)}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  {(() => {
                                    const b = getBoletoStatusBadge(entry);
                                    if (!b) return null;
                                    return (
                                      <Badge
                                        variant="outline"
                                        className={cn("text-[9px] h-5 border gap-1 px-1.5", b.className)}
                                        title={b.tooltip}
                                      >
                                        <AlertCircle className="h-2.5 w-2.5" />
                                        {b.label}
                                      </Badge>
                                    );
                                  })()}
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      "text-[10px] h-5 border",
                                      entry.status === "PAGO"
                                        ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                                        : "bg-yellow-100 text-yellow-700 border-yellow-200"
                                    )}
                                  >
                                    {entry.status === "PAGO" ? "Pago" : "Pendente"}
                                  </Badge>
                                  <span className="text-sm font-semibold">
                                    {formatCurrency(entry.value)}
                                  </span>
                                </div>
                              </div>
                            ))}

                            {/* Debitos pendentes */}
                            {(group.debitEntries?.length ?? 0) > 0 && (
                              <div className="border-t bg-red-50/50">
                                <div className="px-4 py-1.5 text-[11px] font-semibold text-red-600 uppercase">
                                  Debitos a descontar
                                </div>
                                {group.debitEntries!.map((debit) => (
                                  <div
                                    key={debit.id}
                                    className="px-4 py-2 border-t border-red-100 flex items-center justify-between"
                                  >
                                    <div className="min-w-0">
                                      <p className="text-xs truncate text-red-700">{debit.description}</p>
                                      <p className="text-[11px] text-red-400">
                                        {debit.category} | {formatDate(debit.dueDate)}
                                      </p>
                                    </div>
                                    <span className="text-sm font-semibold text-red-600">
                                      -{formatCurrency(debit.value)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Valor liquido */}
                            {(group.totalDebitos ?? 0) > 0 && (
                              <div className="px-4 py-2 border-t bg-muted/50 flex items-center justify-between">
                                <span className="text-xs font-semibold">Valor Liquido</span>
                                <span className="text-sm font-bold">
                                  {formatCurrency(group.totalLiquido ?? group.totalPendente)}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Desktop view */}
                <div className="hidden md:block">
                  {filteredGroups.map((group) => {
                    const isExpanded = expandedOwners.has(group.owner.id);
                    const pendingEntries = group.entries.filter(
                      (e) => e.status === "PENDENTE"
                    );
                    const selectableEntries = isPagos
                      ? group.entries.filter((e) => e.status === "PAGO")
                      : pendingEntries;
                    const allSelected =
                      selectableEntries.length > 0 &&
                      selectableEntries.every((e) => selectedEntries.has(e.id));
                    const isNegativo = (group.totalLiquido ?? group.totalPendente) < 0;

                    return (
                      <div key={group.owner.id} className={cn("border-b last:border-0", isNegativo && "bg-red-50/50")}>
                        {/* Owner row */}
                        <div
                          className={cn(
                            "flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors",
                            isExpanded && "bg-muted/30"
                          )}
                          onClick={() => toggleOwner(group.owner.id)}
                        >
                          {isSelectable && selectableEntries.length > 0 && !isNegativo && (
                            <Checkbox
                              checked={allSelected}
                              onCheckedChange={() =>
                                toggleSelectAll(group.owner.id, group.entries)
                              }
                              onClick={(e) => e.stopPropagation()}
                            />
                          )}

                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold">{group.owner.name}</p>
                              <span className="text-xs text-muted-foreground">
                                ({group.owner.cpfCnpj})
                              </span>
                              {group.isCoOwner ? (
                                <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-blue-50 text-blue-700 border-blue-200">
                                  Co-proprietário {group.sharePercent}%
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-slate-50 text-slate-600 border-slate-200">
                                  Proprietário
                                </Badge>
                              )}
                            </div>
                            {group.owner.thirdPartyName && (
                              <p className="text-xs text-muted-foreground">
                                Recebedor: {group.owner.thirdPartyName}
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-4 shrink-0">
                            <div className="text-right">
                              <p className="text-xs text-muted-foreground">
                                {group.entries.length} lancamento(s) | Dia{" "}
                                {group.owner.paymentDay}
                              </p>
                            </div>

                            <div className="flex items-center gap-2">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.open(`/repasses/demonstrativo?ownerId=${group.owner.id}&month=${month}`, "_blank");
                                }}
                                title="Demonstrativo de repasse (PDF)"
                              >
                                <FileText className="h-3.5 w-3.5" />
                              </Button>
                              {(group.owner.bankPix || group.owner.thirdPartyPix) && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyPixKey(group.owner);
                                  }}
                                  title="Copiar chave PIX"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>

                            {group.totalPendente > 0 && (
                              <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-xs">
                                Créditos: {formatCurrency(group.totalPendente)}
                              </Badge>
                            )}
                            {(group.totalDebitos ?? 0) > 0 && (
                              <Badge className="bg-red-100 text-red-700 border-red-200 text-xs">
                                Débitos: -{formatCurrency(group.totalDebitos!)}
                              </Badge>
                            )}
                            {(() => {
                              const liq = group.totalLiquido ?? group.totalPendente;
                              if (liq < 0) return (
                                <Badge className="bg-red-600 text-white border-red-700 text-xs font-bold">
                                  Negativado: {formatCurrency(liq)}
                                </Badge>
                              );
                              if (group.totalPendente > 0) return (
                                <Badge className="bg-yellow-100 text-yellow-700 border-yellow-200 text-xs font-bold">
                                  Líq: {formatCurrency(liq)}
                                </Badge>
                              );
                              return null;
                            })()}
                            {group.totalPago > 0 && (
                              <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-xs">
                                {formatCurrency(group.totalPago)}
                              </Badge>
                            )}
                          </div>
                        </div>

                        {/* Expanded section */}
                        {isExpanded && (
                          <div className="bg-muted/20">
                            {/* Aviso de observacao do proprietario (ex: 'metade vai pra irma') */}
                            {group.owner.notes && (
                              <div className="px-6 py-2 bg-amber-50 border-y border-amber-200">
                                <div className="flex items-start gap-2 text-xs text-amber-900">
                                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                  <div>
                                    <strong>Atencao:</strong> {group.owner.notes}
                                  </div>
                                </div>
                              </div>
                            )}
                            {/* Bank info bar */}
                            <div className="px-6 py-2 bg-muted/40 border-y flex items-center gap-6 text-xs text-muted-foreground">
                              <div className="flex items-center gap-1.5">
                                <Banknote className="h-3.5 w-3.5" />
                                <span className="font-medium">
                                  {getRecipientName(group.owner)}
                                </span>
                                {getOwnerPaymentTypes(group.owner).map((t) => (
                                  <Badge key={t} variant={t === "PIX" ? "default" : "secondary"} className="text-[10px] px-1.5 py-0 h-4">
                                    {t}
                                  </Badge>
                                ))}
                              </div>
                              {(group.owner.thirdPartyPix || group.owner.bankPix) ? (
                                <span>PIX: {getPixDisplay(group.owner)}</span>
                              ) : getBankDisplay(group.owner) ? (
                                <span>{getBankDisplay(group.owner)}</span>
                              ) : (
                                <span className="text-amber-600">Dados bancarios nao cadastrados</span>
                              )}
                              {group.owner.payoutBeneficiaries && group.owner.payoutBeneficiaries.length > 0 && (() => {
                                const sumPct = group.owner.payoutBeneficiaries!.reduce((s, b) => s + b.percentage, 0);
                                const ownerPct = Math.max(0, Math.round((100 - sumPct) * 100) / 100);
                                return (
                                  <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-purple-700 bg-purple-50 border border-purple-200 rounded px-1.5 py-0.5">
                                    Split: {ownerPct.toFixed(2)}% titular
                                    {group.owner.payoutBeneficiaries!.map((b, idx) => (
                                      <span key={idx}> | {b.name.split(" ")[0]} {b.percentage}%</span>
                                    ))}
                                  </span>
                                );
                              })()}
                              <div className="flex items-center gap-1.5 ml-auto">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-6 px-2 text-[11px] gap-1 text-blue-700 border-blue-300 hover:bg-blue-50"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCreateEntry(group.owner.id, group.owner.name);
                                  }}
                                >
                                  <Plus className="h-3 w-3" />
                                  Novo Lançamento
                                </Button>
                                {isPendente && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 px-2 text-[11px] gap-1 text-amber-700 border-amber-300 hover:bg-amber-50"
                                    disabled={guaranteeLoading[group.owner.id]}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleGuarantee(group.owner.id, group.owner.name);
                                    }}
                                  >
                                    <Shield className="h-3 w-3" />
                                    {guaranteeLoading[group.owner.id] ? "..." : "Garantir Aluguel"}
                                  </Button>
                                )}
                              </div>
                            </div>

                            {/* Composição resumida */}
                            {(() => {
                              const creditsByCategory: Record<string, number> = {};
                              let totalAdminFee = 0;
                              let adminFeePercent = 0;
                              let totalAluguelBruto = 0;
                              let totalIntermediacao = 0;
                              let totalIrrf = 0;
                              let sharePercent: number | undefined;
                              for (const e of group.entries) {
                                if (e.status === "CANCELADO") continue;
                                creditsByCategory[e.category] = (creditsByCategory[e.category] || 0) + e.value;
                                // Extrair taxa adm do notes dos entries REPASSE/GARANTIA
                                if (["REPASSE", "GARANTIA"].includes(e.category) && e.notes) {
                                  try {
                                    const n = JSON.parse(e.notes);
                                    // Somar valores de TODOS os contratos do proprietário
                                    if (n.adminFeeValue) totalAdminFee += n.adminFeeValue;
                                    if (n.adminFeePercent) adminFeePercent = n.adminFeePercent;
                                    if (n.aluguelBruto) totalAluguelBruto += n.aluguelBruto;
                                    if (n.intermediacao) totalIntermediacao += n.intermediacao;
                                    if (n.irrfValue) totalIrrf += n.irrfValue;
                                    if (n.sharePercent) sharePercent = n.sharePercent;
                                  } catch {}
                                }
                              }
                              const debitsByCategory: Record<string, number> = {};
                              for (const d of (group.debitEntries || [])) {
                                debitsByCategory[d.category] = (debitsByCategory[d.category] || 0) + d.value;
                              }
                              const totalCreditos = Object.values(creditsByCategory).reduce((s, v) => s + v, 0);
                              const totalDebitos = Object.values(debitsByCategory).reduce((s, v) => s + v, 0);
                              // Líquido do contrato (antes do split)
                              const liquidoContrato = totalAluguelBruto > 0
                                ? totalAluguelBruto - totalAdminFee - totalIntermediacao - totalIrrf
                                : 0;
                              const categoryLabels: Record<string, string> = {
                                REPASSE: "Repasse Aluguel",
                                GARANTIA: "Garantia Aluguel",
                                IPTU: "Crédito IPTU",
                                CONDOMINIO: "Crédito Condomínio",
                                INTERMEDIACAO: "Intermediação",
                                REPARO: "Reparo",
                                TAXA_BANCARIA: "Taxa Bancária",
                                DESCONTO: "Desconto",
                                ACORDO: "Acordo",
                                OUTROS: "Outros",
                              };
                              return (
                                <div className="px-6 py-2 border-b bg-slate-50/50 flex flex-wrap items-center gap-x-6 gap-y-1 text-[11px]">
                                  {totalAluguelBruto > 0 && (
                                    <span className="text-muted-foreground">
                                      Aluguel bruto: {formatCurrency(Math.round(totalAluguelBruto * 100) / 100)}
                                    </span>
                                  )}
                                  {totalAdminFee > 0.01 && (
                                    <span className="text-orange-600 font-medium">
                                      Taxa adm: {adminFeePercent}%
                                    </span>
                                  )}
                                  {totalIntermediacao > 0 && (
                                    <span className="text-orange-600 font-medium">
                                      Intermediação: -{formatCurrency(Math.round(totalIntermediacao * 100) / 100)}
                                    </span>
                                  )}
                                  {totalIrrf > 0 && (
                                    <span className="text-orange-600 font-medium">
                                      IRRF: -{formatCurrency(Math.round(totalIrrf * 100) / 100)}
                                    </span>
                                  )}
                                  {sharePercent && liquidoContrato > 0 && (
                                    <span className="text-blue-600 font-medium">
                                      Parte ({sharePercent}%): {formatCurrency(Math.round(liquidoContrato * (sharePercent / 100) * 100) / 100)}
                                    </span>
                                  )}
                                  {Object.entries(creditsByCategory)
                                    .filter(([cat]) => !(["REPASSE", "GARANTIA"].includes(cat) && totalAluguelBruto > 0))
                                    .map(([cat, val]) => (
                                    <span key={cat} className="text-emerald-700 font-medium">
                                      + {categoryLabels[cat] || cat}: {formatCurrency(Math.round(val * 100) / 100)}
                                    </span>
                                  ))}
                                  {Object.entries(debitsByCategory).map(([cat, val]) => (
                                    <span key={cat} className="text-red-600 font-medium">
                                      - {categoryLabels[cat] || cat}: {formatCurrency(Math.round(val * 100) / 100)}
                                    </span>
                                  ))}
                                  <span className="font-bold text-xs ml-auto">
                                    = {formatCurrency(Math.round((totalCreditos - totalDebitos) * 100) / 100)}
                                  </span>
                                </div>
                              );
                            })()}

                            {/* Entries table */}
                            <Table>
                              <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                  {isSelectable && (
                                    <TableHead className="w-10"></TableHead>
                                  )}
                                  <TableHead className="text-xs">Descricao</TableHead>
                                  <TableHead className="text-xs">Vencimento</TableHead>
                                  <TableHead className="text-xs">Status</TableHead>
                                  <TableHead className="text-xs text-right">Valor</TableHead>
                                  <TableHead className="w-10"></TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {group.entries.map((entry) => (
                                  <TableRow key={entry.id} className="hover:bg-muted/30">
                                    {isSelectable && (
                                      <TableCell>
                                        {((isPendente && entry.status === "PENDENTE") || (isPagos && entry.status === "PAGO")) && !isNegativo && (
                                          isRepassReleased(entry) ? (
                                            <Checkbox
                                              checked={selectedEntries.has(entry.id)}
                                              onCheckedChange={() => toggleEntry(entry.id)}
                                            />
                                          ) : (
                                            <TooltipProvider delayDuration={200}>
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <span className="inline-block">
                                                    <Checkbox checked={false} disabled />
                                                  </span>
                                                </TooltipTrigger>
                                                <TooltipContent side="right">
                                                  <p className="text-xs">Aguardando pagamento do boleto. Nao e possivel marcar como repassado ainda.</p>
                                                </TooltipContent>
                                              </Tooltip>
                                            </TooltipProvider>
                                          )
                                        )}
                                      </TableCell>
                                    )}
                                    <TableCell className="text-xs">
                                      <div className="flex items-center gap-1.5">
                                        {entry.category !== "REPASSE" && (
                                          <Badge variant="outline" className={cn(
                                            "text-[9px] h-4 px-1 border shrink-0",
                                            entry.category === "IPTU" ? "bg-purple-50 text-purple-700 border-purple-200" :
                                            entry.category === "CONDOMINIO" ? "bg-orange-50 text-orange-700 border-orange-200" :
                                            entry.category === "GARANTIA" ? "bg-amber-50 text-amber-700 border-amber-200" :
                                            "bg-slate-50 text-slate-600 border-slate-200"
                                          )}>
                                            {entry.category === "GARANTIA" ? (
                                              <span className="flex items-center gap-0.5"><Shield className="h-2.5 w-2.5" /> GARANTIA</span>
                                            ) : entry.category}
                                          </Badge>
                                        )}
                                        {entry.notes && ["REPASSE", "GARANTIA"].includes(entry.category) ? (() => {
                                          try {
                                            const n = JSON.parse(entry.notes!);
                                            if (!n.adminFeePercent) return <span>{entry.description}</span>;
                                            const adminCobrada = !n.adminWaived && (n.adminFeeValue ?? 0) > 0;
                                            return (
                                              <TooltipProvider delayDuration={200}>
                                                <Tooltip>
                                                  <TooltipTrigger asChild>
                                                    <span className="cursor-help underline decoration-dotted">{entry.description}</span>
                                                  </TooltipTrigger>
                                                  <TooltipContent side="bottom" className="max-w-xs p-3 space-y-1">
                                                    <p className="font-medium border-b pb-1 mb-1 text-xs">Composição do Repasse</p>
                                                    <p className="text-xs">Aluguel bruto: {formatCurrency(n.aluguelBruto)}</p>
                                                    {adminCobrada ? (
                                                      <p className="text-xs text-red-600">- Taxa adm: {n.adminFeePercent}%</p>
                                                    ) : (
                                                      <p className="text-xs text-emerald-700">Taxa adm: isenta (intermediacao no mes)</p>
                                                    )}
                                                    {n.intermediacao > 0 && (
                                                      <p className="text-xs text-red-600">- Intermediação: {formatCurrency(n.intermediacao)}</p>
                                                    )}
                                                    {n.irrfValue > 0 && (
                                                      <p className="text-xs text-red-600">- IRRF ({(n.irrfRate * 100).toFixed(1)}%): {formatCurrency(n.irrfValue)}</p>
                                                    )}
                                                    <p className="text-xs font-semibold border-t pt-1 mt-1">= Líquido: {formatCurrency(n.netToOwner)}</p>
                                                  </TooltipContent>
                                                </Tooltip>
                                              </TooltipProvider>
                                            );
                                          } catch { return <span>{entry.description}</span>; }
                                        })() : <span>{entry.description}</span>}
                                      </div>
                                    </TableCell>
                                    <TableCell className="text-xs">
                                      {formatDate(entry.dueDate)}
                                    </TableCell>
                                    <TableCell>
                                      <div className="flex flex-col gap-1 items-start">
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                          <Badge
                                            variant="outline"
                                            className={cn(
                                              "text-[10px] h-5 border",
                                              entry.status === "PAGO"
                                                ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                                                : "bg-yellow-100 text-yellow-700 border-yellow-200"
                                            )}
                                          >
                                            {entry.status === "PAGO" ? "Pago" : "Pendente"}
                                          </Badge>
                                          {entry.paidAt && (
                                            <span className="text-[11px] text-muted-foreground">
                                              {formatDate(entry.paidAt)}
                                            </span>
                                          )}
                                        </div>
                                        {(() => {
                                          const b = getBoletoStatusBadge(entry);
                                          if (!b) return null;
                                          return (
                                            <TooltipProvider delayDuration={200}>
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <Badge
                                                    variant="outline"
                                                    className={cn("text-[10px] h-5 border gap-1 cursor-help", b.className)}
                                                  >
                                                    <AlertCircle className="h-2.5 w-2.5" />
                                                    {b.label}
                                                  </Badge>
                                                </TooltipTrigger>
                                                <TooltipContent side="bottom" className="max-w-xs">
                                                  <p className="text-xs">{b.tooltip}</p>
                                                </TooltipContent>
                                              </Tooltip>
                                            </TooltipProvider>
                                          );
                                        })()}
                                        {(() => {
                                          const info = getIntermediacaoConsumidaInfo(entry);
                                          if (!info) return null;
                                          return (
                                            <TooltipProvider delayDuration={200}>
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <Badge
                                                    variant="outline"
                                                    className="text-[10px] h-5 border gap-1 cursor-help bg-cyan-50 text-cyan-700 border-cyan-200"
                                                  >
                                                    <AlertCircle className="h-2.5 w-2.5" />
                                                    Intermediação consumiu repasse
                                                  </Badge>
                                                </TooltipTrigger>
                                                <TooltipContent side="bottom" className="max-w-xs space-y-1">
                                                  <p className="text-xs">
                                                    A parcela de intermediação ({formatCurrency(info.intermediacao)}) foi descontada inteira do repasse deste mês — por isso o valor a repassar ficou em zero.
                                                  </p>
                                                  {info.nota && (
                                                    <p className="text-[10px] text-muted-foreground">{info.nota}</p>
                                                  )}
                                                </TooltipContent>
                                              </Tooltip>
                                            </TooltipProvider>
                                          );
                                        })()}
                                      </div>
                                    </TableCell>
                                    <TableCell className="text-right text-xs font-semibold">
                                      {formatCurrency(entry.value)}
                                    </TableCell>
                                    <TableCell>
                                      <div className="flex items-center gap-0.5">
                                        {["REPASSE", "GARANTIA"].includes(entry.category) && entry.contractId && (
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className={cn(
                                              "h-6 w-6",
                                              isAluguelGarantidoMes(entry)
                                                ? "text-emerald-600 hover:text-emerald-700"
                                                : "text-muted-foreground hover:text-emerald-600"
                                            )}
                                            title={
                                              isAluguelGarantidoMes(entry)
                                                ? "Aluguel garantido pela imobiliária neste mês (clique para desativar)"
                                                : "Marcar como aluguel garantido pela imobiliária neste mês"
                                            }
                                            onClick={() => handleToggleAluguelGarantido(entry)}
                                          >
                                            <Shield className="h-3.5 w-3.5" />
                                          </Button>
                                        )}
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6 text-muted-foreground hover:text-blue-600"
                                          title="Editar valor / descrição"
                                          onClick={() => handleEditEntryValue(entry)}
                                        >
                                          <Pencil className="h-3.5 w-3.5" />
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6 text-muted-foreground hover:text-red-600"
                                          title="Excluir lançamento"
                                          onClick={() => handleDeleteEntry(entry.id, entry.description)}
                                        >
                                          <X className="h-3.5 w-3.5" />
                                        </Button>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>

                            {/* Debitos a descontar */}
                            {(group.debitEntries?.length ?? 0) > 0 && (
                              <div className="border-t bg-red-50/50">
                                <div className="px-6 py-1.5 text-[11px] font-semibold text-red-600 uppercase border-b border-red-100">
                                  Debitos a descontar do repasse
                                </div>
                                <Table>
                                  <TableBody>
                                    {group.debitEntries!.map((debit) => {
                                      const isCarryover = debit.dueDate && month
                                        ? new Date(debit.dueDate) < new Date(parseInt(month.split("-")[0]), parseInt(month.split("-")[1]) - 1, 1)
                                        : false;
                                      return (
                                        <TableRow key={debit.id} className="hover:bg-red-50">
                                          {isSelectable && <TableCell className="w-10" />}
                                          <TableCell className="text-xs text-red-700">
                                            <div className="flex items-center gap-1.5">
                                              {isCarryover && (
                                                <Badge variant="outline" className="text-[9px] h-4 px-1 border bg-orange-50 text-orange-600 border-orange-200 shrink-0">
                                                  Mês anterior
                                                </Badge>
                                              )}
                                              <span>{debit.description}</span>
                                            </div>
                                          </TableCell>
                                          <TableCell className="text-xs text-red-500">
                                            {formatDate(debit.dueDate)}
                                          </TableCell>
                                          <TableCell>
                                            <Badge variant="outline" className="text-[10px] h-5 border bg-red-100 text-red-700 border-red-200">
                                              {debit.category}
                                            </Badge>
                                          </TableCell>
                                          <TableCell className="text-right text-xs font-semibold text-red-600">
                                            -{formatCurrency(debit.value)}
                                          </TableCell>
                                          <TableCell>
                                            <div className="flex items-center gap-0.5">
                                              <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-6 w-6 text-muted-foreground hover:text-blue-600"
                                                title="Editar valor / descrição"
                                                onClick={() => handleEditEntryValue(debit as OwnerEntry)}
                                              >
                                                <Pencil className="h-3.5 w-3.5" />
                                              </Button>
                                              <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-6 w-6 text-muted-foreground hover:text-red-600"
                                                title="Excluir débito"
                                                onClick={() => handleDeleteEntry(debit.id, debit.description)}
                                              >
                                                <X className="h-3.5 w-3.5" />
                                              </Button>
                                            </div>
                                          </TableCell>
                                        </TableRow>
                                      );
                                    })}
                                  </TableBody>
                                </Table>
                              </div>
                            )}

                            {/* Valor liquido */}
                            {(group.totalDebitos ?? 0) > 0 && (
                              <div className="px-6 py-2 border-t bg-muted/40 flex items-center justify-between">
                                <span className="text-xs font-semibold">Valor Liquido do Repasse</span>
                                <span className="text-sm font-bold">
                                  {formatCurrency(group.totalLiquido ?? group.totalPendente)}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Confirm dialog */}
      <AlertDialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "PAGO"
                ? "Marcar como Pago (Manual)"
                : "Reverter para Pendente"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "PAGO"
                ? `Deseja marcar ${selectedEntries.size} repasse(s) como PAGO no valor líquido de ${formatCurrency(selectedTotal)}? Use isso quando o repasse foi feito MANUALMENTE no banco (fora do CNAB). Eles vão para a aba "⏳ Não Confirmados" até o banco confirmar via .RET ou webhook.`
                : `Deseja reverter ${selectedEntries.size} repasse(s) para PENDENTE?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBatchUpdate}
              disabled={actionLoading}
              className={
                confirmAction === "PAGO"
                  ? "bg-emerald-600 hover:bg-emerald-700"
                  : ""
              }
            >
              {actionLoading
                ? "Processando..."
                : confirmAction === "PAGO"
                  ? "Confirmar Repasse"
                  : "Reverter"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Retorno CNAB dialog */}
      <AlertDialog open={retornoDialogOpen} onOpenChange={setRetornoDialogOpen}>
        <AlertDialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Resultado da Importacao - Retorno CNAB 240
            </AlertDialogTitle>
            {retornoResult && (
              <div className="space-y-4 text-sm">
                {/* Resumo do arquivo */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
                  <div className="bg-blue-50 rounded-lg p-3 text-center">
                    <p className="text-xs text-blue-600 font-medium">Total</p>
                    <p className="text-lg font-bold text-blue-700">{retornoResult.resumo.totalPagamentos}</p>
                  </div>
                  <div className="bg-emerald-50 rounded-lg p-3 text-center">
                    <p className="text-xs text-emerald-600 font-medium">Sucesso</p>
                    <p className="text-lg font-bold text-emerald-700">{retornoResult.resumo.sucesso}</p>
                  </div>
                  <div className="bg-red-50 rounded-lg p-3 text-center">
                    <p className="text-xs text-red-600 font-medium">Erro</p>
                    <p className="text-lg font-bold text-red-700">{retornoResult.resumo.erro}</p>
                  </div>
                  <div className="bg-violet-50 rounded-lg p-3 text-center">
                    <p className="text-xs text-violet-600 font-medium">Entries PAGO</p>
                    <p className="text-lg font-bold text-violet-700">{retornoResult.resumo.entriesMarcadas || retornoResult.resumo.marcadosPago}</p>
                  </div>
                </div>
                {/* Linha extra: divergencias + complementos + revertidos + confirmados banco */}
                {(retornoResult.resumo.valoresDivergentes > 0 || retornoResult.resumo.complementosCriados > 0 || retornoResult.resumo.revertidos > 0 || retornoResult.resumo.confirmadosBanco > 0) && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    {retornoResult.resumo.valoresDivergentes > 0 && (
                      <div className="bg-amber-50 rounded-lg p-3 text-center">
                        <p className="text-xs text-amber-600 font-medium">Valor Divergente</p>
                        <p className="text-lg font-bold text-amber-700">{retornoResult.resumo.valoresDivergentes}</p>
                      </div>
                    )}
                    {retornoResult.resumo.complementosCriados > 0 && (
                      <div className="bg-orange-50 rounded-lg p-3 text-center">
                        <p className="text-xs text-orange-600 font-medium">Complementos Gerados</p>
                        <p className="text-lg font-bold text-orange-700">{retornoResult.resumo.complementosCriados}</p>
                      </div>
                    )}
                    {retornoResult.resumo.revertidos > 0 && (
                      <div className="bg-rose-50 rounded-lg p-3 text-center">
                        <p className="text-xs text-rose-600 font-medium">Revertidos (Erro)</p>
                        <p className="text-lg font-bold text-rose-700">{retornoResult.resumo.revertidos}</p>
                      </div>
                    )}
                    {retornoResult.resumo.confirmadosBanco > 0 && (
                      <div className="bg-teal-50 rounded-lg p-3 text-center">
                        <p className="text-xs text-teal-600 font-medium">Confirmados Banco</p>
                        <p className="text-lg font-bold text-teal-700">{retornoResult.resumo.confirmadosBanco}</p>
                      </div>
                    )}
                  </div>
                )}

                <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                  <span>Data: {retornoResult.arquivo.dataGeracao}</span>
                  <span>Empresa: {retornoResult.arquivo.empresa}</span>
                  <span>Seq: {retornoResult.arquivo.sequencial}</span>
                  <span>Valor total: {formatCurrency(retornoResult.resumo.valorTotal)}</span>
                  <span>Valor efetivado: {formatCurrency(retornoResult.resumo.valorEfetivado)}</span>
                </div>

                {/* Tabela de resultados */}
                <div className="border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Favorecido</TableHead>
                        <TableHead className="text-xs">Valor</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs">Ocorrencias</TableHead>
                        <TableHead className="text-xs">Match</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {retornoResult.resultados.map((r: any, i: number) => (
                        <TableRow key={i} className={cn(
                          r.status === "erro" && "bg-red-50/50",
                          r.status === "divergente" && "bg-amber-50/50",
                          r.status === "sucesso" && r.marcadoPago && "bg-emerald-50/50",
                        )}>
                          <TableCell className="text-xs">
                            <div>{r.favorecido}</div>
                            {r.ownerName && r.ownerName !== r.favorecido && (
                              <div className="text-muted-foreground text-[10px]">{r.ownerName}</div>
                            )}
                          </TableCell>
                          <TableCell className="text-xs font-medium">
                            <div>{formatCurrency(r.valor)}</div>
                            {r.valorDivergente && (
                              <div className="text-[10px] text-amber-700">
                                Esperado: {formatCurrency(r.valorEsperado)} (diff: {formatCurrency(r.diffValor)})
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {r.status === "sucesso" ? (
                              <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-[10px]">
                                <CheckCircle2 className="h-3 w-3 mr-0.5" />
                                OK
                              </Badge>
                            ) : r.status === "divergente" ? (
                              <Badge className="bg-amber-100 text-amber-700 border-amber-200 text-[10px]">
                                <AlertCircle className="h-3 w-3 mr-0.5" />
                                VALOR DIVERGE
                              </Badge>
                            ) : r.status === "sem_match" ? (
                              <Badge className="bg-gray-100 text-gray-600 border-gray-200 text-[10px]">
                                SEM MATCH
                              </Badge>
                            ) : (
                              <Badge className="bg-red-100 text-red-700 border-red-200 text-[10px]">
                                <AlertCircle className="h-3 w-3 mr-0.5" />
                                ERRO
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-[10px] text-muted-foreground max-w-[200px] truncate" title={r.ocorrencias}>
                            {r.ocorrencias}
                          </TableCell>
                          <TableCell className="text-xs">
                            {(r.entryIds?.length > 0 || r.entryId) ? (
                              r.marcadoPago ? (
                                <Badge className="bg-violet-100 text-violet-700 border-violet-200 text-[10px]">
                                  PAGO {r.entriesMarcadas > 1 ? `(${r.entriesMarcadas})` : ""}
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-[10px]">Encontrado</Badge>
                              )
                            ) : (
                              <span className="text-muted-foreground text-[10px]">Sem match</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction>Fechar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
