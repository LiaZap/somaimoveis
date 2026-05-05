"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  TrendingUp,
  Clock,
  CheckCircle2,
  ArrowRight,
  FileText,
} from "lucide-react";

interface RepasseItem {
  id: string;
  type: "CREDITO" | "DEBITO";
  category: string;
  description: string;
  value: number;
  status: string;
  dueDate: string | null;
  paidAt: string | null;
  contract: {
    id: string;
    code: string;
    property: { id: string; title: string } | null;
    tenant: { id: string; name: string } | null;
  } | null;
}

interface RepassesData {
  ownerName: string;
  items: RepasseItem[];
  resumo: {
    totalARepassar: number;
    totalJaRepassado: number;
    totalDebitos: number;
    totalLiquido: number;
    totalLancamentos: number;
  };
}

function formatMoney(v: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(v);
}

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

const statusBadge: Record<string, { label: string; className: string }> = {
  PAGO: { label: "Pago", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  REPASSADO: { label: "Repassado", className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  PENDENTE: { label: "Pendente", className: "bg-yellow-100 text-yellow-700 border-yellow-200" },
  CANCELADO: { label: "Cancelado", className: "bg-gray-100 text-gray-500 border-gray-200" },
};

function buildMonthOptions(): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const now = new Date();
  const monthNames = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
  ];
  for (let i = 0; i < 13; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    out.push({
      value: `${y}-${String(m).padStart(2, "0")}`,
      label: `${monthNames[m - 1]} ${y}`,
    });
  }
  return out;
}

export default function PortalRepassesPage() {
  const { token } = usePortal();
  const [data, setData] = useState<RepassesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const monthOptions = buildMonthOptions();
  const [selectedMonth, setSelectedMonth] = useState<string>(monthOptions[0].value);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("month", selectedMonth);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/api/portal/repasses?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `Erro ${res.status}`);
      }
      const json = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err?.message || "Erro ao carregar");
    } finally {
      setLoading(false);
    }
  }, [token, selectedMonth, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="h-6 w-6" />
            Meus Repasses
          </h1>
          <p className="text-sm text-muted-foreground">
            Acompanhe os repasses dos imóveis em que você é proprietário ou co-proprietário.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={selectedMonth} onValueChange={setSelectedMonth}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {monthOptions.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="PENDENTE">Pendentes</SelectItem>
              <SelectItem value="PAGO">Pagos</SelectItem>
            </SelectContent>
          </Select>
          <Button asChild variant="outline" size="sm">
            <Link href={`/portal/demonstrativo?month=${selectedMonth}`}>
              <FileText className="h-4 w-4 mr-2" />
              Demonstrativo
            </Link>
          </Button>
        </div>
      </div>

      {loading && (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Carregando...
          </CardContent>
        </Card>
      )}

      {error && !loading && (
        <Card>
          <CardContent className="py-6 text-center text-red-600">{error}</CardContent>
        </Card>
      )}

      {data && !loading && (
        <>
          {/* KPIs do PROPRIO proprietario — nunca agregado da empresa */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card>
              <CardContent className="py-4">
                <div className="text-xs text-muted-foreground">A Repassar (Líquido)</div>
                <div className="text-xl font-bold mt-1">
                  {formatMoney(data.resumo.totalLiquido)}
                </div>
                {data.resumo.totalDebitos > 0 && (
                  <div className="text-xs text-rose-600 mt-1">
                    Bruto: {formatMoney(data.resumo.totalARepassar)} | Débitos:{" "}
                    -{formatMoney(data.resumo.totalDebitos)}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <div className="text-xs text-muted-foreground">Já Repassado</div>
                <div className="text-xl font-bold mt-1 text-emerald-700">
                  {formatMoney(data.resumo.totalJaRepassado)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-4">
                <div className="text-xs text-muted-foreground">Lançamentos no mês</div>
                <div className="text-xl font-bold mt-1">{data.resumo.totalLancamentos}</div>
              </CardContent>
            </Card>
          </div>

          {/* Lista */}
          <Card>
            <CardContent className="p-0">
              {data.items.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  Nenhum repasse encontrado neste período.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Vencimento</TableHead>
                        <TableHead>Descrição</TableHead>
                        <TableHead>Imóvel</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Valor</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.items.map((item) => {
                        const sb = statusBadge[item.status] || {
                          label: item.status,
                          className: "bg-gray-100 text-gray-700",
                        };
                        const isDebit = item.type === "DEBITO";
                        return (
                          <TableRow key={item.id}>
                            <TableCell className="whitespace-nowrap text-sm">
                              {formatDate(item.dueDate)}
                            </TableCell>
                            <TableCell className="text-sm">
                              {item.description}
                              {item.contract?.tenant?.name && (
                                <div className="text-xs text-muted-foreground">
                                  Locatário: {item.contract.tenant.name}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-sm">
                              {item.contract?.property?.title || "-"}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className={sb.className}>
                                {sb.label}
                              </Badge>
                            </TableCell>
                            <TableCell
                              className={`text-right font-medium ${
                                isDebit ? "text-rose-700" : "text-emerald-700"
                              }`}
                            >
                              {isDebit ? "-" : ""}
                              {formatMoney(item.value)}
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

          <div className="flex justify-end">
            <Button asChild>
              <Link href={`/portal/demonstrativo?month=${selectedMonth}`}>
                Ver Demonstrativo Detalhado
                <ArrowRight className="h-4 w-4 ml-2" />
              </Link>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
