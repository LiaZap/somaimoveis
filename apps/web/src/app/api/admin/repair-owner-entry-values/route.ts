import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/admin/repair-owner-entry-values
 *
 * Repara OwnerEntries de coproprietarios cujo `value` foi sobrescrito por
 * engano com o netToOwner TOTAL (em vez da parcela de cada coproprietario).
 * O bug foi introduzido em consolidate-irrf antes do fix de 2026-05-08.
 *
 * Algoritmo:
 *   - Para cada OwnerEntry REPASSE/GARANTIA com notes.sharePercent < 100:
 *     value_correto = (notes.aluguelBruto - notes.adminFeeValue) * sharePercent / 100
 *   - Se o value atual for diferente, restaura.
 *
 * Idempotente: rodar duas vezes nao causa efeito.
 *
 * Body: { dryRun?: boolean, month?: "YYYY-MM" }
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const body = await request.json().catch(() => ({}));
    const dryRun = body.dryRun === true;
    const monthFilter: string | undefined = body.month;

    const where: Record<string, unknown> = {
      category: { in: ["REPASSE", "GARANTIA"] },
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
      select: { id: true, value: true, notes: true, ownerId: true, dueDate: true },
    });

    const fixes: {
      entryId: string;
      ownerId: string;
      dueDate: string | null;
      sharePercent: number;
      valueAtual: number;
      valueCorreto: number;
    }[] = [];

    for (const e of entries) {
      if (!e.notes) continue;
      let notes: Record<string, unknown>;
      try {
        notes = JSON.parse(e.notes);
      } catch {
        continue;
      }
      const sharePct = typeof notes.sharePercent === "number" ? notes.sharePercent : 100;
      if (sharePct >= 100) continue;
      const aluguelBruto = typeof notes.aluguelBruto === "number" ? notes.aluguelBruto : 0;
      const adminFeeValue = typeof notes.adminFeeValue === "number" ? notes.adminFeeValue : 0;
      if (aluguelBruto <= 0) continue;

      const valueCorreto = Math.round(((aluguelBruto - adminFeeValue) * sharePct / 100) * 100) / 100;
      // Tolerancia de 1 centavo para evitar updates no-op por arredondamento
      if (Math.abs(e.value - valueCorreto) <= 0.01) continue;

      fixes.push({
        entryId: e.id,
        ownerId: e.ownerId,
        dueDate: e.dueDate ? e.dueDate.toISOString() : null,
        sharePercent: sharePct,
        valueAtual: e.value,
        valueCorreto,
      });
    }

    if (!dryRun) {
      for (const f of fixes) {
        await prisma.ownerEntry.update({
          where: { id: f.entryId },
          data: { value: f.valueCorreto },
        });
      }
    }

    return NextResponse.json({
      mode: dryRun ? "DRY_RUN" : "APPLIED",
      total: fixes.length,
      fixes: fixes.slice(0, 50),
      truncated: fixes.length > 50,
    });
  } catch (error) {
    console.error("[repair-owner-entry-values] Erro:", error);
    return NextResponse.json(
      { error: "Erro ao reparar values", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
