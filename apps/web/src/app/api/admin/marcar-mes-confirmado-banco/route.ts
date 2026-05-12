import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/admin/marcar-mes-confirmado-banco?month=YYYY-MM&dryRun=true
 *
 * Marca todos os REPASSE/GARANTIA + IPTU + outros CREDITOs do mes como:
 *   - status=PAGO
 *   - paidAt=hoje (se ainda nao tem)
 *   - notes.bankConfirmed=true
 *   - notes.bankConfirmedManually=true
 *
 * Tambem auto-marca os DEBITOs PENDENTES do mesmo mes como PAGO
 * (lei do Leo: se foi descontado do repasse, ja foi processado).
 *
 * Use quando os repasses do mes foram feitos MANUALMENTE no banco
 * (caso classico: Sicredi via portal, sem .RET pra importar).
 * Reunião 12/05/2026: necessario pra "limpar" o historico de abril/2026
 * que foi processado manual pelo Leo.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const monthStr = searchParams.get("month");
    const dryRun = searchParams.get("dryRun") === "true";

    if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
      return NextResponse.json({ error: "month=YYYY-MM obrigatorio" }, { status: 400 });
    }

    const [y, m] = monthStr.split("-").map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 1);

    // Busca todas as entries do mes (CANCELADO de fora)
    // Tag de referencia do mes (ex: "04/2026") usada na description
    // de entries de IPTU/condominio/etc. Isso permite pegar entries
    // que se referem ao mes mas tem dueDate em outro (ex: IPTU 04/2026
    // vencendo em 05/05/2026).
    const mmRef = String(m).padStart(2, "0");
    const yyRef = String(y);
    const refTag = `${mmRef}/${yyRef}`;
    // Janela ampla de dueDate pra capturar entries adjacentes
    const dueDateMin = new Date(monthStart);
    dueDateMin.setMonth(dueDateMin.getMonth() - 2);
    const dueDateMax = new Date(monthEnd);
    dueDateMax.setMonth(dueDateMax.getMonth() + 2);

    const entries = await prisma.ownerEntry.findMany({
      where: {
        status: { not: "CANCELADO" },
        OR: [
          // Entries com dueDate no mes alvo
          { dueDate: { gte: monthStart, lt: monthEnd } },
          // Entries cuja description contem a tag do mes (ex: "04/2026"),
          // com dueDate dentro de janela de +/- 2 meses (evita pegar
          // entries de outros anos com tag similar).
          {
            AND: [
              { description: { contains: refTag } },
              { dueDate: { gte: dueDateMin, lt: dueDateMax } },
            ],
          },
        ],
      },
      select: {
        id: true,
        ownerId: true,
        type: true,
        category: true,
        description: true,
        value: true,
        status: true,
        notes: true,
        paidAt: true,
        owner: { select: { name: true } },
      },
    });

    const now = new Date();
    let totalMarcadoPago = 0;
    let totalConfirmados = 0;

    const planejados = entries.map((e) => {
      let notesObj: Record<string, unknown> = {};
      try { notesObj = JSON.parse(e.notes || "{}"); } catch {}
      const jaConfirmado = notesObj.bankConfirmed === true;
      const jaPago = e.status === "PAGO";
      return {
        id: e.id,
        ownerName: e.owner?.name,
        type: e.type,
        category: e.category,
        desc: e.description,
        value: e.value,
        statusAtual: e.status,
        jaConfirmado,
        marcarPago: !jaPago,
        marcarConfirmado: !jaConfirmado,
      };
    });

    if (!dryRun) {
      for (const p of planejados) {
        if (!p.marcarPago && !p.marcarConfirmado) continue;
        const entry = entries.find((e) => e.id === p.id)!;
        let notesObj: Record<string, unknown> = {};
        try { notesObj = JSON.parse(entry.notes || "{}"); } catch {}
        const updateData: Record<string, unknown> = {};
        if (p.marcarPago) {
          updateData.status = "PAGO";
          if (!entry.paidAt) updateData.paidAt = now;
          totalMarcadoPago++;
        }
        if (p.marcarConfirmado) {
          notesObj.bankConfirmed = true;
          notesObj.bankConfirmedAt = now.toISOString();
          notesObj.bankConfirmedManually = true;
          notesObj.bankConfirmedReason = `Mes ${monthStr} - marcacao em massa (repasses manuais via banco)`;
          updateData.notes = JSON.stringify(notesObj);
          totalConfirmados++;
        }
        await prisma.ownerEntry.update({
          where: { id: p.id },
          data: updateData,
        });
      }
    } else {
      totalMarcadoPago = planejados.filter((p) => p.marcarPago).length;
      totalConfirmados = planejados.filter((p) => p.marcarConfirmado).length;
    }

    return NextResponse.json({
      mode: dryRun ? "DRY_RUN" : "APPLIED",
      mes: monthStr,
      totalEntries: entries.length,
      marcadosPago: totalMarcadoPago,
      confirmadosBanco: totalConfirmados,
      somaValor: Math.round(entries.reduce((s, e) => s + e.value, 0) * 100) / 100,
      sample: planejados.slice(0, 20),
    });
  } catch (error) {
    console.error("[marcar-mes-confirmado-banco] Erro:", error);
    return NextResponse.json(
      { error: "Erro", details: error instanceof Error ? error.message : "desconhecido" },
      { status: 500 }
    );
  }
}
