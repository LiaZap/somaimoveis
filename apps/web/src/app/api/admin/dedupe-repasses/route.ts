import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/admin/dedupe-repasses?dryRun=true
 *
 * Detecta OwnerEntries REPASSE/GARANTIA duplicadas pelo mesmo
 * (ownerId, contractId, description, dueDate, value).
 *
 * Cenario real: sync gera OwnerEntry referente a um Payment que
 * o admin marcou na mao fora do sistema. No proximo mes, sync
 * detecta que ainda nao tem OwnerEntry "paga" e gera de novo.
 *
 * Estrategia: mantem a entry com paidAt mais ANTIGO (a original)
 * e cancela as outras (status=CANCELADO). Preserva historico.
 *
 * Idempotente. Aceita ?dryRun=true (default false) e
 * ?month=YYYY-MM (filtra duplicatas com dueDate no mes).
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const dryRun = searchParams.get("dryRun") === "true";
    const monthFilter = searchParams.get("month");

    // Inclui INTERMEDIACAO no dedupe — tambem foi duplicada por sync
    // (caso Cristiano Kampf: 2 entries INTERMEDIACAO 361.19, uma PAGO e
    // outra PENDENTE com mesma description).
    const where: Record<string, unknown> = {
      category: { in: ["REPASSE", "GARANTIA", "INTERMEDIACAO"] },
      status: { not: "CANCELADO" },
    };

    if (monthFilter && /^\d{4}-\d{2}$/.test(monthFilter)) {
      const [y, m] = monthFilter.split("-").map(Number);
      // Fix Bug 31: valida bounds do mes (1-12) pra evitar Date overflow
      // (ex: "2026-00" => mes anterior, "2026-13" => jan/2027).
      if (m < 1 || m > 12 || y < 2000 || y > 2100) {
        return NextResponse.json(
          { error: `month invalido: ${monthFilter} (esperado YYYY-MM com m em 1-12)` },
          { status: 400 }
        );
      }
      where.dueDate = {
        gte: new Date(y, m - 1, 1),
        lt: new Date(y, m, 1),
      };
    }

    const entries = await prisma.ownerEntry.findMany({
      where,
      select: {
        id: true,
        ownerId: true,
        contractId: true,
        description: true,
        dueDate: true,
        paidAt: true,
        value: true,
        status: true,
        notes: true,
        createdAt: true,
        owner: { select: { name: true } },
      },
    });

    // Agrupa por chave: ownerId + contractId + description + value
    // (sem dueDate na chave — captura o caso comum onde sync gerou
    // duplicata com dueDate ligeiramente diferente, ex: 05/05 vs 06/04
    // para o mesmo "Repasse aluguel 04/2026". Caso Katiane Katzer.)
    const groups: Record<string, typeof entries> = {};
    for (const e of entries) {
      const key = [
        e.ownerId,
        e.contractId || "noContract",
        e.description,
        e.value.toFixed(2),
      ].join("|");
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    }

    const toCancel: {
      id: string;
      ownerName: string;
      desc: string;
      dueDate: string | null;
      paidAt: string | null;
      value: number;
      keptId: string;
    }[] = [];

    for (const [, list] of Object.entries(groups)) {
      if (list.length < 2) continue;
      // Estrategia de selecao do "keep":
      //  1. PREFERE entry com bankConfirmed=true em notes (confirmada pelo Sicredi)
      //  2. SE NAO, prefere a com paidAt MAIS RECENTE (paga via CNAB recente)
      //  3. SE NAO tem paidAt, prefere a mais recente por createdAt
      //
      // Antes mantinha a mais antiga por paidAt — mas geralmente a antiga
      // e a "fantasma" criada por sync errado em mes anterior, enquanto a
      // recente foi a efetivamente paga via CNAB do mes corrente.
      const sorted = [...list].sort((a, b) => {
        const aConfirmed = (() => { try { return JSON.parse(a.notes || "{}").bankConfirmed === true; } catch { return false; } })();
        const bConfirmed = (() => { try { return JSON.parse(b.notes || "{}").bankConfirmed === true; } catch { return false; } })();
        if (aConfirmed && !bConfirmed) return -1;
        if (bConfirmed && !aConfirmed) return 1;
        // Tiebreaker: paidAt desc (mais recente primeiro)
        const aPaid = a.paidAt ? a.paidAt.getTime() : 0;
        const bPaid = b.paidAt ? b.paidAt.getTime() : 0;
        if (aPaid !== bPaid) return bPaid - aPaid;
        // Tiebreaker final: createdAt desc
        return (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0);
      });
      const [keep, ...rest] = sorted;
      for (const dupe of rest) {
        toCancel.push({
          id: dupe.id,
          ownerName: dupe.owner?.name || "?",
          desc: dupe.description,
          dueDate: dupe.dueDate ? dupe.dueDate.toISOString().slice(0, 10) : null,
          paidAt: dupe.paidAt ? dupe.paidAt.toISOString() : null,
          value: dupe.value,
          keptId: keep.id,
        });
      }
    }

    if (!dryRun && toCancel.length > 0) {
      await prisma.ownerEntry.updateMany({
        where: { id: { in: toCancel.map((t) => t.id) } },
        data: { status: "CANCELADO" },
      });
    }

    return NextResponse.json({
      mode: dryRun ? "DRY_RUN" : "APPLIED",
      total: toCancel.length,
      somaValores: Math.round(toCancel.reduce((s, t) => s + t.value, 0) * 100) / 100,
      duplicatas: toCancel.slice(0, 100),
      truncated: toCancel.length > 100,
    });
  } catch (error) {
    console.error("[dedupe-repasses] Erro:", error);
    return NextResponse.json(
      { error: "Erro", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
