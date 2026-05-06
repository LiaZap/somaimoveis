"use client";

import { useEffect, useState, useMemo } from "react";
import { toast } from "sonner";
import { Header } from "@/components/layout/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Save, Search, AlertTriangle, Calendar } from "lucide-react";

interface ContratoRow {
  id: string;
  code: string;
  paymentDay: number;
  tenantPaymentDay: number | null;
  mismatch: boolean;
  locatario: string;
  proprietario: string;
  imovel: string;
}

interface AuditData {
  totalContratos: number;
  distribuicao: { paymentDay: number; total: number }[];
  contratos: ContratoRow[];
}

export default function PaymentDayPage() {
  const [data, setData] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [filterDay, setFilterDay] = useState<number | null>(null);
  const [onlyMismatch, setOnlyMismatch] = useState(false);
  // Edits pending: contractId -> newPaymentDay
  const [edits, setEdits] = useState<Map<string, number>>(new Map());

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/contracts-payment-day");
      const json = await res.json();
      setData(json);
    } catch {
      toast.error("Erro ao carregar contratos");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function handleEdit(contractId: string, currentDay: number, value: string) {
    const newDay = parseInt(value);
    setEdits((prev) => {
      const next = new Map(prev);
      if (!isFinite(newDay) || newDay < 1 || newDay > 31 || newDay === currentDay) {
        next.delete(contractId);
      } else {
        next.set(contractId, newDay);
      }
      return next;
    });
  }

  async function handleSave() {
    if (edits.size === 0) {
      toast.error("Nenhuma alteração pra salvar");
      return;
    }
    if (!confirm(`Atualizar paymentDay de ${edits.size} contrato(s)?\n\nIsso vai cascatear automaticamente pros boletos pendentes não emitidos. Boletos já emitidos no Sicredi terão que ser cancelados+regerados manualmente.`)) return;
    setSaving(true);
    try {
      const updates = Array.from(edits.entries()).map(([contractId, newPaymentDay]) => ({
        contractId,
        newPaymentDay,
      }));
      const res = await fetch("/api/admin/contracts-payment-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result?.error || "Erro");
      toast.success(
        `${result.contractsUpdated} contrato(s) atualizado(s). ` +
          `${result.totalBoletosCascadeados} boletos pendentes ajustados. ` +
          `${result.totalBoletosPrecisamReemitir} boletos já emitidos precisam ser cancelados/regerados manualmente.`,
        { duration: 8000 },
      );
      // Mostrar lista de boletos que precisam ação manual
      if (result.totalBoletosPrecisamReemitir > 0) {
        const linhas = result.results
          .filter((r: any) => r.pendingIssuedNeedManualReissue.length > 0)
          .map((r: any) => `${r.code}: ${r.pendingIssuedNeedManualReissue.map((b: any) => b.code).join(", ")}`)
          .join("\n");
        console.log("Boletos a regerar manualmente:\n" + linhas);
      }
      setEdits(new Map());
      load();
    } catch (err: any) {
      toast.error(err?.message || "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  }

  const filtered = useMemo(() => {
    if (!data) return [];
    let list = data.contratos;
    if (onlyMismatch) list = list.filter((c) => c.mismatch);
    if (filterDay !== null) list = list.filter((c) => c.paymentDay === filterDay);
    if (search) {
      const s = search.toLowerCase().trim();
      list = list.filter(
        (c) =>
          c.code.toLowerCase().includes(s) ||
          c.locatario.toLowerCase().includes(s) ||
          c.proprietario.toLowerCase().includes(s) ||
          c.imovel.toLowerCase().includes(s),
      );
    }
    return list;
  }, [data, filterDay, search, onlyMismatch]);

  const totalMismatches = data?.contratos.filter((c) => c.mismatch).length || 0;

  return (
    <div className="flex flex-col">
      <Header
        title="Dia de Vencimento dos Contratos"
        subtitle="Gerencie o paymentDay de todos os contratos ativos"
      />

      <div className="p-4 sm:p-6 space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Como usar
            </CardTitle>
            <CardDescription className="leading-relaxed">
              Edite o dia ao lado de cada contrato. As alterações ficam pendentes
              no topo até você clicar em <strong>Salvar Alterações</strong>.
              Boletos PENDENTES ainda não emitidos serão atualizados automaticamente.
              Boletos JÁ EMITIDOS no Sicredi precisam ser cancelados e regerados
              manualmente na tela do pagamento.
            </CardDescription>
          </CardHeader>
        </Card>

        {/* Distribuição */}
        {data && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Distribuição atual</CardTitle>
              <CardDescription>
                {data.totalContratos} contratos ativos. Clique num dia pra filtrar.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={filterDay === null && !onlyMismatch ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setFilterDay(null); setOnlyMismatch(false); }}
                >
                  Todos ({data.totalContratos})
                </Button>
                {totalMismatches > 0 && (
                  <Button
                    variant={onlyMismatch ? "destructive" : "outline"}
                    size="sm"
                    onClick={() => { setOnlyMismatch(!onlyMismatch); setFilterDay(null); }}
                    className={onlyMismatch ? "" : "border-red-300 text-red-700 hover:bg-red-50"}
                  >
                    ⚠ Desincronizados ({totalMismatches})
                  </Button>
                )}
                {data.distribuicao.map((d) => (
                  <Button
                    key={d.paymentDay}
                    variant={filterDay === d.paymentDay && !onlyMismatch ? "default" : "outline"}
                    size="sm"
                    onClick={() => { setFilterDay(d.paymentDay); setOnlyMismatch(false); }}
                  >
                    Dia {d.paymentDay} ({d.total})
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Edits pendentes + botão Salvar */}
        {edits.size > 0 && (
          <Card className="bg-amber-50 border-amber-200">
            <CardContent className="py-3 flex items-center justify-between">
              <div className="text-sm">
                <strong>{edits.size}</strong> alteração(ões) pendente(s)
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEdits(new Map())}
                  disabled={saving}
                >
                  Descartar
                </Button>
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-1" />
                  )}
                  Salvar Alterações
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Busca */}
        <div className="relative max-w-md">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar por contrato, locatário, proprietário ou imóvel..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Tabela */}
        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="py-10 text-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
                Carregando...
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30 border-b">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">Contrato</th>
                      <th className="text-left px-4 py-2 font-medium">Locatário</th>
                      <th className="text-left px-4 py-2 font-medium">Proprietário</th>
                      <th className="text-left px-4 py-2 font-medium">Imóvel</th>
                      <th className="text-left px-4 py-2 font-medium w-32" title="Dia configurado no contrato (usado pelo billing)">
                        Dia Contrato
                      </th>
                      <th className="text-left px-4 py-2 font-medium w-32" title="Dia configurado no cadastro do locatário (informativo)">
                        Dia Locatário
                      </th>
                      <th className="text-left px-4 py-2 font-medium w-32">Novo Dia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => {
                      const newDay = edits.get(c.id);
                      const hasEdit = newDay !== undefined;
                      return (
                        <tr
                          key={c.id}
                          className={`border-b last:border-0 ${hasEdit ? "bg-amber-50" : c.mismatch ? "bg-red-50/40" : ""}`}
                        >
                          <td className="px-4 py-2 font-mono text-xs">{c.code}</td>
                          <td className="px-4 py-2">{c.locatario}</td>
                          <td className="px-4 py-2 text-muted-foreground">
                            {c.proprietario}
                          </td>
                          <td className="px-4 py-2 text-xs text-muted-foreground">
                            {c.imovel}
                          </td>
                          <td className="px-4 py-2">
                            <Badge variant="outline" className="font-mono">
                              {c.paymentDay}
                            </Badge>
                          </td>
                          <td className="px-4 py-2">
                            {c.tenantPaymentDay !== null ? (
                              <Badge
                                variant="outline"
                                className={`font-mono ${c.mismatch ? "bg-red-100 text-red-700 border-red-300" : ""}`}
                                title={c.mismatch ? "DIVERGENTE do dia do contrato" : ""}
                              >
                                {c.tenantPaymentDay}
                                {c.mismatch && " ⚠"}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-1">
                              <Input
                                type="number"
                                min="1"
                                max="31"
                                className="h-8 w-20"
                                key={c.id + "-" + (newDay ?? c.paymentDay)}
                                defaultValue={c.paymentDay}
                                onChange={(e) =>
                                  handleEdit(c.id, c.paymentDay, e.target.value)
                                }
                              />
                              {c.mismatch && c.tenantPaymentDay !== null && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 px-2 text-xs"
                                  title={`Usar dia ${c.tenantPaymentDay} do cadastro do locatário`}
                                  onClick={() => {
                                    const next = new Map(edits);
                                    next.set(c.id, c.tenantPaymentDay!);
                                    setEdits(next);
                                  }}
                                >
                                  ← {c.tenantPaymentDay}
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {filtered.length === 0 && (
                      <tr>
                        <td
                          colSpan={6}
                          className="py-10 text-center text-muted-foreground"
                        >
                          Nenhum contrato encontrado
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
