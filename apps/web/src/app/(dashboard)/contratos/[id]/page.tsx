"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Header } from "@/components/layout/header";
import { GUARANTEE_INSURER_LABELS } from "@/lib/guarantee-insurers";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft,
  Pencil,
  Trash2,
  Loader2,
  DollarSign,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  FileText,
  ExternalLink,
  Building2,
  Users,
  UserCheck,
  Calendar,
  Shield,
  Clock,
  Download,
  Paperclip,
  RefreshCw,
  Upload,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ContractForm } from "@/components/forms/contract-form";
import { BillingTimeline } from "@/components/billing/billing-timeline";

// ---------- Types ----------

interface Payment {
  id: string;
  code: string;
  value: number;
  paidValue: number | null;
  fineValue: number | null;
  interestValue: number | null;
  discountValue: number | null;
  dueDate: string;
  paidAt: string | null;
  status: string;
  paymentMethod: string | null;
  description: string | null;
  splitOwnerValue: number | null;
  splitAdminValue: number | null;
  irrfValue: number | null;
  irrfRate: number | null;
  grossToOwner: number | null;
  netToOwner: number | null;
  notes: string | null;
  nossoNumero: string | null;
  linhaDigitavel: string | null;
  codigoBarras: string | null;
  boletoStatus: string | null;
}

interface Contract {
  id: string;
  code: string;
  type: string;
  status: string;
  propertyId: string;
  property: { id: string; title: string; address?: string; registrationNumber?: string | null; iptuNumber?: string | null; energyMeter?: string | null; waterMeter?: string | null; gasMeter?: string | null; condoAdmin?: string | null };
  ownerId: string;
  owner: { id: string; name: string; email?: string; paymentDay?: number };
  tenantId: string;
  tenant: { id: string; name: string; email?: string; paymentDay?: number };
  rentalValue: number;
  adminFeePercent: number;
  paymentDay: number;
  startDate: string;
  endDate: string;
  guaranteeType: string | null;
  guaranteeValue: number | null;
  guaranteeNotes: string | null;
  guaranteeInsurer: string | null;
  intermediationFee: number | null;
  intermediationInstallments: number | null;
  adjustmentIndex: string | null;
  adjustmentMonth: number | null;
  lastAdjustmentPercent: number | null;
  lastAdjustmentDate: string | null;
  documentUrl: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  payments: Payment[];
}

interface ContractDocument {
  id: string;
  name: string;
  url: string;
  mimeType: string | null;
  size: number | null;
  category: string | null;
  createdAt: string;
}

// ---------- Config maps ----------

