import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/admin/repair-coowner-notes-proportional?dryRun=true&month=YYYY-MM
 *
 * Bug 4 da auditoria (corrigido em billing/generate em 9164e92):
 * notes.adminFeeValue, notes.irrfValue e notes.netToOwner em entries
 * REPASSE/GARANTIA de COPROPRIETARIOS (sharePercent < 100) eram
 * gravados com valor CHEIO do contrato, nao proporcional.
 *
 * O fix em billing/generate ja salva valores proporcionais pra
 * entries NOVAS, mas entries antigas continuam com valor cheio.
 * Demonstrativos liam o cheio e geravam IRRF errado (caso CTR-214:
 * R$ 1.575 IRRF do contrato aparecia em cada um dos 3 coproprietarios).
 *
 * Esse endpoint percorre OwnerEntries REPASSE/GARANTIA com
 * sharePercent < 100 e ajusta os valores em notes:
 *   adminFeeValue *= shareRatio
 *   irrfValue *= shareRatio
 *   netToOwner *= shareRatio
 *
 * Idempotente (skip se ja proporcional). Aceita ?dryRun=true.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const dryRun = searchParams.get("dryRun") === "true";
    const monthFilter = searchParams.get("month");

    const where: Record<string, unknown> = {
      category: { in: ["REPASSE", "GARANTIA"] },
      status: { not: "CANCELADO" },
    };
    if (monthFilter && /^\d{4}-\d{2}$/.test(monthFilter)) {
      const [y, m] = monthFilter.split("-").map(Number);
      where.dueDate = { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) };
    }

    const entries = await prisma.ownerEntry.findMany({
      where,
      select: { id: true, value: true, description: true, notes: true, ownerId: true, dueDate: true,
        owner: { select: { name: true } } },
    });

    const fixes: Array<{
      id: string; ownerName: string; desc: string;
      sharePercent: number; before: any; after: any;
    }> = [];

    for (const e of entries) {
      if (!e.notes) continue;
      let n: any = {};
      try { n = JSON.parse(e.notes); } catch { continue; }

      // Descobre sharePercent: notes.sharePercent OU "(X%)" na description
      let sharePct: number | null = null;
      if (typeof n.sharePercent === "number" && n.sharePercent > 0 && n.sharePercent < 100) {
        sharePct = n.sharePercent;
      } else if (e.description) {
        const m = e.description.match(/\(([\d.,]+)%\)/);
        if (m) {
          const pct = parseFloat(m[1].replace(",", "."));
          if (Number.isFinite(pct) && pct > 0 && pct < 100) sharePct = pct;
        }
      }
      if (sharePct === null) continue; // nao e coproprietario

      const shareRatio = sharePct / 100;
      const before = {
        adminFeeValue: n.adminFeeValue,
        irrfValue: n.irrfValue,
        netToOwner: n.netToOwner,
      };

      // Heuristica: se adminFeeValue / value > 0.5, e quase certo que adminFeeValue
      // esta cheio (proporcional do owner seria muito menor).
      // Ou: se algum dos campos eh > value (= netToOwner do owner),
      // tem valor cheio.
      const isProbablyCheio = (
        (typeof n.adminFeeValue === "number" && n.adminFeeValue > e.value) ||
        (typeof n.irrfValue === "number" && n.irrfValue > e.value) ||
        (typeof n.netToOwner === "number" && Math.abs(n.netToOwner - e.value) > 1)
      );

      if (!isProbablyCheio) continue; // ja parece proporcional ou nao tem campos

      const newNotes = {
        ...n,
        adminFeeValue: typeof n.adminFeeValue === "number"
          ? Math.round(n.adminFeeValue * shareRatio * 100) / 100
          : n.adminFeeValue,
        irrfValue: typeof n.irrfValue === "number"
          ? Math.round(n.irrfValue * shareRatio * 100) / 100
          : n.irrfValue,
        netToOwner: typeof n.netToOwner === "number"
          ? Math.round(n.netToOwner * shareRatio * 100) / 100
          : n.netToOwner,
        notesRepairedAt: new Date().toISOString(),
      };

      fixes.push({
        id: e.id,
        ownerName: e.owner?.name || "?",
        desc: e.description,
        sharePercent: sharePct,
        before,
        after: {
          adminFeeValue: newNotes.adminFeeValue,
          irrfValue: newNotes.irrfValue,
          netToOwner: newNotes.netToOwner,
        },
      });

      if (!dryRun) {
        await prisma.ownerEntry.update({
          where: { id: e.id },
          data: { notes: JSON.stringify(newNotes) },
        });
      }
    }

    return NextResponse.json({
      mode: dryRun ? "DRY_RUN" : "APPLIED",
      total: fixes.length,
      fixes: fixes.slice(0, 100),
      truncated: fixes.length > 100,
    });
  } catch (error) {
    console.error("[repair-coowner-notes-proportional] Erro:", error);
    return NextResponse.json(
      { error: "Erro", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
