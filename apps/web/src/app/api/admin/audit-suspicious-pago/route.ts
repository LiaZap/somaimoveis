import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * GET  /api/admin/audit-suspicious-pago?gapDays=90
 * POST /api/admin/audit-suspicious-pago?gapDays=90&dryRun=true
 *
 * Lista (GET) ou reverte (POST) OwnerEntries marcadas como PAGO
 * com gap muito grande entre dueDate e paidAt. Isso indica que
 * uma entry antiga foi marcada PAGO em massa por engano — geralmente
 * porque o batch PATCH /api/repasses pega entries do owner inteiro
 * em vez de so do mes selecionado.
 *
 * Cenario real (caso George Mundstock):
 *  - Entries de 05/2025 e 06/2025 ficaram PENDENTES por 1 ano.
 *  - Quando admin marcou repasse de maio/2026 como PAGO via CNAB,
 *    essas entries antigas foram marcadas PAGO em 11/05/2026.
 *  - Demonstrativo de maio/2026 agora soma elas (pelo filtro paidAt),
 *    inflando o totalLiquido.
 *
 * gapDays default: 90 (3 meses de gap considerado suspeito).
 * Aceita ?dryRun=true (default false) no POST.
 */

async function findSuspicious(gapDays: number) {
  const entries = await prisma.ownerEntry.findMany({
    where: {
      status: "PAGO",
      paidAt: { not: null },
      dueDate: { not: null },
    },
    select: {
      id: true,
      ownerId: true,
      description: true,
      type: true,
      category: true,
      value: true,
      dueDate: true,
      paidAt: true,
      owner: { select: { name: true } },
    },
  });

  const gapMs = gapDays * 24 * 60 * 60 * 1000;
  const suspicious = entries
    .filter((e) => {
      if (!e.dueDate || !e.paidAt) return false;
      const gap = e.paidAt.getTime() - e.dueDate.getTime();
      return gap > gapMs;
    })
    .map((e) => ({
      id: e.id,
      ownerName: e.owner?.name || "?",
      ownerId: e.ownerId,
      type: e.type,
      category: e.category,
      desc: e.description,
      value: e.value,
      dueDate: e.dueDate!.toISOString().slice(0, 10),
      paidAt: e.paidAt!.toISOString(),
      gapDays: Math.round((e.paidAt!.getTime() - e.dueDate!.getTime()) / (24 * 60 * 60 * 1000)),
    }));

  return suspicious.sort((a, b) => b.gapDays - a.gapDays);
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const gapDays = Number(searchParams.get("gapDays") || "90");
    const suspicious = await findSuspicious(gapDays);
    return NextResponse.json({
      gapDays,
      total: suspicious.length,
      somaValor: Math.round(suspicious.reduce((s, x) => s + x.value, 0) * 100) / 100,
      suspicious: suspicious.slice(0, 200),
      truncated: suspicious.length > 200,
    });
  } catch (error) {
    console.error("[audit-suspicious-pago] Erro:", error);
    return NextResponse.json(
      { error: "Erro", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const gapDays = Number(searchParams.get("gapDays") || "90");
    const dryRun = searchParams.get("dryRun") === "true";

    const suspicious = await findSuspicious(gapDays);

    if (!dryRun && suspicious.length > 0) {
      await prisma.ownerEntry.updateMany({
        where: { id: { in: suspicious.map((s) => s.id) } },
        data: { status: "PENDENTE", paidAt: null },
      });
    }

    return NextResponse.json({
      mode: dryRun ? "DRY_RUN" : "APPLIED",
      gapDays,
      total: suspicious.length,
      somaValor: Math.round(suspicious.reduce((s, x) => s + x.value, 0) * 100) / 100,
      reverted: suspicious.slice(0, 200),
    });
  } catch (error) {
    console.error("[audit-suspicious-pago] Erro:", error);
    return NextResponse.json(
      { error: "Erro", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
