import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * POST /api/audit/desfazer-duplicatas-mes-05
 *
 * Cancela OwnerEntries criadas pelo batch criar-faltantes-mes-05 que se
 * mostraram duplicatas de entries que o usuario marcou PAGO manualmente.
 *
 * Estrategia:
 * 1. Listar todos OwnerEntries com auditTag = MES05_FALTANTES_2026-05-14
 * 2. Para cada um, buscar IRMA (mesmo owner+category+type+value) com paidAt
 *    no mes 05/2026 que NAO tenha o mesmo auditTag
 * 3. Se houver irma -> CANCELAR a entry criada por mim (manter a do usuario)
 * 4. Se NAO houver irma -> manter (e legitima)
 *
 * Body: { dryRun?: boolean }
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const body = await request.json();
  const dryRun = body.dryRun !== false;

  // 1. Buscar todos os auditados (criados pelo batch)
  const auditados = await prisma.ownerEntry.findMany({
    where: {
      notes: { contains: "MES05_FALTANTES_2026-05-14" },
      status: { not: "CANCELADO" },
    },
    include: {
      owner: { select: { id: true, name: true } },
    },
  });

  const cancelados: Array<Record<string, unknown>> = [];
  const mantidos: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];

  const monthStart = new Date("2026-05-01T00:00:00Z");
  const monthEnd = new Date("2026-06-01T00:00:00Z");

  for (const a of auditados) {
    try {
      // Buscar irmas (mesma identificacao, sem auditTag)
      const irmas = await prisma.ownerEntry.findMany({
        where: {
          id: { not: a.id },
          ownerId: a.ownerId,
          category: a.category,
          type: a.type,
          value: a.value,
          status: { not: "CANCELADO" },
          OR: [
            { dueDate: { gte: monthStart, lt: monthEnd } },
            { paidAt: { gte: monthStart, lt: monthEnd } },
          ],
          NOT: {
            notes: { contains: "MES05_FALTANTES_2026-05-14" },
          },
        },
      });

      if (irmas.length > 0) {
        // E duplicata - cancelar o que criei
        const newNotes = JSON.stringify({
          ...(a.notes ? JSON.parse(a.notes) : {}),
          canceladoEm: new Date().toISOString(),
          canceladoMotivo: "Duplicata detectada apos batch - irma marcada PAGO pelo usuario",
          irmaIds: irmas.map((i) => i.id),
          auditTag: "CANCELADO_DUPLICATA_MES05_2026-05-14",
        });

        if (dryRun) {
          cancelados.push({
            dryRun: true,
            id: a.id,
            owner: a.owner.name,
            category: a.category,
            value: a.value,
            description: a.description,
            irmas: irmas.length,
            irmaIds: irmas.map((i) => i.id),
          });
        } else {
          await prisma.ownerEntry.update({
            where: { id: a.id },
            data: { status: "CANCELADO", notes: newNotes },
          });
          cancelados.push({
            id: a.id,
            owner: a.owner.name,
            category: a.category,
            value: a.value,
            description: a.description,
            irmas: irmas.length,
          });
        }
      } else {
        mantidos.push({
          id: a.id,
          owner: a.owner.name,
          category: a.category,
          value: a.value,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push({ id: a.id, owner: a.owner.name, error: errMsg });
    }
  }

  return NextResponse.json({
    dryRun,
    summary: {
      totalAuditados: auditados.length,
      cancelados: cancelados.length,
      mantidos: mantidos.length,
      errors: errors.length,
    },
    cancelados,
    mantidos,
    errors,
  });
}
