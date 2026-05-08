import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month"); // YYYY-MM
  const status = searchParams.get("status"); // PENDENTE, PAGO, all

  // Incluir TODOS os créditos do proprietário (REPASSE, IPTU, CONDOMINIO, GARANTIA, etc.)
  const creditWhere: Record<string, unknown> = {
    type: "CREDITO",
  };

  if (status && status !== "all") {
    creditWhere.status = status;
  }

  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split("-").map(Number);
    creditWhere.dueDate = {
      gte: new Date(y, m - 1, 1),
      lt: new Date(y, m, 1),
    };
  }

  const ownerSelect = {
    id: true,
    name: true,
    cpfCnpj: true,
    phone: true,
    email: true,
    bankName: true,
    bankAgency: true,
    bankAccount: true,
    bankPix: true,
    bankPixType: true,
    thirdPartyName: true,
    thirdPartyDocument: true,
    thirdPartyBank: true,
    thirdPartyAgency: true,
    thirdPartyAccount: true,
    thirdPartyPixKeyType: true,
    thirdPartyPix: true,
    paymentDay: true,
    notes: true,
    payoutBeneficiaries: {
      orderBy: { order: "asc" } as const,
      select: { id: true, name: true, pixKey: true, pixKeyType: true, percentage: true },
    },
  };

  const entries = await prisma.ownerEntry.findMany({
    where: creditWhere,
    include: { owner: { select: ownerSelect } },
    orderBy: { dueDate: "asc" },
  });

  // Para entries REPASSE/GARANTIA sem admin fee no notes, buscar do contrato
  try {
    const contractCache: Record<string, { rentalValue: number; adminFeePercent: number }> = {};
    for (const entry of entries) {
      if (!["REPASSE", "GARANTIA"].includes(entry.category)) continue;
      let hasAdminFee = false;
      if (entry.notes) {
        try {
          const n = JSON.parse(entry.notes);
          if (n.adminFeePercent !== undefined) hasAdminFee = true;
        } catch {}
      }
      if (hasAdminFee) continue;

      const cacheKey = entry.contractId || `owner-${entry.ownerId}-${entry.propertyId}`;
      if (!contractCache[cacheKey]) {
        try {
          let contract: { rentalValue: number; adminFeePercent: number } | null = null;
          if (entry.contractId) {
            contract = await prisma.contract.findUnique({
              where: { id: entry.contractId },
              select: { rentalValue: true, adminFeePercent: true },
            });
          }
          if (!contract) {
            const contracts = await prisma.contract.findMany({
              where: {
                ownerId: entry.ownerId,
                status: "ATIVO",
                ...(entry.propertyId ? { propertyId: entry.propertyId } : {}),
              },
              select: { rentalValue: true, adminFeePercent: true },
              take: 1,
            });
            if (contracts.length > 0) contract = contracts[0];
          }
          if (contract) {
            contractCache[cacheKey] = contract;
          }
        } catch (err) {
          console.error(`[Repasses] Erro ao buscar contrato para entry ${entry.id}:`, err);
          continue;
        }
      }

      const c = contractCache[cacheKey];
      if (c) {
        const pctMatch = entry.description.match(/\((\d+(?:[.,]\d+)?)%\)/);
        const sharePercent = pctMatch ? parseFloat(pctMatch[1].replace(",", ".")) : undefined;

        // Calcular aluguel bruto a partir do valor do entry (pode ser pro-rata)
        // entry.value = aluguelBruto * (1 - adminFee/100) * (sharePercent/100)
        const adminPct = c.adminFeePercent / 100;
        const shareFactor = sharePercent ? sharePercent / 100 : 1;
        const aluguelBruto = Math.round(entry.value / ((1 - adminPct) * shareFactor) * 100) / 100;
        const adminFeeValue = Math.round(aluguelBruto * adminPct * 100) / 100;

        let existingNotes: Record<string, unknown> = {};
        if (entry.notes) {
          try { existingNotes = JSON.parse(entry.notes); } catch {}
        }
        (entry as any).notes = JSON.stringify({
          ...existingNotes,
          aluguelBruto,
          adminFeePercent: c.adminFeePercent,
          adminFeeValue,
          sharePercent,
          netToOwner: entry.value,
        });
      }
    }
  } catch (err) {
    console.error("[Repasses] Erro no enriquecimento de notes:", err);
  }

  // Anexar status do Payment de origem em cada entry REPASSE/GARANTIA.
  // Sem FK direta entre OwnerEntry e Payment: usamos o par (contractId, dueDate)
  // para localizar o boleto correspondente. Permite a UI exibir
  // "Boleto nao pago" quando o repasse esta pendente do inquilino.
  try {
    const repasseEntries = entries.filter(
      (e) => ["REPASSE", "GARANTIA"].includes(e.category) && e.contractId && e.dueDate
    );
    if (repasseEntries.length > 0) {
      const contractIds = [...new Set(repasseEntries.map((e) => e.contractId as string))];
      const dueDates = repasseEntries.map((e) => e.dueDate as Date);
      const payments = await prisma.payment.findMany({
        where: {
          contractId: { in: contractIds },
          dueDate: { in: dueDates },
        },
        select: { contractId: true, dueDate: true, status: true, paidAt: true },
      });
      const paymentByKey = new Map<string, { status: string; paidAt: Date | null }>();
      for (const p of payments) {
        const key = `${p.contractId}_${p.dueDate.toISOString()}`;
        paymentByKey.set(key, { status: p.status, paidAt: p.paidAt });
      }
      for (const entry of entries) {
        if (["REPASSE", "GARANTIA"].includes(entry.category) && entry.contractId && entry.dueDate) {
          const key = `${entry.contractId}_${(entry.dueDate as Date).toISOString()}`;
          const p = paymentByKey.get(key);
          (entry as any).paymentStatus = p?.status ?? null;
          (entry as any).paymentPaidAt = p?.paidAt ?? null;
        } else {
          (entry as any).paymentStatus = null;
          (entry as any).paymentPaidAt = null;
        }
      }
    }
  } catch (err) {
    console.error("[Repasses] Erro ao buscar status do Payment:", err);
  }

  // Buscar debitos PENDENTES dos proprietarios para descontar do repasse
  const ownerIds = [...new Set(entries.map((e) => e.ownerId))];
  const debitWhere: Record<string, unknown> = {
    type: "DEBITO",
    status: "PENDENTE",
    ownerId: { in: ownerIds },
  };
  // Filtro de mes: lancamento vinculado ao mes — debito do mes 04 nao
  // aparece no mes 05. Se o repasse de 04 nao foi fechado, eventual saldo
  // negativo cai como SALDO_NEGATIVO no mes seguinte (carry-forward
  // explicito via PATCH /api/repasses linhas 297+).
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split("-").map(Number);
    debitWhere.dueDate = {
      gte: new Date(y, m - 1, 1),
      lt: new Date(y, m, 1),
    };
  }
  const debitEntries = await prisma.ownerEntry.findMany({
    where: debitWhere,
    include: { owner: { select: { id: true, name: true } } },
    orderBy: { dueDate: "asc" },
  });

  // Group by owner
  const grouped: Record<
    string,
    {
      owner: (typeof entries)[0]["owner"];
      entries: typeof entries;
      debitEntries: typeof debitEntries;
      totalPendente: number;
      totalPago: number;
      totalDebitos: number;
      totalLiquido: number;
    }
  > = {};

  for (const entry of entries) {
    const oid = entry.ownerId;
    if (!grouped[oid]) {
      grouped[oid] = {
        owner: entry.owner,
        entries: [],
        debitEntries: [],
        totalPendente: 0,
        totalPago: 0,
        totalDebitos: 0,
        totalLiquido: 0,
      };
    }
    grouped[oid].entries.push(entry);
    if (entry.status === "PENDENTE") {
      grouped[oid].totalPendente += entry.value;
    } else if (entry.status === "PAGO") {
      grouped[oid].totalPago += entry.value;
    }
  }

  // Adicionar debitos aos grupos
  for (const debit of debitEntries) {
    const oid = debit.ownerId;
    if (grouped[oid]) {
      grouped[oid].debitEntries.push(debit);
      grouped[oid].totalDebitos += debit.value;
    }
  }

  // Calcular valor liquido (repasse - debitos)
  // Detectar co-proprietários: entries com "(%)" na descrição
  const result = Object.values(grouped)
    .map((g) => {
      const repasseEntry = g.entries.find(e => ["REPASSE", "GARANTIA"].includes(e.category));
      const pctMatch = repasseEntry?.description.match(/\((\d+(?:[.,]\d+)?)%\)/);
      const sharePercent = pctMatch ? parseFloat(pctMatch[1].replace(",", ".")) : null;
      return {
        ...g,
        totalPendente: Math.round(g.totalPendente * 100) / 100,
        totalPago: Math.round(g.totalPago * 100) / 100,
        totalDebitos: Math.round(g.totalDebitos * 100) / 100,
        totalLiquido: Math.round((g.totalPendente + g.totalPago - g.totalDebitos) * 100) / 100,
        isCoOwner: sharePercent !== null && sharePercent < 100,
        sharePercent,
      };
    })
    .sort((a, b) => a.owner.name.localeCompare(b.owner.name, "pt-BR"));

  return NextResponse.json(result);
  } catch (error) {
    console.error("[Repasses GET] Erro:", error);
    return NextResponse.json(
      { error: "Erro ao buscar repasses", details: error instanceof Error ? error.message : "Erro desconhecido" },
      { status: 500 }
    );
  }
}

