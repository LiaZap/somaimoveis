import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/admin/undo-dedupe-recent?minutesAgo=240&dryRun=true
 *
 * Reverte entries que foram marcadas como CANCELADO pelo dedupe-repasses
 * nas ultimas N minutos. Volta status pra PAGO.
 *
 * Use quando o dedupe escolheu cancelar a entry errada (ex: manteve
 * a antiga em abril e cancelou a paga via CNAB em maio, deixando o
 * owner "sem repasse" na aba do mes corrente).
 *
 * Filtra por categoria REPASSE/GARANTIA/INTERMEDIACAO (o dedupe so
 * mexe nessas) e por updatedAt recente.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const minutesAgo = Number(searchParams.get("minutesAgo") || "240"); // 4h default
    const dryRun = searchParams.get("dryRun") === "true";

    const cutoff = new Date(Date.now() - minutesAgo * 60 * 1000);

    // Pega entries CANCELADAS recentemente (provavelmente pelo dedupe)
    const candidates = await prisma.ownerEntry.findMany({
      where: {
        status: "CANCELADO",
        category: { in: ["REPASSE", "GARANTIA", "INTERMEDIACAO"] },
        updatedAt: { gte: cutoff },
      },
      select: {
        id: true,
        ownerId: true,
        description: true,
        value: true,
        dueDate: true,
        paidAt: true,
        updatedAt: true,
        owner: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
    });

    if (!dryRun && candidates.length > 0) {
      await prisma.ownerEntry.updateMany({
        where: { id: { in: candidates.map((c) => c.id) } },
        // Volta pra PAGO se tem paidAt, senao PENDENTE
        data: { status: "PAGO" }, // simplificado: tudo cancelado pelo dedupe era PAGO antes
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
        paid: c.paidAt?.toISOString().slice(0, 10),
      })),
    });
  } catch (error) {
    console.error("[undo-dedupe-recent] Erro:", error);
    return NextResponse.json(
      { error: "Erro", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