const contractStatusConfig: Record<string, { label: string; className: string }> = {
  ATIVO: { label: "Ativo", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  PENDENTE_RENOVACAO: { label: "Renovação", className: "bg-amber-100 text-amber-700 border-amber-200" },
  ENCERRADO: { label: "Encerrado", className: "bg-muted text-muted-foreground" },
  RESCINDIDO: { label: "Rescindido", className: "bg-orange-100 text-orange-700 border-orange-200" },
  CANCELADO: { label: "Cancelado", className: "bg-red-100 text-red-700 border-red-200" },
};

const paymentStatusConfig: Record<string, { label: string; className: string }> = {
  PAGO: { label: "Pago", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  PENDENTE: { label: "Pendente", className: "bg-yellow-100 text-yellow-700 border-yellow-200" },
  ATRASADO: { label: "Atrasado", className: "bg-red-100 text-red-700 border-red-200" },
  CANCELADO: { label: "Cancelado", className: "bg-gray-100 text-gray-500 border-gray-200" },
  PARCIAL: { label: "Parcial", className: "bg-blue-100 text-blue-700 border-blue-200" },
};

const guaranteeTypeLabels: Record<string, string> = {
  FIADOR: "Fiador",
  CAUCAO: "Caução",
  SEGURO_FIANCA: "Seguro Fiança",
  TITULO_CAPITALIZACAO: "Título Capitalização",
  SEM_GARANTIA: "Sem Garantia",
};

const contractTypeLabels: Record<string, string> = {
  LOCACAO: "Locação",
  VENDA: "Venda",
  TEMPORADA: "Temporada",
};

const monthLabels: Record<number, string> = {
  1: "Janeiro",
  2: "Fevereiro",
  3: "Março",
  4: "Abril",
  5: "Maio",
  6: "Junho",
  7: "Julho",
  8: "Agosto",
  9: "Setembro",
  10: "Outubro",
  11: "Novembro",
  12: "Dezembro",
};

// ---------- Helpers ----------

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatDateLong(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ---------- Sub-components ----------

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between py-2.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-right">{value}</span>
    </div>
  );
}

function SectionTitle({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
    </div>
  );
}

// ---------- Main Page ----------

export default function ContratoDetalhePage() {
  const params = useParams();
  const router = useRouter();
  const contractId = params.id as string;

  const [contract, setContract] = useState<Contract | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [relatedDocs, setRelatedDocs] = useState<{ id: string; code: string; type: string; status: string; startDate: string; documentUrl?: string }[]>([]);
  const [reajusteDialogOpen, setReajusteDialogOpen] = useState(false);
  const [reajustePercent, setReajustePercent] = useState("");
  const [reajusteLoading, setReajusteLoading] = useState(false);
  const [renewDialogOpen, setRenewDialogOpen] = useState(false);
  const [renewEndDate, setRenewEndDate] = useState("");
  const [renewRentalValue, setRenewRentalValue] = useState("");
  const [renewLoading, setRenewLoading] = useState(false);
  const [terminateDialogOpen, setTerminateDialogOpen] = useState(false);
  const [terminateDate, setTerminateDate] = useState("");
  const [terminateReason, setTerminateReason] = useState("");
  const [terminateLoading, setTerminateLoading] = useState(false);
  const [contractDocs, setContractDocs] = useState<ContractDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  const [pdfPreviewName, setPdfPreviewName] = useState<string>("");
  const [codesDialogOpen, setCodesDialogOpen] = useState(false);
  const [codesForm, setCodesForm] = useState({ registrationNumber: "", iptuNumber: "", energyMeter: "", waterMeter: "", gasMeter: "", condoAdmin: "" });
  const [codesSaving, setCodesSaving] = useState(false);

  function openCodesDialog() {
    if (contract?.property) {
      setCodesForm({
        registrationNumber: contract.property.registrationNumber || "",
        iptuNumber: contract.property.iptuNumber || "",
        energyMeter: contract.property.energyMeter || "",
        waterMeter: contract.property.waterMeter || "",
        gasMeter: contract.property.gasMeter || "",
        condoAdmin: contract.property.condoAdmin || "",
      });
    }
    setCodesDialogOpen(true);
  }

  async function saveCodes() {
    if (!contract) return;
    setCodesSaving(true);
    try {
      const res = await fetch(`/api/properties/${contract.propertyId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(codesForm),
      });
      if (res.ok) {
        toast.success("Códigos atualizados!");
        setCodesDialogOpen(false);
        fetchContract();
      } else {
        toast.error("Erro ao salvar códigos");
      }
    } catch {
      toast.error("Erro ao salvar códigos");
    } finally {
      setCodesSaving(false);
    }
  }

  async function fetchContract() {
    setLoading(true);
    setNotFound(false);
    try {
      const response = await fetch(`/api/contracts/${contractId}`);
      if (response.status === 404) {
        setNotFound(true);
        return;
      }
      if (response.ok) {
        const data = await response.json();
        setContract(data);
        // Fetch related docs (same tenant, different type)
        if (data.tenantId) {
          fetch(`/api/contracts?tenantId=${data.tenantId}`)
            .then(r => r.json())
            .then(res => {
              const items = Array.isArray(res) ? res : res.data || [];
              setRelatedDocs(items.filter((c: any) => c.id !== data.id && c.type !== "LOCACAO"));
            })
            .catch(() => {});
        }
      }
    } catch (error) {
      console.error("Erro ao buscar contrato:", error);
    } finally {
      setLoading(false);
    }
  }

  async function fetchContractDocs() {
    setDocsLoading(true);
    try {
      const res = await fetch(`/api/documents?entityType=CONTRACT&entityId=${contractId}`);
      if (res.ok) {
        const data = await res.json();
        setContractDocs(Array.isArray(data) ? data : []);
      }
    } catch {
      // silently fail
    } finally {
      setDocsLoading(false);
    }
  }

  useEffect(() => {
    if (contractId) {
      fetchContract();
      fetchContractDocs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId]);

  async function handleDeleteConfirm() {
    if (!contract) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/contracts/${contract.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || "Erro ao excluir contrato");
        return;
      }
      router.push("/contratos");
    } catch (error) {
      toast.error("Erro ao excluir contrato");
    } finally {
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  }

  function handleFormSuccess() {
    fetchContract();
  }

  async function handleApplyReajuste() {
    if (!contract || reajustePercent === "" || reajustePercent == null) return;
    setReajusteLoading(true);
    try {
      const percent = parseFloat(reajustePercent);
      if (isNaN(percent)) {
        toast.error("Informe um percentual valido.");
        return;
      }
      if (percent < -50 || percent > 100) {
        toast.error("Percentual fora do intervalo (-50% a 100%).");
        return;
      }
      const response = await fetch(`/api/contracts/${contract.id}/apply-adjustment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ percent }),
      });
      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || "Erro ao aplicar reajuste");
        return;
      }
      const data = await response.json();
      toast.success(data.mensagem || "Reajuste aplicado");
      setReajusteDialogOpen(false);
      setReajustePercent("");
      fetchContract();
    } catch (error) {
      toast.error("Erro ao aplicar reajuste");
    } finally {
      setReajusteLoading(false);
    }
  }

  async function handleRenewContract() {
    if (!contract) return;
    setRenewLoading(true);
    try {
      // Calculate renewalMonths from endDate if provided
      let renewalMonths: number | undefined;
      if (renewEndDate) {
        const oldEnd = new Date(contract.endDate);
        const newEnd = new Date(renewEndDate);
        if (newEnd <= oldEnd) {
          toast.error("A nova data de termino deve ser posterior a data de termino atual.");
          return;
        }
        // Calculate months difference from old endDate + 1 day to new endDate
        const newStart = new Date(oldEnd);
        newStart.setDate(newStart.getDate() + 1);
        renewalMonths = (newEnd.getFullYear() - newStart.getFullYear()) * 12 + (newEnd.getMonth() - newStart.getMonth());
        if (renewalMonths < 1) renewalMonths = 1;
      }

      const payload: Record<string, unknown> = {};
      if (renewalMonths != null) payload.renewalMonths = renewalMonths;
      if (renewRentalValue && !isNaN(parseFloat(renewRentalValue))) {
        payload.rentalValue = parseFloat(renewRentalValue);
      }

      const response = await fetch(`/api/contracts/${contract.id}/renew`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.json();
        toast.error(error.error || "Erro ao renovar contrato");
        return;
      }

      const newContract = await response.json();
      setRenewDialogOpen(false);
      setRenewEndDate("");
      setRenewRentalValue("");
      // Navigate to the new contract
      router.push(`/contratos/${newContract.id}`);
    } catch (error) {
      toast.error("Erro ao renovar contrato");
    } finally {
      setRenewLoading(false);
    }
  }

  // ---------- Rescindir Contrato ----------
  async function handleTerminateContract() {
    if (!contract) return;
    setTerminateLoading(true);
    try {
      const payload: { terminatedAt?: string; terminationReason?: string } = {};
      if (terminateDate) payload.terminatedAt = terminateDate;
      if (terminateReason.trim()) payload.terminationReason = terminateReason.trim();

      const response = await fetch(`/api/contracts/${contract.id}/terminate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        toast.error(error.error || "Erro ao rescindir contrato");
        return;
      }

      toast.success("Contrato rescindido. Novas cobranças não serão geradas.");
      setTerminateDialogOpen(false);
      setTerminateDate("");
      setTerminateReason("");
      await fetchContract();
    } catch {
      toast.error("Erro ao rescindir contrato");
    } finally {
      setTerminateLoading(false);
    }
  }

  // ---------- Loading state ----------

  if (loading) {
    return (
      <div className="flex flex-col">
        <Header title="Contrato" subtitle="Carregando detalhes..." />
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // ---------- 404 state ----------

  if (notFound || !contract) {
    return (
      <div className="flex flex-col">
        <Header title="Contrato" subtitle="Contrato nao encontrado" />
        <div className="p-4 sm:p-6">
          <div className="flex flex-col items-center justify-center py-24 space-y-4">
            <FileText className="h-12 w-12 text-muted-foreground/50" />
            <p className="text-muted-foreground">Contrato nao encontrado.</p>
            <Button variant="outline" onClick={() => router.push("/contratos")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Voltar para Contratos
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Computed values ----------

  const statusCfg = contractStatusConfig[contract.status] || {
    label: contract.status,
    className: "bg-muted text-muted-foreground",
  };

  const typeLabel = contractTypeLabels[contract.type] || contract.type;

  const adminValue = (contract.rentalValue * contract.adminFeePercent) / 100;
  const ownerNetValue = contract.rentalValue - adminValue;

  // IRRF: check the latest payment for IRRF data
  const latestPaymentWithIrrf = contract.payments.find((p) => p.irrfValue && p.irrfValue > 0);
  const hasIrrf = !!latestPaymentWithIrrf;

  const totalReceived = contract.payments
    .filter((p) => p.status === "PAGO" || p.status === "PARCIAL")
    .reduce((sum, p) => sum + (p.paidValue ?? 0), 0);

  const totalOverdue = contract.payments
    .filter((p) => p.status === "ATRASADO")
    .reduce((sum, p) => sum + p.value, 0);

  const paidCount = contract.payments.filter((p) => p.status === "PAGO").length;
  const pendingCount = contract.payments.filter((p) => p.status === "PENDENTE").length;
  const overdueCount = contract.payments.filter((p) => p.status === "ATRASADO").length;

  return (
    <div className="flex flex-col">
      <Header title="Contrato" subtitle="Detalhes do contrato" />

      <div className="p-4 sm:p-6 space-y-6">
        {/* Back button + Header */}
        <div className="space-y-4">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-foreground -ml-2"
            onClick={() => router.push("/contratos")}
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar para Contratos
          </Button>

          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <FileText className="h-5 w-5 text-primary" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold text-foreground">
                    {contract.code}
                  </h2>
                  <Badge variant="outline" className={cn("text-xs border", statusCfg.className)}>
                    {statusCfg.label}
                  </Badge>
                  <Badge variant="secondary" className="text-xs">
                    {typeLabel}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Criado em {formatDateLong(contract.createdAt)}
                  {contract.createdBy && (
                    <span> por <strong>{contract.createdBy.name}</strong></span>
                  )}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {(contract.status === "ATIVO" || contract.status === "PENDENTE_RENOVACAO") && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setRenewDialogOpen(true)}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Renovar Contrato
                </Button>
              )}
              {(contract.status === "ATIVO" || contract.status === "PENDENTE_RENOVACAO") && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-amber-700 hover:text-amber-700 hover:bg-amber-50 border-amber-200"
                  onClick={() => setTerminateDialogOpen(true)}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Rescindir Contrato
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setReajusteDialogOpen(true)}
              >
                <TrendingUp className="h-3.5 w-3.5" />
                Aplicar Reajuste
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setFormOpen(true)}
              >
                <Pencil className="h-3.5 w-3.5" />
                Editar
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => setDeleteDialogOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Excluir
              </Button>
            </div>
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-primary" />
                <p className="text-xs font-medium text-muted-foreground">Valor Aluguel</p>
              </div>
              <p className="text-xl font-bold text-primary mt-1">
                {formatCurrency(contract.rentalValue)}
              </p>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                <p className="text-xs font-medium text-muted-foreground">Taxa Adm.</p>
              </div>
              <p className="text-xl font-bold text-foreground mt-1">
                {formatCurrency(adminValue)}
              </p>
              <p className="text-xs text-muted-foreground">{contract.adminFeePercent}%</p>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                <p className="text-xs font-medium text-muted-foreground">Total Recebido</p>
              </div>
              <p className="text-xl font-bold text-emerald-600 mt-1">
                {formatCurrency(totalReceived)}
              </p>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                <p className="text-xs font-medium text-muted-foreground">Total em Atraso</p>
              </div>
              <p className="text-xl font-bold text-red-600 mt-1">
                {formatCurrency(totalOverdue)}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Content grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column - 2/3 */}
          <div className="lg:col-span-2 space-y-6">
            {/* Informações do Contrato */}
            <Card className="border-0 shadow-sm">
              <CardContent className="p-6">
                <SectionTitle icon={FileText} title="Informações do Contrato" />
                <div className="divide-y">
                  <InfoRow label="Código" value={contract.code} />
                  <InfoRow
                    label="Tipo"
                    value={
                      <Badge variant="secondary" className="text-xs">
                        {typeLabel}
                      </Badge>
                    }
                  />
                  <InfoRow
                    label="Status"
                    value={
                      <Badge variant="outline" className={cn("text-xs border", statusCfg.className)}>
                        {statusCfg.label}
                      </Badge>
                    }
                  />
                  <InfoRow label="Data Inicio" value={formatDate(contract.startDate)} />
                  <InfoRow label="Data Termino" value={formatDate(contract.endDate)} />
                  <InfoRow label="Dia Pagamento Locatário" value={`Dia ${contract.paymentDay}`} />
                  <InfoRow label="Dia Pagamento Proprietário" value={`Dia ${contract.owner?.paymentDay || 10}`} />
                  <InfoRow
                    label="Indice de Reajuste"
                    value={contract.adjustmentIndex || "Não definido"}
                  />
                  <InfoRow
                    label="Mes de Reajuste"
                    value={
                      contract.adjustmentMonth
                        ? monthLabels[contract.adjustmentMonth] || String(contract.adjustmentMonth)
                        : "Não definido"
                    }
                  />
                  <InfoRow
                    label="Taxa Intermediação"
                    value={
                      contract.intermediationFee != null
                        ? `${contract.intermediationFee}%`
                        : "-"
                    }
                  />
                  <InfoRow
                    label="Parcelas Intermediação"
                    value={contract.intermediationInstallments ?? "-"}
                  />
                  {(contract.lastAdjustmentPercent != null || contract.lastAdjustmentDate) && (
                    <InfoRow
                      label="Ultimo Reajuste"
                      value={
                        <span>
                          {contract.lastAdjustmentPercent != null
                            ? `${contract.lastAdjustmentPercent}%`
                            : "-"}
                          {contract.lastAdjustmentDate && (
                            <span className="text-muted-foreground ml-2">
                              em {formatDate(contract.lastAdjustmentDate)}
                            </span>
                          )}
                        </span>
                      }
                    />
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Valores */}
            <Card className="border-0 shadow-sm">
              <CardContent className="p-6">
                <SectionTitle icon={DollarSign} title="Valores" />
                <div className="divide-y">
                  <InfoRow label="Valor Aluguel" value={formatCurrency(contract.rentalValue)} />
                  <InfoRow label="Taxa Administrativa" value={`${contract.adminFeePercent}%`} />
                  <InfoRow label="Valor Administrativo" value={formatCurrency(adminValue)} />
                  <InfoRow label="Bruto ao Proprietário" value={formatCurrency(ownerNetValue)} />
                  {hasIrrf && latestPaymentWithIrrf ? (
                    <>
                      <InfoRow
                        label="IRRF Retido"
                        value={
                          <span className="text-amber-600 font-semibold">
                            {formatCurrency(latestPaymentWithIrrf.irrfValue!)}
                            <span className="text-xs font-normal text-muted-foreground ml-1">
                              ({((latestPaymentWithIrrf.irrfRate || 0) * 100).toFixed(1)}%)
                            </span>
                          </span>
                        }
                      />
                      <InfoRow
                        label="Líquido ao Proprietário"
                        value={
                          <span className="text-emerald-600 font-semibold">
                            {formatCurrency(latestPaymentWithIrrf.netToOwner ?? ownerNetValue)}
                          </span>
                        }
                      />
                    </>
                  ) : (
                    <InfoRow
                      label="Líquido ao Proprietário"
                      value={
                        <span className="text-emerald-600 font-semibold">
                          {formatCurrency(ownerNetValue)}
                          <span className="text-xs font-normal text-muted-foreground ml-1">
                            (isento IRRF)
                          </span>
                        </span>
                      }
                    />
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Pagamentos */}
            <Card className="border-0 shadow-sm">
              <CardContent className="p-0">
                <div className="p-6 pb-4">
                  <SectionTitle icon={DollarSign} title="Pagamentos" />

                  {/* Summary bar */}
                  <div className="flex items-center gap-4 text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      <span className="text-muted-foreground">
                        Pagos: <span className="font-medium text-foreground">{paidCount}</span>
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-yellow-500" />
                      <span className="text-muted-foreground">
                        Pendentes: <span className="font-medium text-foreground">{pendingCount}</span>
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-red-500" />
                      <span className="text-muted-foreground">
                        Atrasados: <span className="font-medium text-foreground">{overdueCount}</span>
                      </span>
                    </div>
                  </div>
                </div>

                {contract.payments.length === 0 ? (
                  <div className="flex items-center justify-center py-8 border-t">
                    <p className="text-sm text-muted-foreground">Nenhum pagamento registrado.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="text-xs">Código</TableHead>
                        <TableHead className="text-xs">Valor</TableHead>
                        <TableHead className="text-xs">Vencimento</TableHead>
                        <TableHead className="text-xs">Data Pgto.</TableHead>
                        <TableHead className="text-xs">Valor Pago</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs">Boleto</TableHead>
                        <TableHead className="text-xs">Metodo</TableHead>
                        <TableHead className="text-xs">Acoes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {contract.payments.map((payment) => {
                        const pStatus = paymentStatusConfig[payment.status] || {
                          label: payment.status,
                          className: "bg-muted text-muted-foreground",
                        };
                        return (
                          <TableRow key={payment.id}>
                            <TableCell className="text-xs font-medium">
                              {payment.code}
                            </TableCell>
                            <TableCell className="text-xs">
                              {formatCurrency(payment.value)}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {formatDate(payment.dueDate)}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {payment.paidAt ? formatDate(payment.paidAt) : "-"}
                            </TableCell>
                            <TableCell className="text-xs">
                              {payment.paidValue != null
                                ? formatCurrency(payment.paidValue)
                                : "-"}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={cn("text-xs border", pStatus.className)}
                              >
                                {pStatus.label}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs">
                              {payment.boletoStatus === "EMITIDO" ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs gap-1 text-primary hover:text-primary"
                                  onClick={async () => {
                                    try {
                                      const res = await fetch(`/api/payments/${payment.id}/boleto`);
                                      if (!res.ok) throw new Error("Erro ao baixar boleto");
                                      const blob = await res.blob();
                                      const url = URL.createObjectURL(blob);
                                      const a = document.createElement("a");
                                      a.href = url;
                                      a.download = `boleto-${payment.code}.pdf`;
                                      a.click();
                                      URL.revokeObjectURL(url);
                                    } catch {
                                      toast.error("Erro ao baixar PDF do boleto");
                                    }
                                  }}
                                >
                                  <Download className="h-3 w-3" />
                                  PDF
                                </Button>
                              ) : payment.nossoNumero ? (
                                <Badge variant="outline" className="text-xs">
                                  {payment.boletoStatus || "—"}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {payment.paymentMethod || "-"}
                            </TableCell>
                            <TableCell>
                              {(payment.status === "ATRASADO" || (payment.status === "PENDENTE" && new Date(payment.dueDate) < new Date())) && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 text-xs gap-1 text-amber-700 border-amber-300 hover:bg-amber-50"
                                  onClick={async () => {
                                    if (!confirm(`Garantir aluguel de ${formatCurrency(payment.netToOwner ?? payment.splitOwnerValue ?? payment.value)} ao proprietário?`)) return;
                                    try {
                                      const res = await fetch(`/api/payments/${payment.id}/guarantee`, { method: "POST" });
                                      const data = await res.json();
                                      if (!res.ok) throw new Error(data.error || "Erro");
                                      toast.success(data.message);
                                      fetchContract();
                                    } catch (err: any) {
                                      toast.error(err.message || "Erro ao garantir");
                                    }
                                  }}
                                >
                                  <Shield className="h-3 w-3" />
                                  Garantir
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right column - 1/3 */}
          <div className="space-y-6">
            {/* Partes */}
            <Card className="border-0 shadow-sm">
              <CardContent className="p-6">
                <SectionTitle icon={Users} title="Partes" />
                <div className="space-y-4">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Imóvel</p>
                    <Link
                      href={`/imoveis/${contract.propertyId}`}
                      className="flex items-center gap-2 text-sm font-medium text-primary hover:underline"
                    >
                      <Building2 className="h-3.5 w-3.5" />
                      {contract.property?.title || "N/A"}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Proprietário</p>
                    <Link
                      href={`/proprietarios/${contract.ownerId}`}
                      className="flex items-center gap-2 text-sm font-medium text-primary hover:underline"
                    >
                      <Users className="h-3.5 w-3.5" />
                      {contract.owner.name}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Locatário</p>
                    <Link
                      href={`/locatarios/${contract.tenantId}`}
                      className="flex items-center gap-2 text-sm font-medium text-primary hover:underline"
                    >
                      <UserCheck className="h-3.5 w-3.5" />
                      {contract.tenant?.name || "N/A"}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Códigos e Registros do Imóvel */}
            <Card className="border-0 shadow-sm">
              <CardContent className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <SectionTitle icon={FileText} title="Códigos e Registros" />
                  <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={openCodesDialog}>
                    <Pencil className="h-3 w-3" />
                    Editar
                  </Button>
                </div>
                {(contract.property?.registrationNumber || contract.property?.iptuNumber || contract.property?.energyMeter || contract.property?.waterMeter || contract.property?.gasMeter || contract.property?.condoAdmin) ? (
                  <div className="grid grid-cols-1 gap-3">
                    {contract.property.registrationNumber && (
                      <div>
                        <p className="text-xs text-muted-foreground">Matrícula</p>
                        <p className="text-sm font-medium">{contract.property.registrationNumber}</p>
                      </div>
                    )}
                    {contract.property.iptuNumber && (
                      <div>
                        <p className="text-xs text-muted-foreground">N° do IPTU</p>
                        <p className="text-sm font-medium">{contract.property.iptuNumber}</p>
                      </div>
                    )}
                    {contract.property.energyMeter && (
                      <div>
                        <p className="text-xs text-muted-foreground">Medidor Energia</p>
                        <p className="text-sm font-medium">{contract.property.energyMeter}</p>
                      </div>
                    )}
                    {contract.property.waterMeter && (
                      <div>
                        <p className="text-xs text-muted-foreground">Medidor Água</p>
                        <p className="text-sm font-medium">{contract.property.waterMeter}</p>
                      </div>
                    )}
                    {contract.property.gasMeter && (
                      <div>
                        <p className="text-xs text-muted-foreground">Medidor Gás</p>
                        <p className="text-sm font-medium">{contract.property.gasMeter}</p>
                      </div>
                    )}
                    {contract.property.condoAdmin && (
                      <div>
                        <p className="text-xs text-muted-foreground">Adm. Condomínio</p>
                        <p className="text-sm font-medium">{contract.property.condoAdmin}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Nenhum código cadastrado. Clique em Editar para adicionar.</p>
                )}
              </CardContent>
            </Card>

            {/* Garantia */}
            <Card className="border-0 shadow-sm">
              <CardContent className="p-6">
                <SectionTitle icon={Shield} title="Garantia" />
                <div className="divide-y">
                  <InfoRow
                    label="Tipo"
                    value={
                      contract.guaranteeType
                        ? guaranteeTypeLabels[contract.guaranteeType] || contract.guaranteeType
                        : "Não definido"
                    }
                  />
                  <InfoRow
                    label="Valor"
                    value={
                      contract.guaranteeValue != null
                        ? formatCurrency(contract.guaranteeValue)
                        : "-"
                    }
                  />
                  {contract.guaranteeInsurer && (
                    <InfoRow
                      label="Seguradora"
                      value={GUARANTEE_INSURER_LABELS[contract.guaranteeInsurer] || contract.guaranteeInsurer}
                    />
                  )}
                  {contract.guaranteeNotes && (
                    <div className="py-2.5">
                      <p className="text-sm text-muted-foreground mb-1">Observações</p>
                      <p className="text-sm">{contract.guaranteeNotes}</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Documentos Anexados (API) */}
            <Card className="border-0 shadow-sm">
              <CardContent className="p-6">
                <div className="flex items-center justify-between mb-2">
                  <SectionTitle icon={Paperclip} title="Documentos" />
                  <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors">
                    <Upload className="h-3.5 w-3.5" />
                    Anexar PDF
                    <input
                      type="file"
                      accept=".pdf"
                      multiple
                      className="hidden"
                      onChange={async (e) => {
                        const files = Array.from(e.target.files || []);
                        for (const file of files) {
                          const formData = new FormData();
                          formData.append("file", file);
                          formData.append("contractId", contractId);
                          formData.append("entityType", "CONTRACT");
                          formData.append("entityId", contractId);
                          await fetch("/api/upload", { method: "POST", body: formData });
                        }
                        e.target.value = "";
                        fetchContractDocs();
                        toast.success(`${files.length} documento(s) anexado(s)`);
                      }}
                    />
                  </label>
                </div>
                {docsLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : contractDocs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhum documento anexado.</p>
                ) : (
                  <div className="space-y-2">
                    {contractDocs.map((doc) => (
                      <div
                        key={doc.id}
                        className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{doc.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatDate(doc.createdAt)}
                              {doc.size != null && (
                                <span className="ml-2">
                                  {doc.size < 1024
                                    ? `${doc.size} B`
                                    : doc.size < 1048576
                                    ? `${(doc.size / 1024).toFixed(0)} KB`
                                    : `${(doc.size / 1048576).toFixed(1)} MB`}
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          <button
                            onClick={() => {
                              setPdfPreviewUrl(doc.url);
                              setPdfPreviewName(doc.name);
                            }}
                            className="flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Visualizar
                          </button>
                          <a
                            href={doc.url}
                            download={doc.name}
                            className="flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Baixar
                          </a>
                          <button
                            onClick={async () => {
                              if (!confirm("Excluir este documento?")) return;
                              await fetch(`/api/documents/${doc.id}`, { method: "DELETE" });
                              fetchContractDocs();
                              toast.success("Documento excluído");
                            }}
                            className="flex items-center gap-1 text-xs text-destructive hover:underline"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Documentos Relacionados (Vistorias, Procurações, etc.) */}
            {relatedDocs.length > 0 && (
              <Card className="border-0 shadow-sm">
                <CardContent className="p-6">
                  <SectionTitle icon={FileText} title="Documentos Vinculados" />
                  <div className="space-y-2">
                    {relatedDocs.map((doc) => (
                      <div key={doc.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
                        <div className="flex items-center gap-3">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-sm font-medium">{doc.code}</p>
                            <p className="text-xs text-muted-foreground">
                              {doc.type === "VISTORIA" ? "Vistoria" : doc.type === "PROCURACAO" ? "Procuração" : doc.type === "ADMINISTRACAO" ? "Administração" : doc.type === "ADITIVO" ? "Aditivo" : doc.type}
                              {doc.startDate ? ` - ${formatDate(doc.startDate)}` : ""}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {doc.documentUrl && (
                            <a href={doc.documentUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1">
                              <ExternalLink className="h-3 w-3" /> PDF
                            </a>
                          )}
                          <Link href={`/contratos/${doc.id}`} className="text-xs text-primary hover:underline">
                            Ver detalhes
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Observações */}
            {contract.notes && (
              <Card className="border-0 shadow-sm">
                <CardContent className="p-6">
                  <SectionTitle icon={Clock} title="Observações" />
                  <p className="text-sm text-muted-foreground">{contract.notes}</p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Billing Timeline - show for the most recent non-paid payment */}
        {contract.payments.length > 0 && (() => {
          const relevantPayment = contract.payments.find(
            (p: Payment) => p.status === "ATRASADO" || p.status === "PENDENTE"
          ) || contract.payments[0];
          return (
            <BillingTimeline
              dueDate={relevantPayment.dueDate}
              status={relevantPayment.status}
              paidAt={relevantPayment.paidAt}
              value={relevantPayment.value}
              fineValue={relevantPayment.fineValue}
              interestValue={relevantPayment.interestValue}
            />
          );
        })()}
      </div>

      {/* Contract Form Dialog */}
      <ContractForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contract={contract}
        onSuccess={handleFormSuccess}
      />

      {/* Reajuste Dialog */}
      <Dialog open={reajusteDialogOpen} onOpenChange={setReajusteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Aplicar Reajuste</DialogTitle>
            <DialogDescription>
              Valor atual do aluguel: {formatCurrency(contract.rentalValue)}.
              Informe o percentual de reajuste a ser aplicado.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="reajustePercent">Percentual (%)</Label>
              <Input
                id="reajustePercent"
                type="number"
                step="0.01"
                min="-50"
                max="100"
                placeholder="Ex: 5.5 (use 0 para manter, negativo para deflacao)"
                value={reajustePercent}
                onChange={(e) => setReajustePercent(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Aceita 0% (mantém aluguel) e percentuais negativos (deflação).
              </p>
            </div>
            {reajustePercent !== "" && !isNaN(parseFloat(reajustePercent)) && (
              <p className="text-sm text-muted-foreground">
                Novo valor:{" "}
                <span className="font-medium text-foreground">
                  {formatCurrency(
                    contract.rentalValue * (1 + parseFloat(reajustePercent) / 100)
                  )}
                </span>
                {parseFloat(reajustePercent) === 0 && (
                  <span className="text-emerald-700 ml-2">(mantido)</span>
                )}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setReajusteDialogOpen(false);
                setReajustePercent("");
              }}
            >
              Cancelar
            </Button>
            <Button onClick={handleApplyReajuste} disabled={reajusteLoading}>
              {reajusteLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Aplicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Renewal Dialog */}
      <Dialog open={renewDialogOpen} onOpenChange={setRenewDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Renovar Contrato</DialogTitle>
            <DialogDescription>
              O contrato atual ({contract.code}) sera encerrado e um novo contrato sera criado
              com inicio em {formatDate(new Date(new Date(contract.endDate).getTime() + 86400000).toISOString())}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="renewEndDate">Nova Data de Termino</Label>
              <Input
                id="renewEndDate"
                type="date"
                value={renewEndDate}
                onChange={(e) => setRenewEndDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Se nao informado, sera calculado com base no periodo padrao de renovacao (12 meses).
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="renewRentalValue">Novo Valor do Aluguel (opcional)</Label>
              <Input
                id="renewRentalValue"
                type="number"
                step="0.01"
                placeholder={`Atual: ${formatCurrency(contract.rentalValue)}`}
                value={renewRentalValue}
                onChange={(e) => setRenewRentalValue(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Deixe vazio para manter o valor atual.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRenewDialogOpen(false);
                setRenewEndDate("");
                setRenewRentalValue("");
              }}
            >
              Cancelar
            </Button>
            <Button onClick={handleRenewContract} disabled={renewLoading}>
              {renewLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Renovar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rescindir Dialog */}
      <Dialog open={terminateDialogOpen} onOpenChange={setTerminateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rescindir Contrato</DialogTitle>
            <DialogDescription>
              O contrato <strong>{contract.code}</strong> será marcado como{" "}
              <strong>RESCINDIDO</strong>. Não serão geradas mais cobranças/boletos,
              mas todos os dados permanecem no sistema para relatórios fiscais (DIMOB).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="terminateDate">Data da Rescisão</Label>
              <Input
                id="terminateDate"
                type="date"
                value={terminateDate}
                onChange={(e) => setTerminateDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Se não informado, usa a data de hoje.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="terminateReason">Motivo (opcional)</Label>
              <Input
                id="terminateReason"
                placeholder="Ex: Inquilino desocupou imóvel em 15/04"
                maxLength={500}
                value={terminateReason}
                onChange={(e) => setTerminateReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setTerminateDialogOpen(false);
                setTerminateDate("");
                setTerminateReason("");
              }}
            >
              Cancelar
            </Button>
            <Button
              onClick={handleTerminateContract}
              disabled={terminateLoading}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {terminateLoading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Confirmar Rescisão
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir Contrato</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir o contrato{" "}
              <strong>{contract.code}</strong>? Esta acao nao pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deleting}
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* PDF Preview Dialog */}
      <Dialog open={!!pdfPreviewUrl} onOpenChange={(open) => { if (!open) setPdfPreviewUrl(null); }}>
        <DialogContent className="sm:max-w-4xl sm:max-h-[90vh] p-0">
          <DialogHeader className="p-4 pb-0">
            <DialogTitle className="text-sm truncate">{pdfPreviewName}</DialogTitle>
          </DialogHeader>
          {pdfPreviewUrl && (
            <iframe
              src={pdfPreviewUrl}
              className="w-full border-0 rounded-b-lg"
              style={{ height: "80vh" }}
              title={pdfPreviewName}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Dialog Códigos e Registros */}
      <Dialog open={codesDialogOpen} onOpenChange={setCodesDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Códigos e Registros do Imóvel</DialogTitle>
            <DialogDescription>Preencha os códigos de referência do imóvel.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="registrationNumber">Matrícula</Label>
              <Input id="registrationNumber" value={codesForm.registrationNumber} onChange={(e) => setCodesForm(f => ({ ...f, registrationNumber: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="iptuNumber">N° do IPTU</Label>
              <Input id="iptuNumber" value={codesForm.iptuNumber} onChange={(e) => setCodesForm(f => ({ ...f, iptuNumber: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="energyMeter">Medidor Energia</Label>
              <Input id="energyMeter" value={codesForm.energyMeter} onChange={(e) => setCodesForm(f => ({ ...f, energyMeter: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="waterMeter">Medidor Água</Label>
              <Input id="waterMeter" value={codesForm.waterMeter} onChange={(e) => setCodesForm(f => ({ ...f, waterMeter: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="gasMeter">Medidor Gás</Label>
              <Input id="gasMeter" value={codesForm.gasMeter} onChange={(e) => setCodesForm(f => ({ ...f, gasMeter: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="condoAdmin">Adm. Condomínio</Label>
              <Input id="condoAdmin" value={codesForm.condoAdmin} onChange={(e) => setCodesForm(f => ({ ...f, condoAdmin: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodesDialogOpen(false)}>Cancelar</Button>
            <Button onClick={saveCodes} disabled={codesSaving}>
              {codesSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