// PATCH - batch update: mark multiple entries as PAGO
export async function PATCH(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const body = await request.json();
  const { entryIds, status } = body;

  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    return NextResponse.json(
      { error: "entryIds deve ser um array nao vazio" },
      { status: 400 }
    );
  }

  const validStatuses = ["PAGO", "PENDENTE", "CANCELADO"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json(
      { error: `Status invalido. Use: ${validStatuses.join(", ")}` },
      { status: 400 }
    );
  }

  const data: Record<string, unknown> = { status };
  if (status === "PAGO") {
    data.paidAt = new Date();
  } else if (status === "PENDENTE") {
    data.paidAt = null;
  }

  const updated = await prisma.ownerEntry.updateMany({
    where: { id: { in: entryIds } },
    data,
  });

  // Quando o admin marca repasse como PAGO, marca tambem todos os debitos
  // PENDENTES do mesmo (owner, mes) — eles foram processados junto. Lei do
  // Leo: "no momento que o lancamento foi descontado do cliente, ele tem
  // que entender que ja foi pago — nao vejo necessidade do status nos
  // lancamentos, eles devem se alinhar automaticamente".
  let debitsAutoMarked = 0;
  if (status === "PAGO") {
    const markedForDebits = await prisma.ownerEntry.findMany({
      where: { id: { in: entryIds } },
      select: { ownerId: true, dueDate: true },
    });
    const ownerMonths = new Set<string>();
    const ownerMonthList: { ownerId: string; monthStart: Date; monthEnd: Date }[] = [];
    for (const e of markedForDebits) {
      if (!e.dueDate) continue;
      const monthStart = new Date(e.dueDate.getFullYear(), e.dueDate.getMonth(), 1);
      const monthEnd = new Date(e.dueDate.getFullYear(), e.dueDate.getMonth() + 1, 1);
      const key = `${e.ownerId}_${monthStart.toISOString()}`;
      if (ownerMonths.has(key)) continue;
      ownerMonths.add(key);
      ownerMonthList.push({ ownerId: e.ownerId, monthStart, monthEnd });
    }
    for (const om of ownerMonthList) {
      const debitUpdate = await prisma.ownerEntry.updateMany({
        where: {
          ownerId: om.ownerId,
          type: "DEBITO",
          status: "PENDENTE",
          dueDate: { gte: om.monthStart, lt: om.monthEnd },
        },
        data: { status: "PAGO", paidAt: new Date() },
      });
      debitsAutoMarked += debitUpdate.count;
    }
  }

  // Se marcou como PAGO, verificar se algum proprietário ficou negativado
  // e criar débito automático para o mês seguinte
  const carryForwardResults: { owner: string; valor: number }[] = [];
  if (status === "PAGO") {
    // Buscar as entries que foram marcadas para saber os owners e o mês
    const markedEntries = await prisma.ownerEntry.findMany({
      where: { id: { in: entryIds } },
      select: { ownerId: true, dueDate: true },
    });

    // Agrupar por owner
    const ownerDates: Record<string, Date> = {};
    for (const e of markedEntries) {
      if (!ownerDates[e.ownerId] && e.dueDate) {
        ownerDates[e.ownerId] = e.dueDate;
      }
    }

    for (const [ownerId, dueDate] of Object.entries(ownerDates)) {
      // Calcular saldo do owner no mês atual
      const monthStart = new Date(dueDate.getFullYear(), dueDate.getMonth(), 1);
      const monthEnd = new Date(dueDate.getFullYear(), dueDate.getMonth() + 1, 1);

      const credits = await prisma.ownerEntry.aggregate({
        where: { ownerId, type: "CREDITO", status: "PAGO", dueDate: { gte: monthStart, lt: monthEnd } },
        _sum: { value: true },
      });
      const debits = await prisma.ownerEntry.aggregate({
        where: { ownerId, type: "DEBITO", status: { in: ["PENDENTE", "PAGO"] }, dueDate: { gte: monthStart, lt: monthEnd } },
        _sum: { value: true },
      });

      const saldo = (credits._sum.value || 0) - (debits._sum.value || 0);

      if (saldo < 0) {
        // Próximo mês
        const nextMonth = new Date(dueDate.getFullYear(), dueDate.getMonth() + 1, 10);
        const nextMonthStart = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 1);
        const nextMonthEnd = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 1);
        const mmOrig = String(dueDate.getMonth() + 1).padStart(2, "0");
        const yyyyOrig = dueDate.getFullYear();

        // Verificar se já existe débito carry-forward para este owner neste mês
        const existing = await prisma.ownerEntry.findFirst({
          where: {
            ownerId,
            type: "DEBITO",
            category: "SALDO_NEGATIVO",
            status: "PENDENTE",
            dueDate: { gte: nextMonthStart, lt: nextMonthEnd },
          },
        });

        const valorNeg = Math.round(Math.abs(saldo) * 100) / 100;

        if (!existing) {
          const owner = await prisma.owner.findUnique({ where: { id: ownerId }, select: { name: true } });
          await prisma.ownerEntry.create({
            data: {
              type: "DEBITO",
              category: "SALDO_NEGATIVO",
              description: `Saldo negativo ref. ${mmOrig}/${yyyyOrig}`,
              value: valorNeg,
              dueDate: nextMonth,
              status: "PENDENTE",
              ownerId,
            },
          });
          carryForwardResults.push({ owner: owner?.name || ownerId, valor: valorNeg });
        }
      }
    }
  }

  return NextResponse.json({
    updated: updated.count,
    debitsAutoMarked,
    message:
      `${updated.count} repasse(s) atualizado(s) para ${status}` +
      (debitsAutoMarked > 0 ? ` + ${debitsAutoMarked} débito(s) marcados como PAGO` : ""),
    carryForward: carryForwardResults.length > 0 ? carryForwardResults : undefined,
  });
}
