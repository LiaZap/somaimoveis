"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  ExternalLink,
  Building2,
  User,
  FileText,
  DollarSign,
  Calendar,
  Receipt,
  ArrowRight,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface PaymentLite {
  id: string;
  code: string;
  value: number;
  paidValue: number | null;
  dueDate: string;
  paidAt: string | null;
  status: string;
  description: string | null;
  notes: string | null;
  nossoNumero?: string;
  linhaDigitavel?: string;
  // Juros/multa
  fineValue?: number | null;
  interestValue?: number | null;
  fineRetidaImobiliaria?: boolean | null;
  interestRetidaImobiliaria?: boolean | null;
  multaTipoBoleto?: string | null;
  multaValorBoleto?: number | null;
  jurosTipoBoleto?: string | null;
  jurosValorBoleto?: number | null;
  contractId: string;
  contract?: {
    id: string;
    code: string;
    rentalValue: number;
    property?: { id: string; title: string } | null;
  } | null;
  tenant?: { id: string; name: string } | null;
  owner?: { id: string; name: string } | null;
}

interface ContractPayment {
  id: string;
  code: string;
  value: number;
  paidValue: number | null;
  dueDate: string;
  paidAt: string | null;
  status: string;
  description: string | null;
}

function formatCurrency(v: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}

function formatDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

const statusConfig: Record<string, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  PAGO: { label: "Pago", className: "bg-emerald-100 text-emerald-700 border-emerald-200", Icon: CheckCircle2 },
  PENDENTE: { label: "Pendente", className: "bg-amber-100 text-amber-700 border-amber-200", Icon: Clock },
  ATRASADO: { label: "Atrasado", className: "bg-red-100 text-red-700 border-red-200", Icon: AlertTriangle },
  PARCIAL: { label: "Parcial", className: "bg-blue-100 text-blue-700 border-blue-200", Icon: Clock },
  CANCELADO: { label: "Cancelado", className: "bg-muted text-muted-foreground", Icon: AlertTriangle },
};

interface Breakdown {
  aluguel?: number;
  condominio?: number;
  iptu?: number;
  seguroFianca?: number;
  taxaBancaria?: number;
  intermediacao?: number;
  intermediacaoSaldoNovo?: number;
  intermediacaoSaldoAnterior?: number;
  creditos?: number;
  debitos?: number;
  total?: number;
  lancamentos?: { tipo: string; categoria: string; descricao: string; valor: number }[];
}

