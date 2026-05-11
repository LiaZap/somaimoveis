import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/admin/sync-debitos-com-repasse?month=YYYY-MM&dryRun=true
 *
 * Para cada owner cujo REPASSE/GARANTIA do mes esta PAGO, marca
 * todos os DEBITOs PENDENTES do mesmo (ownerId, mes) tambem como
 * PAGO. Aplica a regra do Leo: "quando o repasse e marcado pago,
 * os debitos que foram descontados dele tambem devem aparecer
 * como pagos".
 *
 * Existe lógica similar no PATCH /api/repasses, mas casos antigos
 * (reverts, marcações manuais) podem ter ficado fora de sync.
 * Esse endpoint normaliza.
 *
 * Idempotente. Aceita ?dryRun=true (default false).
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const dryRun = searchParams.get("dryRun") === "true";
    const monthStr = searchParams.get("month");

    let targetYear: number, targetMonth: number;
    if (monthStr && /^\d{4}-\d{2}$/.test(monthStr)) {
      const [y, m] = monthStr.split("-").map(Number);
      targetYear = y;
      targetMonth = m - 1;
    } else {
      const now = new Date();
      targetYear = now.getFullYear();
      targetMonth = now.getMonth();
    }

    const monthStart = new Date(targetYear, targetMonth, 1);
    const monthEnd = new Date(targetYear, targetMonth + 1, 1);

    // Pega REPASSEs/GARANTIAs PAGOs do mes
    const repassesPagos = await prisma.ownerEntry.findMany({
      where: {
        category: { in: ["REPASSE", "GARANTIA"] },
        status: "PAGO",
        dueDate: { gte: monthStart, lt: monthEnd },
      },
      select: { id: true, ownerId: true, paidAt: true, owner: { select: { name: true } } },
    });

    // Pega ownerIds com REPASSE PAGO no mes
    const ownerIdsComRepassePago = [...new Set(repassesPagos.map((r) => r.ownerId))];

    // Pega DEBITOs PENDENTES desses owners com dueDate no mes
    const debitosPendentes = await prisma.ownerEntry.findMany({
      where: {
        type: "DEBITO",
        status: "PENDENTE",
        ownerId: { in: ownerIdsComRepassePago },
        dueDate: { gte: monthStart, lt: monthEnd },
      },
      select: {
        id: true,
        ownerId: true,
        description: true,
        value: true,
        dueDate: true,
        category: true,
        owner: { select: { name: true } },
      },
    });

    const summary = debitosPendentes.map((d) => ({
      id: d.id,
      ownerName: d.owner?.name,
      desc: d.description,
      value: d.value,
      dueDate: d.dueDate?.toISOString().slice(0, 10),
      category: d.category,
    }));

    if (!dryRun && debitosPendentes.length > 0) {
      // Usa o paidAt do repasse correspondente do owner (mais consistente)
      const ownerPaidAt: Record<string, Date> = {};
      for (const r of repassesPagos) {
        if (r.paidAt && (!ownerPaidAt[r.ownerId] || r.paidAt > ownerPaidAt[r.ownerId])) {
          ownerPaidAt[r.ownerId] = r.paidAt;
        }
      }
      const now = new Date();
      for (const d of debitosPendentes) {
        await prisma.ownerEntry.update({
          where: { id: d.id },
          data: {
            status: "PAGO",
            paidAt: ownerPaidAt[d.ownerId] || now,
          },
        });
      }
    }

    return NextResponse.json({
      mode: dryRun ? "DRY_RUN" : "APPLIED",
      mes: `${String(targetMonth + 1).padStart(2, "0")}/${targetYear}`,
      ownersComRepassePago: ownerIdsComRepassePago.length,
      totalDebitosMarcados: debitosPendentes.length,
      somaValor: Math.round(debitosPendentes.reduce((s, d) => s + d.value, 0) * 100) / 100,
      debitos: summary.slice(0, 200),
    });
  } catch (error) {
    console.error("[sync-debitos-com-repasse] Erro:", error);
    return NextResponse.json(
      { error: "Erro", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
