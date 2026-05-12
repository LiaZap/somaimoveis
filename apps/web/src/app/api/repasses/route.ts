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
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 1);
    // Janela de 90 dias antes do monthStart pra capturar entries cuja
    // dueDate caiu no mes anterior mas o paidAt foi no mes selecionado
    // (caso comum apos dedupe: entry mantida tem dueDate antiga, mas o
    // pagamento foi recente).
    const dueDateMin = new Date(monthStart);
    dueDateMin.setDate(dueDateMin.getDate() - 90);
    creditWhere.OR = [
      // Entries com dueDate dentro do mes
      { dueDate: { gte: monthStart, lt: monthEnd } },
      // Entries com paidAt no mes E dueDate em ate 90 dias antes
      {
        AND: [
          { paidAt: { gte: monthStart, lt: monthEnd } },
          { dueDate: { gte: dueDateMin, lt: monthStart } },
        ],
      },
    ];
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

  // Buscar debitos dos proprietarios para descontar do repasse.
  // O filtro de status segue o status da query — na aba "Repassados"
  // (status=PAGO) mostra debitos PAGO do mesmo mes (foram pagos junto
  // com o repasse, lei do Leo). Sem isso, o admin via "0 debitos" na
  // aba pagos e ficava confuso pra conferir.
  const ownerIds = [...new Set(entries.map((e) => e.ownerId))];
  const debitWhere: Record<string, unknown> = {
    type: "DEBITO",
    ownerId: { in: ownerIds },
  };

  if (status === "PAGO") {
    // Aba "Nao Confirmados" / "Confirmados Banco": mostra TODOS os
    // debitos do owner ate o final do mes selecionado (PAGO ja descontados +
    // PENDENTE que serao descontados no proximo repasse). Sem isso, o
    // admin nao via os REPAROs do Lucio que ainda nao tinham sido cobrados.
    debitWhere.status = { in: ["PENDENTE", "PAGO"] };
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split("-").map(Number);
      // Inclui debitos com dueDate ate o final do mes (PAGO do mes + PENDENTE
      // do mes ou anteriores + sem dueDate). m e 1-indexed, então new Date(y, m, 1)
      // ja retorna o primeiro dia do mes seguinte.
      debitWhere.OR = [
        { dueDate: { lt: new Date(y, m, 1) } },
        { dueDate: null },
      ];
    }
  } else if (status === "PENDENTE") {
    // Aba PIX/TED: debitos PENDENTES a descontar do proximo repasse.
    // Inclui mes atual + anteriores (carry-forward) + sem dueDate.
    debitWhere.status = "PENDENTE";
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split("-").map(Number);
      debitWhere.OR = [
        { dueDate: { lt: new Date(y, m, 1) } },
        { dueDate: null },
      ];
    }
  } else {
    // status=all (aba "Todos"): mostra debitos do mes selecionado
    // independente do status (PENDENTE ou PAGO) — pra totalLiquido
    // refletir o REAL liquido (com descontos PAGOs aplicados).
    // Sem isso, Julio Cesar aparecia com liquido R$ 5.594 mesmo apos
    // DARF + condominios virarem PAGO, em vez do R$ 4.678 real.
    debitWhere.status = { in: ["PENDENTE", "PAGO"] };
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split("-").map(Number);
      // monthEnd = primeiro dia do mes SEGUINTE.
      // month "2026-05" → m=5, JS Date espera 0-indexed,
      // entao new Date(2026, 5, 1) = junho 1 (correto).
      // BUG anterior: usava new Date(y, m+1, 1) = julho 1 (off-by-one),
      // o que incluia debitos de junho indevidamente no totalDebitos
      // de maio (caso Marlene: 3 reparos parcelados — 1 de abril,
      // 1 de maio e 1 de junho eram todos somados).
      debitWhere.OR = [
        { dueDate: { lt: new Date(y, m, 1) } }, // mes atual e anteriores
        { dueDate: null },
      ];
    }
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
      // Confirmacao do banco: prefere bankConfirmed do REPASSE.
      // Se NAO ha REPASSE no mes (ex: owner so tem IPTU/credito avulso),
      // verifica se TODAS as entries PAGO do owner tem bankConfirmed=true.
      let bankConfirmed = false;
      let bankConfirmedAt: string | null = null;
      const checkConfirmed = (notes: string | null) => {
        if (!notes) return { confirmed: false, at: null as string | null };
        try {
          const n = JSON.parse(notes);
          return { confirmed: n.bankConfirmed === true, at: n.bankConfirmedAt || null };
        } catch { return { confirmed: false, at: null }; }
      };
      if (repasseEntry) {
        const r = checkConfirmed(repasseEntry.notes);
        bankConfirmed = r.confirmed;
        bankConfirmedAt = r.at;
      } else {
        const entriesPagas = g.entries.filter((e: any) => e.status === "PAGO");
        if (entriesPagas.length > 0) {
          const todasConfirmadas = entriesPagas.every((e: any) => checkConfirmed(e.notes).confirmed);
          if (todasConfirmadas) {
            bankConfirmed = true;
            const first = entriesPagas.map((e: any) => checkConfirmed(e.notes).at).find(Boolean);
            bankConfirmedAt = first || null;
          }
        }
      }
      return {
        ...g,
        totalPendente: Math.round(g.totalPendente * 100) / 100,
        totalPago: Math.round(g.totalPago * 100) / 100,
        totalDebitos: Math.round(g.totalDebitos * 100) / 100,
        totalLiquido: Math.round((g.totalPendente + g.totalPago - g.totalDebitos) * 100) / 100,
        bankConfirmed,
        bankConfirmedAt,
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
  // PENDENTES do owner com dueDate <= monthEnd (incluindo carry-forward
  // de meses anteriores). O CNAB ja desconta esses debitos antigos do
  // repasse — entao precisam virar PAGO juntos pra nao serem cobrados
  // de novo no mes seguinte. Lei do Leo.
  let debitsAutoMarked = 0;
  if (status === "PAGO") {
    const markedForDebits = await prisma.ownerEntry.findMany({
      where: { id: { in: entryIds } },
      select: { ownerId: true, dueDate: true },
    });
    const ownerMonths = new Set<string>();
    const ownerMonthList: { ownerId: string; monthEnd: Date }[] = [];
    for (const e of markedForDebits) {
      if (!e.dueDate) continue;
      // monthEnd = primeiro dia do MES SEGUINTE ao dueDate da REPASSE
      const monthEnd = new Date(e.dueDate.getFullYear(), e.dueDate.getMonth() + 1, 1);
      const key = `${e.ownerId}_${monthEnd.toISOString()}`;
      if (ownerMonths.has(key)) continue;
      ownerMonths.add(key);
      ownerMonthList.push({ ownerId: e.ownerId, monthEnd });
    }
    for (const om of ownerMonthList) {
      const debitUpdate = await prisma.ownerEntry.updateMany({
        where: {
          ownerId: om.ownerId,
          type: "DEBITO",
          status: "PENDENTE",
          // Inclui debitos do mes atual E meses anteriores (carry-forward)
          // que o CNAB ja descontou. Inclui tambem sem dueDate (avulsos).
          OR: [
            { dueDate: { lt: om.monthEnd } },
            { dueDate: null },
          ],
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
