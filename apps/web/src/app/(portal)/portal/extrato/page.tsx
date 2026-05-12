"use client";

import { useEffect, useState, useCallback } from "react";
import { usePortal } from "@/components/portal/portal-provider";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Receipt,
  Calendar,
  TrendingUp,
  ChevronDown,
  ChevronUp,
  Printer,
  CheckCircle2,
  Clock,
  AlertTriangle,
} from "lucide-react";

interface EntryDetail {
  category: string;
  description: string;
  value: number;
  status: string;
  type: "CREDITO" | "DEBITO";
}

interface PaymentBreakdown {
  aluguelBruto: number;
  adminFee: number;
  adminFeePercent: number;
  iptu: number;
  condominio: number;
  intermediacao: number;
  irrf: number;
  outrosDebitos: number;
  outrosCreditos: number;
  repasseLiquido: number;
  entries: EntryDetail[];
}

interface MonthPayment {
  id: string;
  code: string;
  dueDate: string;
  paidAt: string | null;
  status: string;
  value: number;
  paidValue: number | null;
  splitOwnerValue: number | null;
  splitAdminValue: number | null;
  description: string | null;
  property: string;
  tenant: string;
  breakdown?: PaymentBreakdown;
}

interface MonthGroup {
  month: number;
  year: number;
  label: string;
  payments: MonthPayment[];
  totals: {
    totalValue: number;
    totalPaid: number;
    totalOwner: number;
    totalAdmin: number;
    totalIptu?: number;
    totalCondominio?: number;
    totalIntermediacao?: number;
    totalOutrosDebitos?: number;
  };
}

interface StatementData {
  months: MonthGroup[];
  grandTotals: {
    totalValue: number;
    totalPaid: number;
    totalOwner: number;
    totalAdmin: number;
  };
  ownerName: string;
}

