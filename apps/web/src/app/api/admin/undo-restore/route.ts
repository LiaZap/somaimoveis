import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/admin/undo-restore?minutesAgo=30&dryRun=true
 *
 * Cancela OwnerEntries criadas nos ultimos N minutos.
 * Use pra reverter o restore-missing-owner-entries que criou parcelas
 * indevidas (ex: IPTU 1/5, 2/5, 3/5... futuras).
 *
 * So mexe em status=PENDENTE — preserva PAGO/CANCELADO.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const minutesAgo = Number(searchParams.get("minutesAgo") || "30");
    const dryRun = searchParams.get("dryRun") === "true";
    const cutoff = new Date(Date.now() - minutesAgo * 60 * 1000);

    const candidates = await prisma.ownerEntry.findMany({
      where: {
        status: "PENDENTE",
        createdAt: { gte: cutoff },
      },
      select: { id: true, description: true, value: true, dueDate: true, createdAt: true, owner: { select: { name: true } } },
    });

    if (!dryRun && candidates.length > 0) {
      await prisma.ownerEntry.updateMany({
        where: { id: { in: candidates.map((c) => c.id) } },
        data: { status: "CANCELADO" },
      });
    }

    return NextResponse.json({
      mode: dryRun ? "DRY_RUN" : "APPLIED",
      cutoff: cutoff.toISOString(),
      total: candidates.length,
      somaValor: Math.round(candidates.reduce((s, c) => s + c.value, 0) * 100) / 100,
      sample: candidates.slice(0, 20).map((c) => ({
        owner: c.owner?.name,
        desc: c.description,
        value: c.value,
        due: c.dueDate?.toISOString().slice(0, 10),
        createdAt: c.createdAt?.toISOString().slice(0, 16),
      })),
    });
  } catch (error) {
    console.error("[undo-restore] Erro:", error);
    return NextResponse.json(
      { error: "Erro", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
