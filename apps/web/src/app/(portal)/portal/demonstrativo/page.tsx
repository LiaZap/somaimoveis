"use client";

import { useEffect, useState, useCallback } from "react";
import { usePortal } from "@/components/portal/portal-provider";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Receipt, Printer, Share2, FileDown } from "lucide-react";

interface Movimento {
  date: string;
  descricao: string;
  entrada: number;
  saida: number;
}

interface ContratoGroup {
  contractId: string;
  code: string;
  property: { id: string; title: string; type: string; address: string } | null;
  tenant: { id: string; name: string; cpfCnpj: string; personType: string } | null;
  startDate: string | null;
  lastAdjustmentDate: string | null;
  movimentos: Movimento[];
  totalEntradas: number;
  totalSaidas: number;
  totalLiquido: number;
}

interface DemonstrativoData {
  periodo: { start: string; end: string; month: string; mesReferencia?: string; mesVencimento?: string };
  empresa: { nome: string; cnpj: string };
  proprietario: { id: string; name: string; cpfCnpj: string; personType: string };
  dataReferenciaPagamento: string;
  contratos: ContratoGroup[];
  avulsas: Movimento[];
  totais: {
    entradas: number;
    saidas: number;
    movimento: number;
    saldoMesAnterior: number;
    valorRetido: number;
    totalPago: number;
  };
  pagamento: {
    beneficiario: string;
    data: string;
    forma: string;
    chavePix: string;
    pixType: string;
    bank: string;
    agency: string;
    account: string;
    valor: number;
  };
}

function formatMoney(v: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
  }).format(v);
}

function formatNumber(v: number): string {
  if (v === 0) return "";
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
}

// Gera lista de meses pra picker (12 meses pra trás + atual)
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

