import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { sicrediCancelBoleto } from "@/lib/sicredi-client";
import { applyFineInterestSplit } from "@/lib/fine-interest-split";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  try {
    const { id } = await params;
    const payment = await prisma.payment.findUnique({
      where: { id },
      include: { contract: true, tenant: true, owner: true },
    });
    if (!payment) {
      return NextResponse.json({ error: "Pagamento não encontrado" }, { status: 404 });
    }
    return NextResponse.json(payment);
  } catch (error) {
    return NextResponse.json({ error: "Erro ao buscar pagamento" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  try {
    const { id } = await params;
    const body = await request.json();

    // Whitelist allowed fields to prevent mass assignment
    const data: Record<string, unknown> = {};
    if (body.status !== undefined) data.status = body.status;
    if (body.description !== undefined) data.description = body.description || null;
    if (body.paymentMethod !== undefined) data.paymentMethod = body.paymentMethod || null;
    if (body.value !== undefined) data.value = parseFloat(body.value);
    if (body.paidValue !== undefined) data.paidValue = body.paidValue ? parseFloat(body.paidValue) : null;
    if (body.fineValue !== undefined) data.fineValue = body.fineValue ? parseFloat(body.fineValue) : null;
    if (body.interestValue !== undefined) data.interestValue = body.interestValue ? parseFloat(body.interestValue) : null;
    if (body.discountValue !== undefined) data.discountValue = body.discountValue ? parseFloat(body.discountValue) : null;
    if (body.lateFee !== undefined) data.lateFee = body.lateFee ? parseFloat(body.lateFee) : null;
    if (body.totalDue !== undefined) data.totalDue = body.totalDue ? parseFloat(body.totalDue) : null;
    if (body.splitOwnerValue !== undefined) data.splitOwnerValue = body.splitOwnerValue ? parseFloat(body.splitOwnerValue) : null;
    if (body.splitAdminValue !== undefined) data.splitAdminValue = body.splitAdminValue ? parseFloat(body.splitAdminValue) : null;
    if (body.dueDate !== undefined) {
      const d = String(body.dueDate);
      data.dueDate = new Date(d.includes("T") ? d : d + "T12:00:00");
    }
    if (body.paidAt !== undefined) {
      const d = String(body.paidAt);
      data.paidAt = body.paidAt ? new Date(d.includes("T") ? d : d + "T12:00:00") : null;
    }
    if (body.notes !== undefined) data.notes = body.notes || null;
    if (body.intermediationFee !== undefined) data.intermediationFee = body.intermediationFee ? parseFloat(body.intermediationFee) : null;
    if (body.irrfValue !== undefined) data.irrfValue = body.irrfValue ? parseFloat(body.irrfValue) : null;
    if (body.irrfRate !== undefined) data.irrfRate = body.irrfRate ? parseFloat(body.irrfRate) : null;
    if (body.grossToOwner !== undefined) data.grossToOwner = body.grossToOwner ? parseFloat(body.grossToOwner) : null;
    if (body.netToOwner !== undefined) data.netToOwner = body.netToOwner ? parseFloat(body.netToOwner) : null;

    // Override manual do split de juros/multa (botao "excluir do repasse" na UI)
    if (body.fineRetidaImobiliaria !== undefined) data.fineRetidaImobiliaria = body.fineRetidaImobiliaria;
    if (body.interestRetidaImobiliaria !== undefined) data.interestRetidaImobiliaria = body.interestRetidaImobiliaria;

    // Auto-recalcula o split de juros/multa quando edita pagamento PAGO
    // com fineValue/interestValue/paidAt — exceto se o usuario passou
    // explicitamente o override.
    const overrideSplit =
      body.fineRetidaImobiliaria !== undefined ||
      body.interestRetidaImobiliaria !== undefined;
    if (!overrideSplit && body.status === "PAGO") {
      // Buscar o estado atual + contrato pra rodar a regra
      const current = await prisma.payment.findUnique({
        where: { id },
        select: {
          fineValue: true,
          interestValue: true,
          paidAt: true,
          contract: { select: { aluguelGarantido: true } },
        },
      });
      if (current) {
        const fine = (data.fineValue as number | null) ?? current.fineValue;
        const interest = (data.interestValue as number | null) ?? current.interestValue;
        const paidAt = (data.paidAt as Date | null) ?? current.paidAt;
        const aluguelGarantido = current.contract?.aluguelGarantido ?? false;
        if ((fine ?? 0) > 0 || (interest ?? 0) > 0) {
          const billingSettings = await prisma.billingSettings.findFirst();
          const diaCorte = billingSettings?.diaCorteJurosMulta ?? 10;
          const split = applyFineInterestSplit({
            fineValue: fine,
            interestValue: interest,
            paidAt,
            aluguelGarantido,
            diaCorte,
          });
          data.fineRetidaImobiliaria = split.fineRetidaImobiliaria;
          data.interestRetidaImobiliaria = split.interestRetidaImobiliaria;
        }
      }
    }

    const payment = await prisma.payment.update({
      where: { id },
      data,
      include: { contract: true, tenant: true, owner: true },
    });

    // Quando pagamento é confirmado (PAGO), marcar lançamentos do locatário como PAGO
    if (body.status === "PAGO" && payment.notes) {
      try {
        const breakdown = JSON.parse(payment.notes);
        if (breakdown.lancamentos && Array.isArray(breakdown.lancamentos)) {
          const entryIds = breakdown.lancamentos.map((l: { id?: string }) => l.id).filter(Boolean);
          if (entryIds.length > 0) {
            await prisma.tenantEntry.updateMany({
              where: { id: { in: entryIds } },
              data: { status: "PAGO" },
            });
          }
        }
      } catch {
        // notes não é JSON válido, ignorar
      }
    }

    // Quando pagamento é confirmado (PAGO), garantir que existe uma OwnerEntry REPASSE pendente.
    // Caso o pagamento tenha sido criado fora de /api/billing/generate (ex: manual, legado),
    // cria a entry de repasse para o proprietario poder ser pago.
    //
    // IMPORTANTE: o valor do repasse deve ser rentalValue - adminFee (sem taxa bancaria,
    // sem creditos/debitos do locatario, que ficam apenas no Payment).
    if (body.status === "PAGO" && payment.contractId && payment.ownerId && payment.dueDate) {
      try {
        const existing = await prisma.ownerEntry.findFirst({
          where: {
            contractId: payment.contractId,
            dueDate: payment.dueDate,
            category: "REPASSE",
          },
        });
        if (!existing) {
          const contract = await prisma.contract.findUnique({
            where: { id: payment.contractId },
            select: {
              code: true,
              rentalValue: true,
              adminFeePercent: true,
              propertyId: true,
            },
          });

          if (contract) {
            const adminPct = contract.adminFeePercent || 10;
            const adminFeeValue = Math.round(contract.rentalValue * (adminPct / 100) * 100) / 100;
            const calculatedOwnerValue = Math.round((contract.rentalValue - adminFeeValue) * 100) / 100;

            // Preferir splitOwnerValue se existir (calculado corretamente em billing/generate)
            const splitValue = payment.splitOwnerValue ?? 0;
            const ownerValue = splitValue > 0 ? splitValue : calculatedOwnerValue;

            if (ownerValue > 0) {
              const d = new Date(payment.dueDate);
              const mLabel = `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

              const notesData = {
                aluguelBruto: contract.rentalValue,
                adminFeePercent: adminPct,
                adminFeeValue,
                irrfValue: payment.irrfValue || undefined,
                irrfRate: payment.irrfRate || undefined,
                netToOwner: payment.netToOwner || ownerValue,
                autoCreated: true,
              };

              await prisma.ownerEntry.create({
                data: {
                  type: "CREDITO",
                  category: "REPASSE",
                  description: `Repasse aluguel ${mLabel} - ${contract.code || payment.contractId}`,
                  value: ownerValue,
                  dueDate: payment.dueDate,
                  status: "PENDENTE",
                  ownerId: payment.ownerId,
                  contractId: payment.contractId,
                  propertyId: contract.propertyId || null,
                  notes: JSON.stringify(notesData),
                },
              });
            }
          }
        }
      } catch (err) {
        console.error("[Payment PUT] Erro ao criar OwnerEntry REPASSE:", err);
        // Nao bloquear a atualizacao do pagamento
      }
    }

    // Quando pagamento volta para PENDENTE, restaurar lançamentos
    if (body.status === "PENDENTE" && payment.notes) {
      try {
        const breakdown = JSON.parse(payment.notes);
        if (breakdown.lancamentos && Array.isArray(breakdown.lancamentos)) {
          const entryIds = breakdown.lancamentos.map((l: { id?: string }) => l.id).filter(Boolean);
          if (entryIds.length > 0) {
            await prisma.tenantEntry.updateMany({
              where: { id: { in: entryIds } },
              data: { status: "PENDENTE" },
            });
          }
        }
      } catch {
        // ignore
      }
    }

    return NextResponse.json(payment);
  } catch (error: any) {
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "Pagamento não encontrado" }, { status: 404 });
    }
    return NextResponse.json({ error: "Erro ao atualizar pagamento" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;
  try {
    const { id } = await params;

    const payment = await prisma.payment.findUnique({
      where: { id },
      select: { id: true, contractId: true, tenantId: true, dueDate: true, nossoNumero: true, notes: true },
    });
    if (!payment) {
      return NextResponse.json({ error: "Pagamento não encontrado" }, { status: 404 });
    }

    // Se tem boleto emitido, cancelar no Sicredi primeiro
    if (payment.nossoNumero) {
      try {
        await sicrediCancelBoleto(payment.nossoNumero);
        console.log(`[Payment DELETE] Boleto ${payment.nossoNumero} cancelado no Sicredi`);
      } catch (err) {
        // Logar mas nao bloquear a exclusao
        console.error(`[Payment DELETE] Erro ao cancelar boleto ${payment.nossoNumero}:`, err);
      }
    }

    // Limpar notificacoes relacionadas
    await prisma.notification.deleteMany({
      where: { paymentId: id },
    });

    // Fix Bug 16: limpa owner entries de REPASSE E GARANTIA (antes so REPASSE).
    // Tambem aceita varias entries (caso coproprietarios = N entries).
    await prisma.ownerEntry.deleteMany({
      where: {
        contractId: payment.contractId,
        dueDate: payment.dueDate,
        category: { in: ["REPASSE", "GARANTIA"] },
        status: "PENDENTE",
      },
    });

    // Restaurar lançamentos vinculados ao pagamento para PENDENTE
    let restoredByIds = false;
    if (payment.notes) {
      try {
        const breakdown = JSON.parse(payment.notes as string);
        if (breakdown.lancamentos && Array.isArray(breakdown.lancamentos)) {
          const entryIds = breakdown.lancamentos.map((l: { id?: string }) => l.id).filter(Boolean);
          if (entryIds.length > 0) {
            await prisma.tenantEntry.updateMany({
              where: { id: { in: entryIds } },
              data: { status: "PENDENTE" },
            });
            restoredByIds = true;
          }
        }
      } catch {
        // ignore
      }
    }
    // Fallback: restaurar por locatário+mês (cobranças antigas sem IDs no notes)
    if (!restoredByIds && payment.tenantId && payment.dueDate) {
      const dueMonth = new Date(payment.dueDate);
      const mStart = new Date(dueMonth.getFullYear(), dueMonth.getMonth(), 1);
      const mEnd = new Date(dueMonth.getFullYear(), dueMonth.getMonth() + 1, 0, 23, 59, 59, 999);
      await prisma.tenantEntry.updateMany({
        where: {
          tenantId: payment.tenantId,
          status: "PAGO",
          dueDate: { gte: mStart, lte: mEnd },
        },
        data: { status: "PENDENTE" },
      });
    }

    // Deletar o pagamento
    await prisma.payment.delete({ where: { id } });
    return NextResponse.json({ message: "Pagamento excluído com sucesso" });
  } catch (error: any) {
    console.error("[Payment DELETE] Erro:", error);
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "Pagamento não encontrado" }, { status: 404 });
    }
    return NextResponse.json({ error: "Erro ao excluir pagamento" }, { status: 500 });
  }
}
