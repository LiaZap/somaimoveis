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
        },
      });

      if (!contract) {
        detalhes.push({ payment: p.code, result: "Contrato nao encontrado, ignorado" });
        continue;
      }

      // Calcular valor do repasse CORRETO:
      // rentalValue - adminFee (taxa de administracao)
      // NAO incluir: taxa bancaria, creditos, debitos diversos
      const adminPct = contract.adminFeePercent || 10;
      const adminFeeValue = Math.round(contract.rentalValue * (adminPct / 100) * 100) / 100;
      const calculatedOwnerValue = Math.round((contract.rentalValue - adminFeeValue) * 100) / 100;

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
            aluguelBruto: contract.rentalValue,
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
        aluguelBruto: contract.rentalValue,
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
