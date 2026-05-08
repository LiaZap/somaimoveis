import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * POST /api/repasses/sync?month=YYYY-MM
 * Sincroniza os repasses para TODOS os pagamentos do mes (PAGO, PENDENTE,
 * ATRASADO, PARCIAL) que ainda nao tem uma OwnerEntry REPASSE correspondente.
 * O REPASSE e criado com status PENDENTE — quando o boleto nao estiver
 * PAGO, a UI mostra os badges "Boleto nao pago"/"Boleto vencido" (Fase 1).
 * Util pra corrigir contratos cujo billing/generate falhou silenciosamente
 * ou cujo Payment foi criado por fluxos manuais.
 *
 * Apenas ADMIN — acao destrutiva (cria registros).
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
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
    const monthEnd = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59, 999);

    // Buscar TODOS os pagamentos do mes (qualquer status exceto CANCELADO)
    // O REPASSE e criado como PENDENTE; o badge da UI reflete o paymentStatus.
    const payments = await prisma.payment.findMany({
      where: {
        status: { not: "CANCELADO" },
        dueDate: { gte: monthStart, lte: monthEnd },
      },
      select: {
        id: true,
        code: true,
        contractId: true,
        ownerId: true,
        dueDate: true,
        value: true,
        splitOwnerValue: true,
        splitAdminValue: true,
        netToOwner: true,
        irrfValue: true,
        irrfRate: true,
      },
    });

    let criados = 0;
    const detalhes: { payment: string; result: string }[] = [];

    for (const p of payments) {
      if (!p.contractId || !p.ownerId || !p.dueDate) continue;

      // Buscar contrato primeiro para ter rentalValue e adminFee corretos
      const contract = await prisma.contract.findUnique({
        where: { id: p.contractId },
        select: {
          code: true,
          rentalValue: true,
          adminFeePercent: true,
          propertyId: true,
          startDate: true,
          endDate: true,
        },
      });

      if (!contract) {
        detalhes.push({ payment: p.code, result: "Contrato nao encontrado, ignorado" });
        continue;
      }

      // Pro-rata: se o boleto cai no primeiro/ultimo mes do contrato, o
      // valor real cobrado do inquilino e proporcional aos dias. O sync
      // PRECISA replicar essa logica — antes usava rentalValue cheio e
      // gerava REPASSE divergente do que o boleto cobrou (caso CTR-137:
      // Aluguel 15/30 dias = R$ 1.925, mas REPASSE estava R$ 3.465).
      const refDate = p.dueDate;
      const refY = refDate.getFullYear();
      const refM = refDate.getMonth();
      const csY = contract.startDate.getFullYear();
      const csM = contract.startDate.getMonth();
      const csDay = contract.startDate.getDate();
      const ceY = contract.endDate.getFullYear();
      const ceM = contract.endDate.getMonth();
      const ceDay = contract.endDate.getDate();
      const isFirstMonth = csY === refY && csM === refM;
      const isLastMonth = ceY === refY && ceM === refM;
      let prorataDays = 30;
      let isProrata = false;
      if (isFirstMonth && csDay > 1) {
        isProrata = true;
        prorataDays = 30 - csDay + 1;
      } else if (isLastMonth && ceDay < 30) {
        isProrata = true;
        prorataDays = ceDay;
      }
      const dailyRate = contract.rentalValue / 30;
      const prorataRentalValue = isProrata
        ? Math.round(dailyRate * prorataDays * 100) / 100
        : contract.rentalValue;

      // Calcular valor do repasse com base no aluguel pro-rata (nao cheio).
      const adminPct = contract.adminFeePercent || 10;
      const adminFeeValue = Math.round(prorataRentalValue * (adminPct / 100) * 100) / 100;
      const calculatedOwnerValue = Math.round((prorataRentalValue - adminFeeValue) * 100) / 100;

      // Preferir splitOwnerValue do pagamento se existir (foi calculado corretamente em billing/generate)
      const splitValue = p.splitOwnerValue ?? 0;
      const ownerValue = splitValue > 0 ? splitValue : calculatedOwnerValue;

      if (ownerValue <= 0) {
        detalhes.push({ payment: p.code, result: "Valor do repasse zerado, ignorado" });
        continue;
      }

      const existing = await prisma.ownerEntry.findFirst({
        where: {
          contractId: p.contractId,
          dueDate: p.dueDate,
          category: "REPASSE",
        },
      });

      // Se ja existe, verificar se foi auto-criado com valor errado e pode ser corrigido
      if (existing) {
        // So atualiza se: foi auto-criado, esta PENDENTE, e o valor atual difere do correto
        let canAutoFix = false;
        if (existing.status === "PENDENTE" && existing.notes) {
          try {
            const n = JSON.parse(existing.notes);
            if (n.autoCreated === true) {
              canAutoFix = Math.abs(existing.value - ownerValue) > 0.01;
            }
          } catch {
            // ignore
          }
        }

        if (canAutoFix) {
          const notesData = {
            aluguelBruto: prorataRentalValue,
            aluguelOriginal: isProrata ? contract.rentalValue : undefined,
            isProrata,
            prorataDias: isProrata ? prorataDays : undefined,
            adminFeePercent: adminPct,
            adminFeeValue,
            irrfValue: p.irrfValue || undefined,
            irrfRate: p.irrfRate || undefined,
            netToOwner: p.netToOwner || ownerValue,
            autoCreated: true,
            syncedFromPayment: p.code,
            recalculated: true,
          };
          await prisma.ownerEntry.update({
            where: { id: existing.id },
            data: { value: ownerValue, notes: JSON.stringify(notesData) },
          });
          detalhes.push({
            payment: p.code,
            result: `Repasse recalculado: R$ ${existing.value.toFixed(2)} -> R$ ${ownerValue.toFixed(2)}`,
          });
          criados++;
        }
        continue;
      }

      const d = new Date(p.dueDate);
      const mLabel = `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

      const notesData = {
        aluguelBruto: prorataRentalValue,
        aluguelOriginal: isProrata ? contract.rentalValue : undefined,
        isProrata,
        prorataDias: isProrata ? prorataDays : undefined,
        adminFeePercent: adminPct,
        adminFeeValue,
        irrfValue: p.irrfValue || undefined,
        irrfRate: p.irrfRate || undefined,
        netToOwner: p.netToOwner || ownerValue,
        autoCreated: true,
        syncedFromPayment: p.code,
      };

      await prisma.ownerEntry.create({
        data: {
          type: "CREDITO",
          category: "REPASSE",
          description: `Repasse aluguel ${mLabel} - ${contract.code || p.contractId}`,
          value: ownerValue,
          dueDate: p.dueDate,
          status: "PENDENTE",
          ownerId: p.ownerId,
          contractId: p.contractId,
          propertyId: contract.propertyId || null,
          notes: JSON.stringify(notesData),
        },
      });

      criados++;
      detalhes.push({ payment: p.code, result: `Repasse criado: R$ ${ownerValue.toFixed(2)}` });
    }


    // NOTA: a propagacao automatica de TenantEntries com destination=PROPRIETARIO
    // foi REMOVIDA deste endpoint. Era fonte de duplicacao e dificil de
    // tornar confiavel para casos variados. Para adicionar debitos/creditos
    // no proprietario, use o botao 'Novo Lancamento' na pagina /repasses.

    return NextResponse.json({
      month: `${String(targetMonth + 1).padStart(2, "0")}/${targetYear}`,
      totalPagamentos: payments.length,
      repassesCriados: criados,
      mensagem:
        criados === 0
          ? "Nenhum repasse criado. Todos os pagamentos do mes ja tem repasse correspondente."
          : `${criados} repasse(s) criado(s) com sucesso.`,
      detalhes,
    });
  } catch (error) {
    console.error("[Repasses Sync]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao sincronizar repasses" },
      { status: 500 }
    );
  }
}
