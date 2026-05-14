import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * POST /api/audit/cancelar-seguro-fianca-batch
 *
 * Cancela todos os OwnerEntries de SEGURO_FIANCA criados pelo batch
 * criar-faltantes-mes-05 (auditTag = MES05_FALTANTES_2026-05-14).
 *
 * Motivo (Léo): seguro fiança vai DIRETO à seguradora (terceiro), não passa
 * pelo proprietário. Como crédito ao owner é incorreto.
 *
 * Body: { dryRun?: boolean }
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const body = await request.json();
  const dryRun = body.dryRun !== false;

  const segurosFianca = await prisma.ownerEntry.findMany({
    where: {
      category: "SEGURO_FIANCA",
      notes: { contains: "MES05_FALTANTES_2026-05-14" },
      status: { not: "CANCELADO" },
    },
    include: {
      owner: { select: { id: true, name: true } },
    },
  });

  const cancelados: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  let totalCancelado = 0;

  for (const e of segurosFianca) {
    try {
      const newNotes = JSON.stringify({
        ...(e.notes ? JSON.parse(e.notes) : {}),
        canceladoEm: new Date().toISOString(),
        canceladoMotivo:
          "Léo 14/05/2026: Seguro fiança vai direto à seguradora (terceiro), não é repasse ao proprietário",
        auditTag: "CANCELADO_SEGURO_FIANCA_TERCEIRO_2026-05-14",
        destinoCorreto: "TERCEIRO",
      });

      if (dryRun) {
        cancelados.push({
          dryRun: true,
          id: e.id,
          owner: e.owner.name,
          value: e.value,
          desc: e.description,
        });
      } else {
        await prisma.ownerEntry.update({
          where: { id: e.id },
          data: { status: "CANCELADO", notes: newNotes },
        });
        cancelados.push({
          id: e.id,
          owner: e.owner.name,
          value: e.value,
        });
      }
      totalCancelado += e.value;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push({ id: e.id, owner: e.owner.name, error: errMsg });
    }
  }

  return NextResponse.json({
    dryRun,
    summary: {
      encontrados: segurosFianca.length,
      cancelados: cancelados.length,
      errors: errors.length,
      totalCancelado: Math.round(totalCancelado * 100) / 100,
    },
    cancelados,
    errors,
  });
}
