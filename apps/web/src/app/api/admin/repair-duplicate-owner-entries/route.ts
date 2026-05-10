import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/admin/repair-duplicate-owner-entries?dryRun=true
 *
 * Detecta OwnerEntries duplicadas pelo mesmo `notes.tenantEntryId`
 * (mesmo lancamento de inquilino propagado mais de uma vez ao
 * proprietario). Causa raiz: billing/generate cria a entry e
 * propagate-discounts cria uma segunda — bug de fluxo.
 *
 * Mantém a entry MAIS ANTIGA (createdAt menor) e marca as outras
 * como CANCELADO (em vez de excluir, pra preservar historico).
 *
 * So afeta entries com status=PENDENTE (PAGO ja foi processado).
 *
 * Idempotente. Aceita ?dryRun=true (default false).
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const dryRun = searchParams.get("dryRun") === "true";
    const monthFilter = searchParams.get("month"); // YYYY-MM opcional

    const where: Record<string, unknown> = {
      status: "PENDENTE",
      notes: { contains: "tenantEntryId" }, // narrowing
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
        category: true,
        value: true,
        description: true,
        dueDate: true,
        notes: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // Agrupa por (ownerId, tenantEntryId)
    const byKey: Record<string, typeof entries> = {};
    for (const e of entries) {
      let tid: string | null = null;
      try {
        const n = JSON.parse(e.notes || "{}");
        if (typeof n.tenantEntryId === "string") tid = n.tenantEntryId;
      } catch {}
      if (!tid) continue;
      const key = `${e.ownerId}_${tid}`;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(e);
    }

    const toCancel: { id: string; owner: string; desc: string; value: number; reason: string }[] = [];
    for (const [key, list] of Object.entries(byKey)) {
      if (list.length < 2) continue;
      // Mantém a 1a (mais antiga), cancela as demais
      const [keep, ...rest] = list;
      for (const dupe of rest) {
        toCancel.push({
          id: dupe.id,
          owner: dupe.ownerId,
          desc: dupe.description,
          value: dupe.value,
          reason: `Duplicada de ${keep.id} (mesmo tenantEntryId)`,
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
      cancelados: toCancel.slice(0, 100),
      truncated: toCancel.length > 100,
    });
  } catch (error) {
    console.error("[repair-duplicate-owner-entries] Erro:", error);
    return NextResponse.json(
      { error: "Erro ao reparar duplicatas", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