function parseBreakdown(notes: string | null): Breakdown | null {
  if (!notes) return null;
  try {
    const parsed = JSON.parse(notes);
    if (typeof parsed.aluguel === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Calcula estimativa juros/multa pra boletos atrasados nao pagos.
 * Usa snapshot do boleto se disponivel, senao fallback de mercado
 * (multa 2% + juros 1%/mes).
 */
interface BillingRules {
  multaTipo: string;
  multaValor: number;
  multaAposVenc: boolean;
  jurosTipo: string;
  jurosValor: number;
}

function estimatePaymentFineInterest(
  payment: PaymentLite,
  globalSettings: BillingRules | null,
): {
  fine: number;
  interest: number;
  total: number;
  daysLate: number;
  multaTipo: string;
  multaValor: number;
  jurosTipo: string;
  jurosValor: number;
  source: "BOLETO" | "GLOBAL";
} | null {
  if (payment.paidAt) return null;
  const due = new Date(payment.dueDate);
  const today = new Date();
  const daysLate = Math.max(
    0,
    Math.floor((today.getTime() - due.getTime()) / 86400000),
  );
  if (daysLate <= 0) return null;

  const hasSnapshot =
    payment.multaTipoBoleto != null ||
    payment.multaValorBoleto != null ||
    payment.jurosTipoBoleto != null ||
    payment.jurosValorBoleto != null;

  let multaTipo: string;
  let multaValor: number;
  let jurosTipo: string;
  let jurosValor: number;
  let source: "BOLETO" | "GLOBAL";

  if (hasSnapshot) {
    multaTipo = payment.multaTipoBoleto || "PERCENTUAL";
    multaValor = payment.multaValorBoleto ?? 0;
    jurosTipo = payment.jurosTipoBoleto || "ISENTO";
    jurosValor = payment.jurosValorBoleto ?? 0;
    source = "BOLETO";
  } else if (globalSettings) {
    // Usa config global (BillingSettings — bate com a tabela do /financeiro)
    multaTipo = globalSettings.multaTipo;
    multaValor = globalSettings.multaAposVenc ? globalSettings.multaValor : 0;
    jurosTipo = globalSettings.jurosTipo;
    jurosValor = globalSettings.jurosValor;
    source = "GLOBAL";
  } else {
    // Fallback hardcoded (caso billingSettings nao tenha carregado)
    multaTipo = "PERCENTUAL";
    multaValor = 2;
    jurosTipo = "PERCENTUAL_MES";
    jurosValor = 1;
    source = "GLOBAL";
  }

  const valor = payment.value;
  let fine = 0;
  if (multaValor > 0) {
    fine = multaTipo === "PERCENTUAL" ? (valor * multaValor) / 100 : multaValor;
  }
  let interest = 0;
  if (jurosTipo === "PERCENTUAL_MES") {
    interest = ((valor * jurosValor) / 100 / 30) * daysLate;
  } else if (jurosTipo === "PERCENTUAL_DIA") {
    interest = ((valor * jurosValor) / 100) * daysLate;
  } else if (jurosTipo === "VALOR_DIA") {
    interest = jurosValor * daysLate;
  }

  fine = Math.round(fine * 100) / 100;
  interest = Math.round(interest * 100) / 100;
  const total = Math.round((fine + interest) * 100) / 100;
  if (total <= 0) return null;
  return {
    fine,
    interest,
    total,
    daysLate,
    multaTipo,
    multaValor,
    jurosTipo,
    jurosValor,
    source: hasSnapshot ? "BOLETO" : "GLOBAL",
  };
}

/**
 * Secao de juros/multa no modal de detalhe.
 *  - Boleto JA PAGO com encargos: mostra valores reais e destino (imob/owner)
 *  - Boleto ATRASADO nao pago: mostra estimativa "se pagar hoje"
 *  - Sem encargos: nao renderiza nada
 */
function FineInterestSection({
  payment,
  globalSettings,
}: {
  payment: PaymentLite;
  globalSettings: BillingRules | null;
}) {
  const realFine = payment.fineValue ?? 0;
  const realInterest = payment.interestValue ?? 0;
  const hasReal = realFine > 0 || realInterest > 0;
  const estimate = !hasReal
    ? estimatePaymentFineInterest(payment, globalSettings)
    : null;

  if (!hasReal && !estimate) return null;

  if (hasReal) {
    const total = realFine + realInterest;
    const fineRetida = payment.fineRetidaImobiliaria === true;
    const interestRetida = payment.interestRetidaImobiliaria === true;
    const todosRetidos =
      (realFine === 0 || fineRetida) && (realInterest === 0 || interestRetida);
    const todosRepassados =
      (realFine === 0 || !fineRetida) && (realInterest === 0 || !interestRetida);
    const destinoLabel = todosRetidos
      ? "Retido pela imobiliária"
      : todosRepassados
      ? "Repassado ao proprietário"
      : "Destino misto";
    const destinoColor = todosRetidos
      ? "text-emerald-700"
      : todosRepassados
      ? "text-blue-700"
      : "text-amber-700";

    return (
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Juros e Multa (cobrados)
        </h3>
        <div className="rounded-lg border bg-emerald-50/30 divide-y text-sm">
          {realFine > 0 && (
            <Row label="Multa" value={formatCurrency(realFine)} />
          )}
          {realInterest > 0 && (
            <Row label="Juros" value={formatCurrency(realInterest)} />
          )}
          <Row
            label="Total juros/multa"
            value={formatCurrency(total)}
            className="font-bold bg-muted/30"
          />
        </div>
        <div className={`mt-2 text-xs ${destinoColor} flex items-center gap-1`}>
          📌 <strong>Destino:</strong> {destinoLabel}
        </div>
      </div>
    );
  }

  // Estimativa
  if (!estimate) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1">
        Juros e Multa (estimado se pagar hoje)
        <Badge variant="outline" className="text-[9px] bg-orange-50 text-orange-700 border-orange-200 ml-1">
          {estimate.daysLate} dia{estimate.daysLate > 1 ? "s" : ""} atraso
        </Badge>
      </h3>
      <div className="rounded-lg border bg-orange-50/30 divide-y text-sm">
        {estimate.fine > 0 && (
          <Row label="Multa estimada" value={formatCurrency(estimate.fine)} />
        )}
        {estimate.interest > 0 && (
          <Row label="Juros estimado" value={formatCurrency(estimate.interest)} />
        )}
        <Row
          label="Total estimado"
          value={formatCurrency(estimate.total)}
          className="font-bold bg-muted/30 text-orange-700"
        />
        <Row
          label="Total devido (com encargos)"
          value={formatCurrency(payment.value + estimate.total)}
          className="text-xs text-muted-foreground"
        />
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
        Regras: multa{" "}
        {estimate.multaTipo === "PERCENTUAL"
          ? `${estimate.multaValor}%`
          : formatCurrency(estimate.multaValor)}
        ; juros{" "}
        {estimate.jurosTipo === "PERCENTUAL_MES"
          ? `${estimate.jurosValor}%/mês`
          : estimate.jurosTipo === "PERCENTUAL_DIA"
          ? `${estimate.jurosValor}%/dia`
          : estimate.jurosTipo === "VALOR_DIA"
          ? `${formatCurrency(estimate.jurosValor)}/dia`
          : "isento"}
        .{" "}
        {estimate.source === "BOLETO"
          ? "✓ Mesmas regras enviadas ao Sicredi."
          : "(Pode haver pequena diferença com o valor real do Sicredi.)"}
      </div>
    </div>
  );
}

interface Props {
  paymentId: string | null;
  payments: PaymentLite[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMarkPaid?: (id: string) => void;
}

/**
 * Botao "Regerar Boleto com config atual" — cancela o boleto antigo
 * no Sicredi e re-emite com as regras atuais de juros/multa do
 * BillingSettings. Util pra atualizar boletos JA EMITIDOS sem ter
 * que cancelar manualmente e re-emitir manualmente.
 */
function RegerarBoletoButton({ paymentId, paymentCode }: { paymentId: string; paymentCode: string }) {
  const [loading, setLoading] = useState(false);

  async function handleRegerar() {
    if (!confirm(
      `Regerar o boleto ${paymentCode} com a config atual de juros/multa?\n\n` +
      `Isso vai:\n` +
      `1. Cancelar o boleto atual no Sicredi (link/PIX antigo deixa de funcionar)\n` +
      `2. Emitir novo boleto com as regras atuais (multa/juros)\n\n` +
      `Avise o cliente antes — link antigo vai parar de funcionar.`
    )) return;

    setLoading(true);
    try {
      const res = await fetch(`/api/payments/${paymentId}/regerar`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok || res.status === 207) {
        if (data.warning) {
          alert(`⚠ ${data.warning}\n\n${data.message || ""}`);
        } else {
          alert(`✓ Boleto regerado com sucesso.\nNovo Nº: ${data.newNossoNumero || "—"}`);
        }
        // Recarrega a tela pra atualizar dados
        window.location.reload();
      } else {
        alert(`Erro: ${data.error || `HTTP ${res.status}`}`);
      }
    } catch (err: any) {
      alert(`Erro ao regerar: ${err?.message || err}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="mt-2 w-full text-xs gap-1.5 border-orange-300 text-orange-700 hover:bg-orange-50"
      onClick={handleRegerar}
      disabled={loading}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Receipt className="h-3.5 w-3.5" />
      )}
      {loading ? "Regerando..." : "Regerar boleto com config atual de juros/multa"}
    </Button>
  );
}

export function PaymentDetailSheet({ paymentId, payments, open, onOpenChange, onMarkPaid }: Props) {
  const [contractPayments, setContractPayments] = useState<ContractPayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [billingSettings, setBillingSettings] = useState<BillingRules | null>(null);

  const payment = payments.find((p) => p.id === paymentId) || null;

  // Buscar todos os pagamentos do mesmo contrato
  useEffect(() => {
    if (!payment?.contractId || !open) {
      setContractPayments([]);
      return;
    }
    setLoading(true);
    fetch(`/api/payments?contractId=${payment.contractId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        const list = Array.isArray(data) ? data : data.data || [];
        setContractPayments(list);
      })
      .catch(() => setContractPayments([]))
      .finally(() => setLoading(false));
  }, [payment?.contractId, open]);

  // Buscar regras de juros/multa global pra estimativa bater com a tabela
  useEffect(() => {
    if (!open) return;
    fetch("/api/billing-settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s && !s.error) {
          setBillingSettings({
            multaTipo: s.multaTipo || "PERCENTUAL",
            multaValor: s.multaValor ?? 2,
            multaAposVenc: s.multaAposVenc ?? true,
            jurosTipo: s.jurosTipo || "PERCENTUAL_MES",
            jurosValor: s.jurosValor ?? 1,
          });
        }
      })
      .catch(() => { /* tolerante: cai no fallback hardcoded */ });
  }, [open]);

  if (!payment) return null;

  const status = statusConfig[payment.status] || statusConfig.PENDENTE;
  const breakdown = parseBreakdown(payment.notes);

  // Stats do contrato
  const stats = {
    pagos: contractPayments.filter((p) => p.status === "PAGO").length,
    pendentes: contractPayments.filter((p) => p.status === "PENDENTE").length,
    atrasados: contractPayments.filter((p) => p.status === "ATRASADO").length,
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-[560px] overflow-y-auto">
        <SheetHeader className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <SheetTitle className="flex items-center gap-2">
                <Receipt className="h-4 w-4 text-muted-foreground" />
                {payment.code}
              </SheetTitle>
              <SheetDescription className="text-xs">
                {payment.contract?.code && (
                  <Link
                    href={`/contratos/${payment.contractId}`}
                    className="inline-flex items-center gap-1 hover:text-primary"
                    onClick={() => onOpenChange(false)}
                  >
                    Contrato {payment.contract.code} <ExternalLink className="h-3 w-3" />
                  </Link>
                )}
              </SheetDescription>
            </div>
            <Badge variant="outline" className={cn("text-xs", status.className)}>
              <status.Icon className="h-3 w-3 mr-1" />
              {status.label}
            </Badge>
          </div>
        </SheetHeader>

        <div className="px-4 space-y-6 mt-2 mb-6">
          {/* Valor principal */}
          <div className="rounded-lg bg-muted/50 p-4 space-y-1">
            <p className="text-xs text-muted-foreground">Valor</p>
            <p className="text-2xl font-bold">{formatCurrency(payment.value)}</p>
            {payment.paidValue != null && payment.paidValue !== payment.value && (
              <p className="text-xs text-muted-foreground">
                Pago: <span className="font-medium text-foreground">{formatCurrency(payment.paidValue)}</span>
              </p>
            )}
          </div>

          {/* Datas */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Calendar className="h-3 w-3" /> Vencimento
              </p>
              <p className="font-medium">{formatDate(payment.dueDate)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Pagamento
              </p>
              <p className="font-medium">{payment.paidAt ? formatDate(payment.paidAt) : "—"}</p>
            </div>
          </div>

          {/* Composicao */}
          {breakdown && (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Composição do valor
              </h3>
              <div className="rounded-lg border divide-y text-sm">
                {breakdown.aluguel != null && breakdown.aluguel > 0 && (
                  <Row label="Aluguel" value={formatCurrency(breakdown.aluguel)} />
                )}
                {(breakdown.taxaBancaria || 0) > 0 && (
                  <Row label="+ Taxa Bancária" value={formatCurrency(breakdown.taxaBancaria!)} />
                )}
                {(breakdown.condominio || 0) > 0 && (
                  <Row label="+ Condomínio" value={formatCurrency(breakdown.condominio!)} />
                )}
                {(breakdown.iptu || 0) > 0 && (
                  <Row label="+ IPTU" value={formatCurrency(breakdown.iptu!)} />
                )}
                {(breakdown.seguroFianca || 0) > 0 && (
                  <Row label="+ Seguro Fiança" value={formatCurrency(breakdown.seguroFianca!)} />
                )}
                {(breakdown.intermediacao || 0) > 0 && (
                  <Row
                    label={`+ Intermediação${breakdown.intermediacaoSaldoAnterior ? " (com saldo anterior)" : ""}`}
                    value={formatCurrency(breakdown.intermediacao!)}
                  />
                )}
                {(breakdown.intermediacaoSaldoNovo || 0) > 0 && (
                  <Row
                    label="↳ Saldo p/ próximo mês"
                    value={formatCurrency(breakdown.intermediacaoSaldoNovo!)}
                    className="text-amber-700 italic"
                  />
                )}
                {(breakdown.debitos || 0) > 0 && (
                  <Row label="+ Débitos extras" value={formatCurrency(breakdown.debitos!)} />
                )}
                {(breakdown.creditos || 0) > 0 && (
                  <Row label="− Créditos/Descontos" value={`-${formatCurrency(breakdown.creditos!)}`} className="text-red-600" />
                )}
                <Row
                  label="Total"
                  value={formatCurrency(breakdown.total ?? payment.value)}
                  className="font-bold bg-muted/30"
                />
              </div>

              {/* Lançamentos detalhados */}
              {breakdown.lancamentos && breakdown.lancamentos.length > 0 && (
                <details className="mt-3">
                  <summary className="text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground">
                    Ver {breakdown.lancamentos.length} lançamento(s) detalhado(s)
                  </summary>
                  <div className="mt-2 space-y-1.5 text-xs">
                    {breakdown.lancamentos.map((l, i) => (
                      <div
                        key={i}
                        className={cn(
                          "flex justify-between items-start py-1.5 px-2 rounded",
                          l.tipo === "CREDITO" ? "bg-red-50" : "bg-emerald-50"
                        )}
                      >
                        <div>
                          <p className="font-medium">{l.descricao}</p>
                          <p className="text-muted-foreground text-[10px]">{l.categoria}</p>
                        </div>
                        <p className={l.tipo === "CREDITO" ? "text-red-700" : "text-emerald-700"}>
                          {l.tipo === "CREDITO" ? "−" : "+"}
                          {formatCurrency(l.valor)}
                        </p>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* Juros/Multa — REAL (boleto pago) ou ESTIMADO (atrasado nao pago) */}
          <FineInterestSection payment={payment} globalSettings={billingSettings} />

          {/* Partes envolvidas */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Partes
            </h3>
            <div className="space-y-2 text-sm">
              {payment.tenant && (
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Locatário</p>
                    <Link
                      href={`/locatarios/${payment.tenant.id}`}
                      className="font-medium hover:text-primary"
                      onClick={() => onOpenChange(false)}
                    >
                      {payment.tenant.name}
                    </Link>
                  </div>
                </div>
              )}
              {payment.contract?.property && (
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Imóvel</p>
                    <Link
                      href={`/imoveis/${payment.contract.property.id}`}
                      className="font-medium hover:text-primary"
                      onClick={() => onOpenChange(false)}
                    >
                      {payment.contract.property.title}
                    </Link>
                  </div>
                </div>
              )}
              {payment.owner && (
                <div className="flex items-center gap-2">
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-xs text-muted-foreground">Proprietário</p>
                    <Link
                      href={`/proprietarios/${payment.owner.id}`}
                      className="font-medium hover:text-primary"
                      onClick={() => onOpenChange(false)}
                    >
                      {payment.owner.name}
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Boleto */}
          {payment.nossoNumero && (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Boleto
              </h3>
              <div className="rounded-lg border p-3 space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Nº Nosso Número</span>
                  <span className="font-mono font-medium">{payment.nossoNumero}</span>
                </div>
                {payment.linhaDigitavel && (
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground shrink-0">Linha Digitável</span>
                    <span className="font-mono font-medium text-right break-all">
                      {payment.linhaDigitavel}
                    </span>
                  </div>
                )}
              </div>
              {/* Botao "Regerar com config atual" — para boletos atrasados/pendentes
                  cuja regra de juros/multa pode estar desatualizada no Sicredi */}
              {payment.status !== "PAGO" && payment.status !== "CANCELADO" && (
                <RegerarBoletoButton paymentId={payment.id} paymentCode={payment.code} />
              )}
            </div>
          )}

          <Separator />

          {/* Histórico de pagamentos do contrato */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Histórico do contrato
            </h3>
            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : contractPayments.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhum outro pagamento do contrato.</p>
            ) : (
              <>
                <div className="flex items-center gap-3 text-xs mb-2">
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    {stats.pagos} pago(s)
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-amber-500" />
                    {stats.pendentes} pendente(s)
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-red-500" />
                    {stats.atrasados} atrasado(s)
                  </span>
                </div>
                <div className="rounded-lg border divide-y max-h-64 overflow-y-auto">
                  {contractPayments
                    .sort((a, b) => new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime())
                    .map((p) => {
                      const s = statusConfig[p.status] || statusConfig.PENDENTE;
                      const isCurrent = p.id === paymentId;
                      return (
                        <div
                          key={p.id}
                          className={cn(
                            "flex items-center justify-between p-2.5 text-xs hover:bg-muted/30",
                            isCurrent && "bg-primary/5"
                          )}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <s.Icon
                              className={cn(
                                "h-3.5 w-3.5 shrink-0",
                                p.status === "PAGO" && "text-emerald-600",
                                p.status === "PENDENTE" && "text-amber-600",
                                p.status === "ATRASADO" && "text-red-600"
                              )}
                            />
                            <div className="min-w-0">
                              <p className="font-medium truncate">{p.code}</p>
                              <p className="text-muted-foreground text-[10px]">
                                Venc. {formatDate(p.dueDate)}
                                {p.paidAt && ` • Pago ${formatDate(p.paidAt)}`}
                              </p>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-medium">{formatCurrency(p.value)}</p>
                            <p className="text-muted-foreground text-[10px]">{s.label}</p>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </>
            )}
          </div>

          {/* Acoes rapidas */}
          {payment.status === "PENDENTE" && onMarkPaid && (
            <Button
              className="w-full gap-2"
              onClick={() => {
                onMarkPaid(payment.id);
                onOpenChange(false);
              }}
            >
              <CheckCircle2 className="h-4 w-4" />
              Marcar como Pago
            </Button>
          )}

          <Button
            variant="outline"
            className="w-full gap-2"
            asChild
          >
            <Link href={`/contratos/${payment.contractId}`} onClick={() => onOpenChange(false)}>
              <FileText className="h-4 w-4" />
              Abrir Contrato
              <ArrowRight className="h-3 w-3 ml-auto" />
            </Link>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Row({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn("flex justify-between items-center px-3 py-2", className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
