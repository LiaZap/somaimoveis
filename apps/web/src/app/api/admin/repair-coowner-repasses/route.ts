import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/admin/repair-coowner-repasses
 *
 * Bug introduzido em 2026-05-08 (sync com auto-fix afrouxado): o
 * /api/repasses/sync atualizava QUALQUER OwnerEntry REPASSE PENDENTE
 * com value cheio do contrato, ignorando o sharePercent dos
 * coproprietarios. Resultado: 1 dos N coproprietarios passou a receber
 * o valor cheio (ex: Carlos eduardo kampf 16.66% recebia R$ 5.850 em
 * vez de R$ 974,61).
 *
 * Este endpoint percorre TODAS as OwnerEntries REPASSE/GARANTIA com
 * description contendo "(X%)" e value divergente do esperado, e
 * restaura o value correto = (aluguelBruto - adminFeeValue) * pct/100.
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
      category: { in: ["REPASSE", "GARANTIA"] },
      status: "PENDENTE",
      description: { contains: "%" },
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
        value: true,
        description: true,
        notes: true,
        ownerId: true,
        contractId: true,
        dueDate: true,
      },
    });

    const fixes: {
      entryId: string;
      ownerId: string;
      contractId: string | null;
      dueDate: string | null;
      sharePercent: number;
      valueAtual: number;
      valueCorreto: number;
      diff: number;
    }[] = [];

    for (const e of entries) {
      // Extrai sharePercent da description "(X%)" ou notes.sharePercent
      let sharePct: number | null = null;
      const descMatch = e.description?.match(/\(([\d.,]+)%\)/);
      if (descMatch) {
        const pct = parseFloat(descMatch[1].replace(",", "."));
        if (Number.isFinite(pct) && pct > 0 && pct < 100) {
          sharePct = pct;
        }
      }
      let aluguelBruto = 0;
      let adminFeeValue = 0;
      if (e.notes) {
        try {
          const n = JSON.parse(e.notes);
          aluguelBruto = typeof n.aluguelBruto === "number" ? n.aluguelBruto : 0;
          adminFeeValue = typeof n.adminFeeValue === "number" ? n.adminFeeValue : 0;
          if (sharePct == null && typeof n.sharePercent === "number" && n.sharePercent < 100) {
            sharePct = n.sharePercent;
          }
        } catch {}
      }

      if (sharePct == null) continue; // nao eh coproprietario
      if (aluguelBruto <= 0) continue; // sem dados pra calcular

      const valueCorreto = Math.round((aluguelBruto - adminFeeValue) * sharePct / 100 * 100) / 100;
      if (Math.abs(e.value - valueCorreto) <= 0.01) continue; // ja certo

      fixes.push({
        entryId: e.id,
        ownerId: e.ownerId,
        contractId: e.contractId,
        dueDate: e.dueDate ? e.dueDate.toISOString() : null,
        sharePercent: sharePct,
        valueAtual: e.value,
        valueCorreto,
        diff: Math.round((e.value - valueCorreto) * 100) / 100,
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
      somaDiff: Math.round(fixes.reduce((s, f) => s + f.diff, 0) * 100) / 100,
      fixes: fixes.slice(0, 100),
      truncated: fixes.length > 100,
    });
  } catch (error) {
    console.error("[repair-coowner-repasses] Erro:", error);
    return NextResponse.json(
      { error: "Erro ao reparar", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