export default function PortalDemonstrativoPage() {
  const { token } = usePortal();
  const [data, setData] = useState<DemonstrativoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const monthOptions = buildMonthOptions();
  const [selectedMonth, setSelectedMonth] = useState<string>(monthOptions[0].value);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/portal/demonstrativo?month=${selectedMonth}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
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
  }, [token, selectedMonth]);

  useEffect(() => {
    load();
  }, [load]);

  const handlePrint = () => window.print();

  const handleShare = async () => {
    if (!data) return;
    const text =
      `Demonstrativo de Repasse - ${data.periodo.mesReferencia || data.periodo.month}\n` +
      `Proprietario: ${data.proprietario.name}\n` +
      `Total Liquido: ${formatMoney(data.totais.movimento)}\n` +
      `Periodo: ${data.periodo.start} a ${data.periodo.end}`;
    if (typeof navigator !== "undefined" && (navigator as any).share) {
      try {
        await (navigator as any).share({ title: "Demonstrativo Somma", text });
        return;
      } catch { /* user cancelou */ }
    }
    // Fallback: copia pro clipboard
    try {
      await navigator.clipboard.writeText(text);
      alert("Demonstrativo copiado para a área de transferência.");
    } catch {
      alert("Não foi possível compartilhar. Use o botão Imprimir.");
    }
  };

  return (
    <div className="space-y-6 print:space-y-3">
      {/* Header com filtro */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 print:hidden">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Receipt className="h-6 w-6" />
            Demonstrativo de Repasses
          </h1>
          <p className="text-sm text-muted-foreground">
            Veja o detalhamento dos seus repasses por mês.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <Select value={selectedMonth} onValueChange={setSelectedMonth}>
            <SelectTrigger className="w-[180px]">
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
          <Button variant="outline" size="sm" onClick={handleShare} disabled={!data}>
            <Share2 className="h-4 w-4 mr-2" />
            Compartilhar
          </Button>
          <Button variant="outline" size="sm" onClick={handlePrint} disabled={!data}>
            <Printer className="h-4 w-4 mr-2" />
            Imprimir
          </Button>
        </div>
      </div>

      {loading && (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Carregando demonstrativo...
          </CardContent>
        </Card>
      )}

      {error && !loading && (
        <Card>
          <CardContent className="py-6 text-center text-red-600">
            {error}
          </CardContent>
        </Card>
      )}

      {data && !loading && (
        <>
          {/* Cabecalho do demonstrativo */}
          <Card>
            <CardContent className="py-4">
              <div className="flex flex-col sm:flex-row sm:justify-between gap-2 text-sm">
                <div>
                  <div className="font-semibold text-base">{data.empresa.nome}</div>
                  <div className="text-muted-foreground">CNPJ: {data.empresa.cnpj}</div>
                </div>
                <div className="text-right">
                  <div className="font-semibold">
                    Mês Referência: {data.periodo.mesReferencia || data.periodo.month}
                  </div>
                  {data.periodo.mesVencimento && (
                    <div className="text-xs text-muted-foreground">
                      Boletos com vencimento em {data.periodo.mesVencimento}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    Período: {data.periodo.start} a {data.periodo.end}
                  </div>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t text-sm">
                <div>
                  <strong>Proprietário:</strong> {data.proprietario.name}
                  <span className="ml-3 text-muted-foreground">
                    {data.proprietario.personType === "PJ" ? "CNPJ:" : "CPF:"}{" "}
                    {data.proprietario.cpfCnpj}
                  </span>
                </div>
                <div className="text-muted-foreground text-xs mt-1">
                  Data de referência do pagamento: {data.dataReferenciaPagamento}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Lista de contratos com movimentos */}
          {data.contratos.length === 0 && data.avulsas.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">
                Nenhum movimento encontrado neste período.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {data.contratos.map((c) => (
                <Card key={c.contractId}>
                  <CardContent className="p-0">
                    {/* Header do contrato */}
                    <div className="bg-muted/50 px-4 py-3 border-b">
                      <div className="font-semibold text-sm">
                        {c.property?.title || c.code}
                      </div>
                      {c.property?.address && (
                        <div className="text-xs text-muted-foreground">
                          {c.property.address}
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground mt-1">
                        <strong>Locatário:</strong> {c.tenant?.name || "-"}
                      </div>
                    </div>

                    {/* Movimentos — tabela */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-xs text-muted-foreground border-b">
                          <tr>
                            <th className="text-left px-4 py-2 font-medium">Data</th>
                            <th className="text-left px-4 py-2 font-medium">Movimento</th>
                            <th className="text-right px-4 py-2 font-medium">Entrada</th>
                            <th className="text-right px-4 py-2 font-medium">Saída</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.movimentos.map((m, i) => (
                            <tr key={i} className="border-b last:border-0">
                              <td className="px-4 py-2 whitespace-nowrap">{m.date}</td>
                              <td className="px-4 py-2">{m.descricao}</td>
                              <td className="px-4 py-2 text-right text-emerald-700">
                                {m.entrada > 0 ? formatNumber(m.entrada) : ""}
                              </td>
                              <td className="px-4 py-2 text-right text-rose-700">
                                {m.saida > 0 ? `-${formatNumber(m.saida)}` : ""}
                              </td>
                            </tr>
                          ))}
                          <tr className="bg-muted/30 font-semibold">
                            <td colSpan={2} className="px-4 py-2 text-right">
                              Total do contrato:
                            </td>
                            <td colSpan={2} className="px-4 py-2 text-right">
                              {formatMoney(c.totalLiquido)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              ))}

              {data.avulsas.length > 0 && (
                <Card>
                  <CardContent className="p-0">
                    <div className="bg-muted/50 px-4 py-3 border-b">
                      <div className="font-semibold text-sm">Movimentos avulsos</div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <tbody>
                          {data.avulsas.map((m, i) => (
                            <tr key={i} className="border-b last:border-0">
                              <td className="px-4 py-2 whitespace-nowrap">{m.date}</td>
                              <td className="px-4 py-2">{m.descricao}</td>
                              <td className="px-4 py-2 text-right text-emerald-700">
                                {m.entrada > 0 ? formatNumber(m.entrada) : ""}
                              </td>
                              <td className="px-4 py-2 text-right text-rose-700">
                                {m.saida > 0 ? `-${formatNumber(m.saida)}` : ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* Resumo final */}
          <Card>
            <CardContent className="py-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-muted-foreground text-xs">Total de entradas</div>
                  <div className="font-semibold text-emerald-700">
                    {formatMoney(data.totais.entradas)}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Total de saídas</div>
                  <div className="font-semibold text-rose-700">
                    {data.totais.saidas > 0 ? `-${formatMoney(data.totais.saidas)}` : "-"}
                  </div>
                </div>
                <div className="col-span-2 pt-3 border-t">
                  <div className="text-muted-foreground text-xs">Total líquido a receber</div>
                  <div className="font-bold text-xl">
                    {formatMoney(data.totais.movimento)}
                  </div>
                </div>
              </div>

              {/* Info de pagamento */}
              {(data.pagamento.chavePix || data.pagamento.account) && (
                <div className="mt-4 pt-3 border-t text-sm">
                  <div className="text-muted-foreground text-xs mb-1">Forma de pagamento</div>
                  <div>
                    <strong>Beneficiário:</strong> {data.pagamento.beneficiario}
                  </div>
                  <div>
                    <strong>Forma:</strong> {data.pagamento.forma}
                  </div>
                  {data.pagamento.chavePix && (
                    <div>
                      <strong>Chave PIX ({data.pagamento.pixType}):</strong>{" "}
                      {data.pagamento.chavePix}
                    </div>
                  )}
                  {data.pagamento.bank && data.pagamento.account && (
                    <div>
                      <strong>Banco:</strong> {data.pagamento.bank} — Ag {data.pagamento.agency}{" "}
                      Conta {data.pagamento.account}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
