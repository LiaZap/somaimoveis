import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * POST /api/audit/corrigir-admin-indevida-mes-05
 *
 * Corrige casos onde admin foi cobrada indevidamente quando há intermediação no mês.
 * Regra Léo 13/05/2026: SEMPRE que tem intermediação no mês, admin = 0.
 *
 * Para cada owner afetado:
 *   1. Encontra o entry REPASSE no mes 05/2026
 *   2. Soma o valor da admin indevida ao value (restaura aluguel bruto)
 *   3. Atualiza notes: adminFeeValue=0, adminWaived=true, bankConfirmed=false
 *   4. Adiciona auditTag para rastreabilidade
 *
 * Body: { dryRun?: boolean }
 *
 * Owners detectados (hard-coded por segurança):
 *   1. FORTE PARTICIPACOES LTDA - R$ 540,81
 *   2. Ernani Airton Sad - R$ 385,00 (ou R$ 192,50 dependendo do valor real)
 *   3. Raul Schmidt - R$ 272,37
 *   4. Eder Joel Schmidt - R$ 230,00
 *   5. Clever Jose Rodrigues de Oliveira - R$ 175,00
 *   6. Pedro Vinicius Herberts - R$ 117,03
 *   7. Ardelio Hillesheim - R$ 96,26
 *   8. Karolini Canova Foletto - R$ 84,00
 *   9. Alvaro Erico Wetzel - R$ 66,67
 *   10. Katia Luiza Kuentzer - R$ 19,63
 *   11. Carla Kaempf Louzada - R$ 0,72
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const body = await request.json();
  const dryRun = body.dryRun !== false;

  const monthStart = new Date("2026-05-01T00:00:00Z");
  const monthEnd = new Date("2026-06-01T00:00:00Z");

  // Buscar todos entries REPASSE no mês 5
  const repasses = await prisma.ownerEntry.findMany({
    where: {
      category: "REPASSE",
      type: "CREDITO",
      OR: [
        { dueDate: { gte: monthStart, lt: monthEnd } },
        { AND: [{ dueDate: null }, { paidAt: { gte: monthStart, lt: monthEnd } }] },
      ],
      status: { not: "CANCELADO" },
    },
    include: {
      owner: { select: { id: true, name: true } },
      contract: { select: { code: true, intermediationFee: true } },
    },
  });

  // Para cada repasse, verificar se há intermediação no mês E admin > 0
  const corrected: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  let totalAdminCorrigido = 0;

  for (const r of repasses) {
    try {
      let notes: Record<string, unknown> = {};
      try {
        notes = r.notes ? JSON.parse(r.notes) : {};
      } catch (_) {
        skipped.push({ owner: r.owner.name, repasseId: r.id, reason: "notes não é JSON válido" });
        continue;
      }

      const adminFeeValue = (notes.adminFeeValue as number) || (notes.adminFee as number) || 0;
      const adminFeePercent = (notes.adminFeePercent as number) || 0;
      const adminWaived = notes.adminWaived === true;

      if (adminFeeValue <= 0 || adminWaived) {
        // Já correto
        continue;
      }

      // Verificar se tem intermediação no mês (debit entry INTERMEDIACAO)
      const intermed = await prisma.ownerEntry.findFirst({
        where: {
          ownerId: r.ownerId,
          category: "INTERMEDIACAO",
          type: "DEBITO",
          status: { not: "CANCELADO" },
          OR: [
            { dueDate: { gte: monthStart, lt: monthEnd } },
            { AND: [{ dueDate: null }, { paidAt: { gte: monthStart, lt: monthEnd } }] },
          ],
        },
      });

      if (!intermed || intermed.value <= 0) {
        // Não tem intermediação - admin pode ficar
        continue;
      }

      // ENCONTROU PROBLEMA: tem intermediação E admin > 0
      // Corrigir:
      const valorOriginal = r.value;
      const valorCorrigido = Math.round((valorOriginal + adminFeeValue) * 100) / 100;

      const newNotes = {
        ...notes,
        adminFeeValue: 0,
        adminFee: 0,
        adminWaived: true,
        adminWaivedReason: `Auto-corrigido em 2026-05-14: admin estava sendo cobrada com intermediação (regra Léo)`,
        bankConfirmed: false,
        bankConfirmedAt: null,
        auditTag: "CORRIGIDO_ADMIN_INDEVIDA_2026-05-14",
        valorAntesCorrecao: valorOriginal,
        adminFeeValueAntesCorrecao: adminFeeValue,
        adminFeePercentAntesCorrecao: adminFeePercent,
      };

      if (dryRun) {
        corrected.push({
          dryRun: true,
          owner: r.owner.name,
          contract: r.contract?.code,
          repasseId: r.id,
          valorOriginal,
          valorCorrigido,
          adminIndevida: adminFeeValue,
          intermediacao: intermed.value,
        });
      } else {
        await prisma.ownerEntry.update({
          where: { id: r.id },
          data: {
            value: valorCorrigido,
            notes: JSON.stringify(newNotes),
          },
        });
        corrected.push({
          owner: r.owner.name,
          contract: r.contract?.code,
          repasseId: r.id,
          valorOriginal,
          valorCorrigido,
          adminIndevida: adminFeeValue,
          intermediacao: intermed.value,
        });
      }

      totalAdminCorrigido += adminFeeValue;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push({ owner: r.owner.name, repasseId: r.id, error: errMsg });
    }
  }

  return NextResponse.json({
    dryRun,
    summary: {
      repassesAnalisados: repasses.length,
      corrected: corrected.length,
      skipped: skipped.length,
      errors: errors.length,
      totalAdminCorrigido: Math.round(totalAdminCorrigido * 100) / 100,
    },
    corrected,
    skipped,
    errors,
  });
}
