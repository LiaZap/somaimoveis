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
        owner: { select: { name: true } },
      },
      orderBy: { paidAt: "asc" },
    });

    // Agrupa por chave: ownerId + contractId + description + dueDate + value
    const groups: Record<string, typeof entries> = {};
    for (const e of entries) {
      const key = [
        e.ownerId,
        e.contractId || "noContract",
        e.description,
        e.dueDate ? e.dueDate.toISOString().slice(0, 10) : "noDue",
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
      // Mantem a 1a (mais antiga por paidAt)
      const [keep, ...rest] = list;
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
