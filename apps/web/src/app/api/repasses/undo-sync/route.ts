import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * DELETE /api/repasses/undo-sync?month=YYYY-MM
 * Apaga OwnerEntries PENDENTE que foram criadas pela rotina de sync
 * anterior (marcadas com notes.syncedFromTenant === true).
 * Util para reverter uma sincronizacao que duplicou lancamentos
 * historicos.
 *
 * NUNCA apaga OwnerEntries PAGO, CANCELADO ou que nao sao auto-sync.
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const monthStr = searchParams.get("month");
    const allMonths = searchParams.get("all") === "true";

    let whereDate: any = undefined;
    let monthLabel = "todos os meses";

    if (!allMonths) {
      if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
        return NextResponse.json(
          { error: "month obrigatorio no formato YYYY-MM (ou use ?all=true)" },
          { status: 400 }
        );
      }
      const [y, m] = monthStr.split("-").map(Number);
      const monthStart = new Date(y, m - 1, 1);
      const monthEnd = new Date(y, m, 0, 23, 59, 59, 999);
      whereDate = { gte: monthStart, lte: monthEnd };
      monthLabel = `${String(m).padStart(2, "0")}/${y}`;
    }

    // Buscar candidatos: OwnerEntries PENDENTE com notes contendo syncedFromTenant
    // Como notes e string JSON, filtramos no prisma por 'contains' e depois parse
    const candidatos = await prisma.ownerEntry.findMany({
      where: {
        status: "PENDENTE",
        ...(whereDate ? { dueDate: whereDate } : {}),
        notes: { contains: "syncedFromTenant" },
      },
      select: {
        id: true,
        description: true,
        value: true,
        type: true,
        notes: true,
        dueDate: true,
      },
    });

    // Parse dos notes para confirmar syncedFromTenant === true
    const toDelete: string[] = [];
    const preview: {
      id: string;
      description: string;
      value: number;
      type: string;
    }[] = [];
    for (const c of candidatos) {
      if (!c.notes) continue;
      try {
        const n = JSON.parse(c.notes);
        if (n.syncedFromTenant === true) {
          toDelete.push(c.id);
          preview.push({
            id: c.id,
            description: c.description,
            value: c.value,
            type: c.type,
          });
        }
      } catch {
        // ignore
      }
    }

    // Preview mode: ?dryRun=true nao apaga, so retorna a lista
    if (searchParams.get("dryRun") === "true") {
      return NextResponse.json({
        month: monthLabel,
        total: toDelete.length,
        preview,
      });
    }

    if (toDelete.length === 0) {
      return NextResponse.json({
        month: monthLabel,
        removidos: 0,
        mensagem: "Nenhum lancamento auto-criado pelo sync foi encontrado.",
      });
    }

    const result = await prisma.ownerEntry.deleteMany({
      where: { id: { in: toDelete } },
    });

    return NextResponse.json({
      month: monthLabel,
      removidos: result.count,
      mensagem: `${result.count} lancamento(s) auto-criado(s) pelo sync foram removidos.`,
      preview,
    });
  } catch (error) {
    console.error("[Repasses Undo-Sync]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao desfazer sync" },
      { status: 500 }
    );
  }
}