const statusConfig: Record<
  string,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  PAGO: {
    label: "Pago",
    className: "bg-emerald-100 text-emerald-700 border-emerald-200",
    icon: CheckCircle2,
  },
  PENDENTE: {
    label: "Pendente",
    className: "bg-yellow-100 text-yellow-700 border-yellow-200",
    icon: Clock,
  },
  ATRASADO: {
    label: "Atrasado",
    className: "bg-red-100 text-red-700 border-red-200",
    icon: AlertTriangle,
  },
};

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default function PortalStatementPage() {
  const { fetchPortal } = usePortal();
  const [data, setData] = useState<StatementData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<string>(
    String(currentYear)
  );

  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);

  const loadStatement = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchPortal(
        `/api/portal/statement?year=${selectedYear}`
      );
      if (response.ok) {
        const result = await response.json();
        setData(result);
      }
    } catch (error) {
      console.error("Erro ao carregar extrato:", error);
    } finally {
      setLoading(false);
    }
  }, [fetchPortal, selectedYear]);

  useEffect(() => {
    loadStatement();
  }, [loadStatement]);

  const toggleMonth = (key: string) => {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const expandAll = () => {
    if (!data) return;
    const allKeys = data.months.map((m) => `${m.year}-${m.month}`);
    setExpandedMonths(new Set(allKeys));
  };

  const collapseAll = () => {
    setExpandedMonths(new Set());
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Extrato Financeiro
          </h1>
          <p className="text-muted-foreground">
            {data?.ownerName
              ? `Extrato de ${data.ownerName} - ${selectedYear}`
              : `Extrato financeiro de ${selectedYear}`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Select value={selectedYear} onValueChange={setSelectedYear}>
            <SelectTrigger size="sm" className="w-[100px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {yearOptions.map((year) => (
                <SelectItem key={year} value={String(year)}>
                  {year}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            className="text-xs gap-1.5"
            onClick={expandedMonths.size > 0 ? collapseAll : expandAll}
          >
            {expandedMonths.size > 0 ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" />
                Recolher
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" />
                Expandir
              </>
            )}
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="text-xs gap-1.5 print:hidden"
            onClick={handlePrint}
          >
            <Printer className="h-3.5 w-3.5" />
            Imprimir
          </Button>
        </div>
      </div>

      {/* Monthly Breakdown */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">
              Carregando extrato...
            </p>
          </div>
        </div>
      ) : !data || data.months.length === 0 ? (
        <Card className="border-0 shadow-sm">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Receipt className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <p className="text-muted-foreground">
              Nenhum dado encontrado para {selectedYear}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Month Cards */}
          <div className="space-y-4">
            {data.months.map((month) => {
              const key = `${month.year}-${month.month}`;
              const isExpanded = expandedMonths.has(key);

              return (
                <Card key={key} className="border-0 shadow-sm overflow-hidden">
                  {/* Month Header - Clickable */}
                  <button
                    className="w-full p-4 flex items-center justify-between hover:bg-muted/30 transition-colors text-left"
                    onClick={() => toggleMonth(key)}
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                        <Calendar className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-sm">
                          {month.label}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          {month.payments.length} pagamento(s)
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-6">
                      {/* Quick Stats */}
                      <div className="hidden sm:flex items-center gap-4 text-right">
                        <div>
                          <p className="text-[10px] text-muted-foreground uppercase">
                            Total
                          </p>
                          <p className="text-sm font-semibold">
                            {formatCurrency(month.totals.totalValue)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] text-muted-foreground uppercase">
                            Sua Parte
                          </p>
                          <p className="text-sm font-semibold text-emerald-700">
                            {formatCurrency(month.totals.totalOwner)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] text-muted-foreground uppercase">
                            Taxa Admin.
                          </p>
                          <p className="text-sm font-medium text-muted-foreground">
                            {formatCurrency(month.totals.totalAdmin)}
                          </p>
                        </div>
                      </div>

                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  </button>

                  {/* Mobile Stats (visible when collapsed on small screens) */}
                  <div className="sm:hidden px-4 pb-3 flex items-center gap-4">
                    <div>
                      <p className="text-[10px] text-muted-foreground">Total</p>
                      <p className="text-xs font-semibold">
                        {formatCurrency(month.totals.totalValue)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground">Sua Parte</p>
                      <p className="text-xs font-semibold text-emerald-700">
                        {formatCurrency(month.totals.totalOwner)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground">Taxa</p>
                      <p className="text-xs font-medium text-muted-foreground">
                        {formatCurrency(month.totals.totalAdmin)}
                      </p>
                    </div>
                  </div>

                  {/* Expanded Payment Details */}
                  {isExpanded && (
                    <div className="border-t bg-muted/10 p-4 space-y-4">
                      {month.payments.map((payment) => {
                        const status = statusConfig[payment.status] || {
                          label: payment.status,
                          className: "bg-muted text-muted-foreground",
                          icon: Clock,
                        };
                        const StatusIcon = status.icon;
                        const bd = payment.breakdown;

                        return (
                          <Card key={payment.id} className="border shadow-none">
                            <CardContent className="p-4 space-y-3">
                              {/* Cabecalho do pagamento */}
                              <div className="flex flex-wrap items-start justify-between gap-2 pb-2 border-b">
                                <div className="space-y-0.5">
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono text-xs font-semibold text-primary">{payment.code}</span>
                                    <Badge
                                      variant="outline"
                                      className={`text-[10px] border gap-1 ${status.className}`}
                                    >
                                      <StatusIcon className="h-3 w-3" />
                                      {status.label}
                                    </Badge>
                                  </div>
                                  <p className="text-sm font-medium">{payment.property}</p>
                                  <p className="text-xs text-muted-foreground">Locatário: {payment.tenant}</p>
                                </div>
                                <div className="text-right space-y-0.5">
                                  <p className="text-[10px] text-muted-foreground uppercase">Vencimento</p>
                                  <p className="text-xs font-medium">{formatDate(payment.dueDate)}</p>
                                  {payment.paidAt && (
                                    <>
                                      <p className="text-[10px] text-muted-foreground uppercase mt-1">Pago em</p>
                                      <p className="text-xs font-medium text-emerald-700">{formatDate(payment.paidAt)}</p>
                                    </>
                                  )}
                                </div>
                              </div>

                              {/* Breakdown detalhado */}
                              {bd ? (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                                  {/* Coluna esquerda — Créditos */}
                                  <div className="space-y-1.5">
                                    <p className="text-[10px] text-muted-foreground uppercase font-semibold">Créditos</p>
                                    <div className="flex justify-between">
                                      <span>Aluguel bruto</span>
                                      <span className="font-medium">{formatCurrency(bd.aluguelBruto)}</span>
                                    </div>
                                    {bd.outrosCreditos > 0 && (
                                      <div className="flex justify-between text-emerald-700">
                                        <span>Outros créditos</span>
                                        <span className="font-medium">+ {formatCurrency(bd.outrosCreditos)}</span>
                                      </div>
                                    )}
                                  </div>

                                  {/* Coluna direita — Débitos */}
                                  <div className="space-y-1.5">
                                    <p className="text-[10px] text-muted-foreground uppercase font-semibold">Descontos</p>
                                    <div className="flex justify-between text-rose-600">
                                      <span>Taxa de administração ({bd.adminFeePercent}%)</span>
                                      <span className="font-medium">- {formatCurrency(bd.adminFee)}</span>
                                    </div>
                                    {bd.iptu !== 0 && (
                                      <div className="flex justify-between text-rose-600">
                                        <span>IPTU</span>
                                        <span className="font-medium">{bd.iptu > 0 ? "- " : "+ "}{formatCurrency(Math.abs(bd.iptu))}</span>
                                      </div>
                                    )}
                                    {bd.condominio !== 0 && (
                                      <div className="flex justify-between text-rose-600">
                                        <span>Condomínio / Fundo reserva</span>
                                        <span className="font-medium">{bd.condominio > 0 ? "- " : "+ "}{formatCurrency(Math.abs(bd.condominio))}</span>
                                      </div>
                                    )}
                                    {bd.intermediacao > 0 && (
                                      <div className="flex justify-between text-rose-600">
                                        <span>Intermediação</span>
                                        <span className="font-medium">- {formatCurrency(bd.intermediacao)}</span>
                                      </div>
                                    )}
                                    {bd.irrf > 0 && (
                                      <div className="flex justify-between text-rose-600">
                                        <span>IRRF</span>
                                        <span className="font-medium">- {formatCurrency(bd.irrf)}</span>
                                      </div>
                                    )}
                                    {bd.outrosDebitos > 0 && (
                                      <div className="flex justify-between text-rose-600">
                                        <span>Outros descontos</span>
                                        <span className="font-medium">- {formatCurrency(bd.outrosDebitos)}</span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <div className="text-xs text-muted-foreground italic">
                                  Sem detalhamento disponível para este pagamento.
                                </div>
                              )}

                              {/* Linha de lançamentos individuais */}
                              {bd && bd.entries && bd.entries.length > 0 && (
                                <details className="text-xs">
                                  <summary className="cursor-pointer text-[10px] text-muted-foreground uppercase font-semibold hover:text-foreground">
                                    Ver {bd.entries.length} lançamento(s) detalhado(s)
                                  </summary>
                                  <div className="mt-2 space-y-1 pl-2 border-l-2 border-muted">
                                    {bd.entries.map((e, idx) => (
                                      <div key={idx} className="flex items-start justify-between gap-2 py-1">
                                        <div className="flex-1 min-w-0">
                                          <span className="text-[10px] uppercase font-medium text-muted-foreground">{e.category}</span>
                                          <p className="truncate">{e.description}</p>
                                        </div>
                                        <span className={`font-medium whitespace-nowrap ${e.type === 'DEBITO' ? 'text-rose-600' : 'text-emerald-700'}`}>
                                          {e.type === 'DEBITO' ? '- ' : '+ '}{formatCurrency(Math.abs(e.value))}
                                          {e.status !== 'PAGO' && <span className="ml-1 text-[10px] text-muted-foreground">({e.status})</span>}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </details>
                              )}

                              {/* Totais finais */}
                              <div className="pt-2 border-t flex flex-wrap items-center justify-between gap-2 text-xs">
                                <div className="text-muted-foreground">
                                  Valor bruto pago: <span className="font-semibold text-foreground">{formatCurrency(payment.value)}</span>
                                </div>
                                <div className="flex items-center gap-2 text-sm">
                                  <span className="text-muted-foreground">Repasse líquido:</span>
                                  <span className="font-bold text-emerald-700">
                                    {bd ? formatCurrency(bd.repasseLiquido) : (payment.splitOwnerValue != null ? formatCurrency(payment.splitOwnerValue) : "-")}
                                  </span>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}

                      {/* Resumo de descontos do mês */}
                      {(month.totals.totalIptu || month.totals.totalCondominio || month.totals.totalIntermediacao || month.totals.totalOutrosDebitos) ? (
                        <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs space-y-1">
                          <p className="font-semibold text-amber-900 mb-2">Resumo de descontos do mês:</p>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {!!month.totals.totalIptu && (
                              <div><span className="text-muted-foreground">IPTU:</span> <span className="font-medium">{formatCurrency(month.totals.totalIptu)}</span></div>
                            )}
                            {!!month.totals.totalCondominio && (
                              <div><span className="text-muted-foreground">Condomínio:</span> <span className="font-medium">{formatCurrency(month.totals.totalCondominio)}</span></div>
                            )}
                            {!!month.totals.totalIntermediacao && (
                              <div><span className="text-muted-foreground">Intermediação:</span> <span className="font-medium">{formatCurrency(month.totals.totalIntermediacao)}</span></div>
                            )}
                            {!!month.totals.totalOutrosDebitos && (
                              <div><span className="text-muted-foreground">Outros:</span> <span className="font-medium">{formatCurrency(month.totals.totalOutrosDebitos)}</span></div>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          {/* Grand Total */}
          <Card className="border-0 shadow-sm bg-primary/5">
            <CardContent className="p-5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                    <TrendingUp className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold">
                      Resumo Anual - {selectedYear}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Total de todos os meses
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-6 text-right">
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Valor Total
                    </p>
                    <p className="text-lg font-bold">
                      {formatCurrency(data.grandTotals.totalValue)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Sua Parte</p>
                    <p className="text-lg font-bold text-emerald-700">
                      {formatCurrency(data.grandTotals.totalOwner)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">
                      Taxa Admin.
                    </p>
                    <p className="text-lg font-bold text-muted-foreground">
                      {formatCurrency(data.grandTotals.totalAdmin)}
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
