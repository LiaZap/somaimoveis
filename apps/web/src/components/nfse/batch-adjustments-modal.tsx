"use client";

/**
 * Modal "Aplicar ajustes em lote" — pra fechar ajustes do tipo:
 *   - "Não tem desconto" (recalcular sobre aluguel bruto)
 *   - Valor exato (override manual)
 *   - Suprimir (não emitir esta NF no mês)
 *
 * Pré-populado com a lista do Leo de Abril/2026. Usuario revisa
 * cada linha (pode editar/desmarcar) e clica "Aplicar tudo" —
 * envia 1 POST batch pro /api/invoices/preview-audit que aplica
 * suppress + noDiscount + value overrides de uma vez.
 *
 * Depois de aplicar, o modal de Pre-validacao deve ser re-aberto
 * pra ver o resultado.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Loader2, Sparkles, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";

type ActionType = "no-discount" | "value" | "suppress" | "skip";

interface BatchItem {
  ownerName: string;
  action: ActionType;
  values?: number[];        // pra action=value (1 por contrato/grupo)
  contractCode?: string;    // dica pra identificar contrato especifico (opcional)
  note?: string;
  apply: boolean;           // checkbox: incluir no batch?
  status?: "ok" | "no-match" | "error";
  matchedKeys?: string[];   // groupKeys que casaram
  errorMsg?: string;
}

// Lista pre-populada do Leo (Abril/2026)
const LEO_LIST_APR_2026: Omit<BatchItem, "apply">[] = [
  // SEM DESCONTO
  { ownerName: "Bela Boettcher Pereira", action: "no-discount" },
  { ownerName: "Lucca Boettcher Pereira", action: "no-discount" },
  { ownerName: "Gilmara Muller", action: "no-discount", contractCode: "CTR-128" },
  { ownerName: "Hellfer Participações", action: "no-discount" },
  { ownerName: "Marcia Susana Simon", action: "no-discount" },
  { ownerName: "Maria Isabel Alano da Silva", action: "no-discount" },
  { ownerName: "Pamela Constantin de Medeiros Muniz", action: "no-discount" },
  { ownerName: "Patricia Molz Mallman", action: "no-discount", note: "Apenas 1 dos 2 imóveis — confira" },
  { ownerName: "Raquel Concato", action: "no-discount" },
  { ownerName: "Roberta Coutinho Gerhard", action: "no-discount" },
  { ownerName: "Rodomahler Participações", action: "no-discount" },
  { ownerName: "Tatiane Aline Mohler", action: "no-discount" },
  { ownerName: "Wanderlei José", action: "no-discount" },
  { ownerName: "Ricarol", action: "no-discount", contractCode: "CTR-222" },

  // SUPRIMIR
  { ownerName: "Edimilson Luiz de Oliveira", action: "suppress", note: "Zerar (não emitir)" },
  { ownerName: "Patricia Genz Azambuja", action: "suppress", note: "Não teve aluguel — pode excluir" },

  // VALOR MANUAL
  { ownerName: "Debora Rafah Schirrmann", action: "value", values: [10.03, 11.25, 11.94] },
  { ownerName: "Luiz Fernando Schirrmann", action: "value", values: [10.03, 11.25, 11.94] },
  { ownerName: "Marines Cerny", action: "value", values: [184.97] },
  { ownerName: "Maristela Cerny", action: "value", values: [184.97] },
  { ownerName: "Empreendimentos Schiemann e Pegas LTDA", action: "value", values: [450.00, 319.89] },
  { ownerName: "Juares José Constantin LTDA", action: "value", values: [120.00, 504.00], note: "2 imóveis (8% no 2º)" },

  // COPROPRIETÁRIOS (10% sobre o aluguel da cota)
  { ownerName: "Carlos Eduardo Kampf", action: "value", values: [42.50], note: "10% de R$ 425" },
  { ownerName: "Cristiano Eduardo Kampf", action: "value", values: [42.50], note: "10% de R$ 425" },
  { ownerName: "Clarice Kaempf Meissner", action: "value", values: [85.00], note: "10% de R$ 850" },
  { ownerName: "Carla Kaempf Louzada", action: "value", values: [85.00], note: "10% de R$ 850" },

  // ESPECIAIS (não automatizáveis — apenas info)
  { ownerName: "Gelson Paulo Constantin LTDA", action: "skip", note: "Precisa cadastrar entry INTERMEDIACAO manualmente — pular do batch" },
  { ownerName: "Posto Shopping Car Com.", action: "skip", note: "Alíquota é 10%, manter desconto — verificar contrato (não está em 6,66%)" },
];

// Tipo minimo do AuditItem (so o que esse modal precisa)
interface AuditItemLite {
  ownerId: string;
  ownerName: string;
  contractCode: string | null;
  contractId: string | null;
  ano: number;
  mes: number;
  valorNF: number;
  groupKey?: string; // chave canonica do backend
}

interface Props {
  open: boolean;
  onClose: () => void;
  month: string;                // "YYYY-MM"
  items: AuditItemLite[];       // items da pre-validacao atual
  onAppliedRefresh: () => void; // re-roda pre-validacao depois
}

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

function groupKey(i: AuditItemLite): string {
  // SEMPRE usa o groupKey canonico do backend. Fallback so pra compat se
  // estiver ausente (entries sem contrato precisam do entry.id real).
  if (i.groupKey) return i.groupKey;
  const mm = String(i.mes).padStart(2, "0");
  return i.contractId
    ? `${i.contractId}_${i.ano}-${mm}_${i.ownerId}`
    : `entry_unknown_${i.ano}-${mm}_${i.ownerId}`;
}

export function BatchAdjustmentsModal({ open, onClose, month, items, onAppliedRefresh }: Props) {
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [applying, setApplying] = useState(false);

  // Pre-popula lista quando abre (so se mes for 2026-04)
  useEffect(() => {
    if (!open) return;
    if (month === "2026-04") {
      setBatchItems(LEO_LIST_APR_2026.map((x) => ({ ...x, apply: x.action !== "skip" })));
    } else {
      setBatchItems([]); // vazio pra outros meses
    }
  }, [open, month]);

  // Quando items mudam (re-fetch), atualiza status de match pra cada batch item
  const enriched = useMemo(() => {
    return batchItems.map((b) => {
      const nameNorm = normalize(b.ownerName);
      const matches = items.filter((i) => {
        const iNorm = normalize(i.ownerName);
        // Match flexivel: contém ou contido
        return iNorm === nameNorm || iNorm.includes(nameNorm) || nameNorm.includes(iNorm);
      });
      // Se especificou contractCode, filtra
      const filtered = b.contractCode
        ? matches.filter((m) => m.contractCode === b.contractCode)
        : matches;

      return {
        ...b,
        matchedKeys: filtered.map((m) => groupKey(m)),
        matchedItems: filtered,
        status: (filtered.length === 0 ? "no-match" : "ok") as "ok" | "no-match",
      };
    });
  }, [batchItems, items]);

  function toggleApply(idx: number) {
    setBatchItems((prev) => prev.map((b, i) => i === idx ? { ...b, apply: !b.apply } : b));
  }

  function updateValue(idx: number, valueIdx: number, raw: string) {
    const n = parseFloat(raw.replace(",", "."));
    setBatchItems((prev) => prev.map((b, i) => {
      if (i !== idx) return b;
      const values = [...(b.values || [])];
      values[valueIdx] = isNaN(n) ? 0 : n;
      return { ...b, values };
    }));
  }

  async function aplicarTudo() {
    const toApply = enriched.filter((b) => b.apply && b.status === "ok" && b.action !== "skip");
    if (toApply.length === 0) {
      toast.error("Nenhum item válido pra aplicar");
      return;
    }

    const overrides: Record<string, number | null> = {};
    const suppress: Record<string, true | null> = {};
    const noDiscount: Record<string, true | null> = {};

    for (const b of toApply) {
      const keys = b.matchedKeys || [];
      if (b.action === "no-discount") {
        for (const k of keys) noDiscount[k] = true;
      } else if (b.action === "suppress") {
        for (const k of keys) suppress[k] = true;
      } else if (b.action === "value" && b.values && b.values.length > 0) {
        // Aplica 1 valor por key (na ordem). Se houver mais keys que valores,
        // os extras ficam sem override (admin decide depois).
        for (let i = 0; i < Math.min(keys.length, b.values.length); i++) {
          overrides[keys[i]] = b.values[i];
        }
      }
    }

    setApplying(true);
    try {
      const res = await fetch("/api/invoices/preview-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month,
          overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
          suppress: Object.keys(suppress).length > 0 ? suppress : undefined,
          noDiscount: Object.keys(noDiscount).length > 0 ? noDiscount : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Erro ao aplicar");
        return;
      }
      toast.success(
        `Aplicado: ${Object.keys(overrides).length} valores, ${Object.keys(noDiscount).length} no-discount, ${Object.keys(suppress).length} suprimidos`,
        { duration: 6000 }
      );
      onAppliedRefresh();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro");
    } finally {
      setApplying(false);
    }
  }

  const summary = useMemo(() => ({
    total: enriched.length,
    okPraAplicar: enriched.filter((b) => b.apply && b.status === "ok" && b.action !== "skip").length,
    semMatch: enriched.filter((b) => b.status === "no-match").length,
    skip: enriched.filter((b) => b.action === "skip").length,
  }), [enriched]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="!max-w-[1100px] w-[95vw] max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b bg-muted/30">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-5 w-5 text-violet-600" />
            Ajustes em lote — {month}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Lista pré-populada com os ajustes do Leo. Revise, edite e clique "Aplicar tudo".
            Ações: <Badge variant="outline" className="text-[10px] mx-1">Sem desconto</Badge>
            <Badge variant="outline" className="text-[10px] mx-1">Valor manual</Badge>
            <Badge variant="outline" className="text-[10px] mx-1">Suprimir</Badge>
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-3 border-b bg-background flex items-center gap-3 flex-wrap shrink-0">
          <span className="text-xs">
            <strong>{summary.total}</strong> itens · {" "}
            <span className="text-emerald-700">{summary.okPraAplicar} ok</span> · {" "}
            <span className="text-amber-700">{summary.semMatch} sem match</span> · {" "}
            <span className="text-muted-foreground">{summary.skip} manuais</span>
          </span>
          <div className="ml-auto" />
          <Button variant="outline" size="sm" onClick={onClose} className="h-8 text-xs">
            Cancelar
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs gap-1.5 bg-violet-600 hover:bg-violet-700"
            onClick={aplicarTudo}
            disabled={applying || summary.okPraAplicar === 0}
          >
            {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Aplicar {summary.okPraAplicar} ajuste{summary.okPraAplicar === 1 ? "" : "s"}
          </Button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4 bg-muted/10 space-y-2">
          {enriched.length === 0 && (
            <div className="text-center py-12 text-muted-foreground text-sm">
              Nenhuma lista pré-populada pra esse mês.
            </div>
          )}

          {enriched.map((b, idx) => {
            const actionColor = b.action === "no-discount" ? "bg-emerald-100 text-emerald-800"
              : b.action === "suppress" ? "bg-red-100 text-red-800"
              : b.action === "value" ? "bg-blue-100 text-blue-800"
              : "bg-gray-100 text-gray-700";
            const actionLabel = b.action === "no-discount" ? "Sem desconto"
              : b.action === "suppress" ? "Suprimir"
              : b.action === "value" ? "Valor manual"
              : "Manual (skip)";

            const statusBadge = b.action === "skip" ? null
              : b.status === "no-match" ? (
                <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-700 bg-amber-50">
                  <AlertTriangle className="h-3 w-3 mr-1" /> Sem match
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-700 bg-emerald-50">
                  <CheckCircle2 className="h-3 w-3 mr-1" /> {b.matchedKeys?.length || 0} match
                </Badge>
              );

            return (
              <div key={idx} className={`border rounded-md bg-white p-3 ${
                !b.apply || b.action === "skip" ? "opacity-60" : ""
              }`}>
                <div className="flex items-start gap-3">
                  {b.action !== "skip" && (
                    <Checkbox
                      checked={b.apply}
                      onCheckedChange={() => toggleApply(idx)}
                      className="mt-1"
                    />
                  )}
                  {b.action === "skip" && (
                    <XCircle className="h-4 w-4 text-gray-400 mt-1 shrink-0" />
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{b.ownerName}</span>
                      <Badge variant="outline" className={`text-[10px] ${actionColor} border-0`}>
                        {actionLabel}
                      </Badge>
                      {b.contractCode && (
                        <Badge variant="outline" className="text-[10px] font-mono">
                          {b.contractCode}
                        </Badge>
                      )}
                      {statusBadge}
                    </div>

                    {b.note && (
                      <div className="text-[11px] text-muted-foreground mt-1">📝 {b.note}</div>
                    )}

                    {b.action === "value" && b.values && (
                      <div className="mt-2 flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] text-muted-foreground">Valores:</span>
                        {b.values.map((v, vi) => (
                          <Input
                            key={vi}
                            type="number"
                            step="0.01"
                            min="0"
                            value={v}
                            onChange={(e) => updateValue(idx, vi, e.target.value)}
                            className="h-7 w-24 text-xs"
                          />
                        ))}
                        {b.matchedKeys && b.matchedKeys.length > b.values.length && (
                          <span className="text-[10px] text-amber-700">
                            ⚠️ {b.matchedKeys.length} matches mas só {b.values.length} valor(es) — extras ficam sem override
                          </span>
                        )}
                        {b.matchedKeys && b.matchedKeys.length < b.values.length && b.status === "ok" && (
                          <span className="text-[10px] text-amber-700">
                            ⚠️ {b.values.length} valores mas só {b.matchedKeys.length} match(es)
                          </span>
                        )}
                      </div>
                    )}

                    {b.status === "no-match" && (
                      <div className="text-[11px] text-amber-700 mt-1">
                        Owner não encontrado na pré-validação deste mês. Verifique o nome ou
                        certifique-se de que ele tem REPASSE/INTERMEDIACAO em {month}.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
