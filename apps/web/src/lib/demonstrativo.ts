/**
 * Lógica do demonstrativo de repasses (compartilhada entre o dashboard
 * admin e o portal do proprietário).
 *
 * Recebe { ownerId, monthStr } e retorna o payload formatado igual ao
 * que o frontend espera. NÃO inclui autenticação — o caller deve validar
 * permissão antes de chamar.
 *
 * Importante: esta função NUNCA expõe dados de outros proprietários nem
 * agregados da empresa. Tudo é filtrado por ownerId.
 */
import { prisma } from "@/lib/prisma";

export interface BuildDemonstrativoParams {
  ownerId: string;
  /** Formato YYYY-MM (mês do vencimento dos boletos). null = mês atual. */
  monthStr: string | null;
}

export type DemonstrativoResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; error: string };

export async function buildDemonstrativo(
  params: BuildDemonstrativoParams
): Promise<DemonstrativoResult> {
  const { ownerId, monthStr } = params;

  // O parâmetro `month` representa o MES DO BOLETO (vencimento) — o
  // mesmo mês que o usuário seleciona no filtro. O mês de REFERÊNCIA
  // do aluguel é o mês ANTERIOR (cobrança in-arrears).
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

  let refYear = targetYear;
  let refMonth = targetMonth - 1;
  if (refMonth < 0) {
    refMonth = 11;
    refYear -= 1;
  }

  const monthStart = new Date(targetYear, targetMonth, 1);
  const monthEnd = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59, 999);
  const mLabel = `${String(refMonth + 1).padStart(2, "0")}/${refYear}`;
  const periodStart = monthStart.toLocaleDateString("pt-BR", { timeZone: "UTC" });
  const periodEnd = monthEnd.toLocaleDateString("pt-BR", { timeZone: "UTC" });

  const owner = await prisma.owner.findUnique({
    where: { id: ownerId },
    include: {
      payoutBeneficiaries: {
        orderBy: { order: "asc" },
        select: { name: true, percentage: true, pixKey: true, pixKeyType: true },
      },
    },
  });
  if (!owner) {
    return { ok: false, status: 404, error: "Proprietario nao encontrado" };
  }

  // Se proprietario marcou "nao declara", suprime demonstrativo.
  // Caso conversado na reuniao 12/05/2026: imoveis adquiridos onde o
  // dono pediu pra nao gerar NFS-e nem demonstrativo (assume risco fiscal).
  if ((owner as any).naoDeclaraImob === true) {
    return {
      ok: false,
      status: 403,
      error: "Demonstrativo nao disponivel para este proprietario (configurado como 'nao declara imovel').",
    };
  }

  // Fix Paulo 14/05/2026: demonstrativo deve mostrar APENAS entries com
  // paidAt no mes selecionado (ciclo financeiro real do owner). Remove
  // carry-forward de dueDate em meses anteriores. Aluguel de abril pago
  // em maio aparece (paidAt=05) mas itens nao pagos ou de outros meses
  // sem paidAt em maio sao excluidos.
  const entries = await prisma.ownerEntry.findMany({
    where: {
      ownerId,
      status: { not: "CANCELADO" },
      paidAt: { gte: monthStart, lte: monthEnd },
    },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
  });

  // Fix Leo 13/05: TenantEntry destination=PROPRIETARIO afeta o demonstrativo
  // do owner. Inverte tipo (DEBITO inquilino -> CREDITO owner, e vice-versa).
  // Sem isso, IPTU pago pelo inquilino nao aparecia no demonstrativo do owner.
  const tenantEntriesForOwner = await prisma.tenantEntry.findMany({
    where: {
      destination: "PROPRIETARIO",
      status: { not: "CANCELADO" },
      OR: [
        { dueDate: { gte: monthStart, lte: monthEnd } },
        { AND: [{ dueDate: null }, { paidAt: { gte: monthStart, lte: monthEnd } }] },
      ],
      tenant: {
        contracts: {
          some: { ownerId, status: "ATIVO" },
        },
      },
    },
    include: {
      tenant: {
        select: {
          id: true, name: true,
          contracts: {
            where: { ownerId, status: "ATIVO" },
            select: { id: true, ownerId: true },
            take: 1,
          },
        },
      },
    },
  });

  // Converter TenantEntries em pseudo-OwnerEntries (com inversão de tipo)
  // Dedup mais robusto: se o owner ja tem OwnerEntries da mesma categoria,
  // dueDate e contractId, NAO incluir o TenantEntry (independente do valor
  // - porque splits podem dar valores diferentes).
  // Ex: TenantEntry IPTU R$ 416,66 dest=PROPRIETARIO + OwnerEntry IPTU
  // R$ 138,96 (proporcional Carla 33,35%) -> NAO duplicar.
  const ownerEntryCategoryDateContract = new Set<string>();
  for (const e of entries) {
    if (!e.contractId) continue;
    const k = `${(e.category||"").toUpperCase()}|${(e.dueDate ? e.dueDate.toISOString().slice(0,10) : "")}|${e.contractId}`;
    ownerEntryCategoryDateContract.add(k);
  }
  for (const te of tenantEntriesForOwner) {
    const ctr = te.tenant?.contracts?.[0];
    if (!ctr) continue;
    // Dedup: se ja existe OwnerEntry da mesma categoria/dueDate/contrato, skip
    const dupKey = `${(te.category||"").toUpperCase()}|${(te.dueDate ? te.dueDate.toISOString().slice(0,10) : "")}|${ctr.id}`;
    if (ownerEntryCategoryDateContract.has(dupKey)) continue;
    const tipoInvertido = te.type === "DEBITO" ? "CREDITO" : "DEBITO";
    (entries as any[]).push({
      id: te.id,
      type: tipoInvertido,
      category: te.category,
      description: te.description,
      value: te.value,
      dueDate: te.dueDate,
      paidAt: te.paidAt,
      status: te.status,
      ownerId,
      contractId: ctr.id,
      notes: te.notes,
      installmentNumber: te.installmentNumber,
      installmentTotal: te.installmentTotal,
      parentEntryId: te.parentEntryId,
      isRecurring: te.isRecurring,
      recurringDay: te.recurringDay,
      destination: te.destination,
      createdAt: te.createdAt,
      updatedAt: te.updatedAt,
      createdById: te.createdById,
      _fromTenantEntry: true,
    });
  }

  const contractIds = Array.from(
    new Set(entries.map((e) => e.contractId).filter((id): id is string => !!id))
  );
  const contracts = contractIds.length
    ? await prisma.contract.findMany({
        where: { id: { in: contractIds } },
        include: {
          property: {
            select: {
              id: true,
              title: true,
              type: true,
              street: true,
              number: true,
              complement: true,
              neighborhood: true,
              city: true,
              state: true,
            },
          },
          tenant: {
            select: { id: true, name: true, cpfCnpj: true, personType: true },
          },
        },
      })
    : [];
  const contractMap = new Map(contracts.map((c) => [c.id, c]));

  const payments = contractIds.length
    ? await prisma.payment.findMany({
        where: {
          contractId: { in: contractIds },
          dueDate: { gte: monthStart, lte: monthEnd },
        },
        select: {
          id: true,
          contractId: true,
          dueDate: true,
          paidAt: true,
          notes: true,
          // Juros/multa: novos campos estruturados (a partir de 2026-05)
          fineValue: true,
          interestValue: true,
          fineRetidaImobiliaria: true,
          interestRetidaImobiliaria: true,
        },
      })
    : [];

  // Mapa de juros/multa por contrato (so o que VAI pro proprietario neste mes)
  type FineInterestInfo = {
    fineToOwner: number;
    fineToImob: number;
    interestToOwner: number;
    interestToImob: number;
    paidAt: Date | null;
  };
  const fineInterestByContract = new Map<string, FineInterestInfo>();
  for (const p of payments) {
    if (!p.contractId) continue;
    const fine = p.fineValue ?? 0;
    const interest = p.interestValue ?? 0;
    if (fine === 0 && interest === 0) continue;
    const fineRetida = p.fineRetidaImobiliaria === true;
    const interestRetida = p.interestRetidaImobiliaria === true;
    const cur = fineInterestByContract.get(p.contractId) || {
      fineToOwner: 0, fineToImob: 0, interestToOwner: 0, interestToImob: 0,
      paidAt: p.paidAt,
    };
    cur.fineToImob += fineRetida ? fine : 0;
    cur.fineToOwner += fineRetida ? 0 : fine;
    cur.interestToImob += interestRetida ? interest : 0;
    cur.interestToOwner += interestRetida ? 0 : interest;
    if (!cur.paidAt) cur.paidAt = p.paidAt;
    fineInterestByContract.set(p.contractId, cur);
  }

  type TenantLanc = {
    id?: string;
    tipo?: string;
    categoria?: string;
    descricao?: string;
    valor?: number;
    destination?: string;
  };
  const paymentLancByContract = new Map<string, TenantLanc[]>();
  for (const p of payments) {
    if (!p.contractId || !p.notes) continue;
    try {
      const n = JSON.parse(p.notes);
      if (Array.isArray(n.lancamentos)) {
        paymentLancByContract.set(p.contractId, n.lancamentos as TenantLanc[]);
      }
    } catch { /* ignore */ }
  }

  type Movimento = {
    date: string;
    descricao: string;
    entrada: number;
    saida: number;
  };

  type ContractGroup = {
    contractId: string;
    code: string;
    property: { id: string; title: string; type: string; address: string } | null;
    tenant: { id: string; name: string; cpfCnpj: string; personType: string } | null;
    startDate: string | null;
    lastAdjustmentDate: string | null;
    movimentos: Movimento[];
    totalEntradas: number;
    totalSaidas: number;
    totalLiquido: number;
    aluguelBruto: number;
    aluguelLiquido: number;
    adminFee: number;
    irrf: number;
    /** Juros/multa retidos pela imobiliaria (nota informativa, nao soma) */
    infoRetidoPelaImobiliaria?: { juros: number; multa: number; total: number };
  };

  const groups = new Map<string, ContractGroup>();
  const avulsas: Movimento[] = [];
  let avulsasEntrada = 0;
  let avulsasSaida = 0;

  // Buscar contratos relacionados ao proprietário (principal + co-owner)
  const [ownContracts, propertyShares] = await Promise.all([
    prisma.contract.findMany({ where: { ownerId }, select: { id: true, code: true } }),
    prisma.propertyOwner.findMany({ where: { ownerId }, select: { propertyId: true } }),
  ]);
  const sharedPropertyIds = propertyShares.map((s) => s.propertyId);
  const sharedContracts = sharedPropertyIds.length
    ? await prisma.contract.findMany({
        where: { propertyId: { in: sharedPropertyIds } },
        select: { id: true, code: true },
      })
    : [];
  const allOwnerContracts = [
    ...ownContracts,
    ...sharedContracts.filter((c) => !ownContracts.some((o) => o.id === c.id)),
  ];
  const contractCodeMap = new Map(allOwnerContracts.map((c) => [c.code, c.id]));

  function resolveContractFromDescription(desc: string): string | null {
    const match = desc.match(/CTR[-\s]?(\d+)/i);
    if (!match) return null;
    const code = `CTR-${match[1]}`;
    return contractCodeMap.get(code) || null;
  }

  for (const e of entries) {
    // Skip entries com value=0. Sao "lixo" — geralmente OwnerEntries
    // que foram criadas e ajustadas pra 0 (anuladas) mas nao excluidas
    // do banco. Sem esse skip, o demonstrativo ainda gera linhas de
    // aluguel/admin baseado em notes.aluguelBruto, inflando o total.
    if (e.value === 0 || e.value == null) continue;

    const refDate = e.paidAt || e.dueDate || monthStart;
    const dateStr = new Date(refDate).toLocaleDateString("pt-BR", { timeZone: "UTC" });
    const value = e.value;

    let noteData: any = null;
    if (e.notes) {
      try { noteData = JSON.parse(e.notes); } catch { /* ignore */ }
    }

    let resolvedContractId = e.contractId;
    if (!resolvedContractId || !contractMap.has(resolvedContractId)) {
      const fromDesc = resolveContractFromDescription(e.description);
      if (fromDesc) {
        resolvedContractId = fromDesc;
        if (!contractMap.has(fromDesc)) {
          const fullContract = await prisma.contract.findUnique({
            where: { id: fromDesc },
            include: {
              property: {
                select: {
                  id: true, title: true, type: true,
                  street: true, number: true, complement: true,
                  neighborhood: true, city: true, state: true,
                },
              },
              tenant: { select: { id: true, name: true, cpfCnpj: true, personType: true } },
            },
          });
          if (fullContract) contractMap.set(fromDesc, fullContract);
          else resolvedContractId = null;
        }
      }
    }

    if (!resolvedContractId || !contractMap.has(resolvedContractId)) {
      const isCredit = e.type === "CREDITO";
      const mov: Movimento = {
        date: dateStr,
        descricao: e.description,
        entrada: isCredit ? value : 0,
        saida: isCredit ? 0 : value,
      };
      avulsas.push(mov);
      if (isCredit) avulsasEntrada += value;
      else avulsasSaida += value;
      continue;
    }

    const useContractId = resolvedContractId;
    const contract = contractMap.get(useContractId)!;
    if (!groups.has(useContractId)) {
      const p = contract.property;
      const addr = p
        ? [
            p.street ? `${p.street}${p.number ? ` ${p.number}` : ""}${p.complement ? ` ${p.complement}` : ""}` : null,
            p.neighborhood,
            p.city && p.state ? `${p.city}/${p.state}` : p.city,
          ].filter(Boolean).join(", ")
        : "";

      groups.set(useContractId, {
        contractId: contract.id,
        code: contract.code,
        property: p ? { id: p.id, title: p.title, type: p.type, address: addr } : null,
        tenant: contract.tenant,
        startDate: contract.startDate.toISOString(),
        lastAdjustmentDate: contract.lastAdjustmentDate?.toISOString() || null,
        movimentos: [],
        totalEntradas: 0,
        totalSaidas: 0,
        totalLiquido: 0,
        aluguelBruto: 0,
        aluguelLiquido: 0,
        adminFee: 0,
        irrf: 0,
      });
    }

    const isCredit = e.type === "CREDITO";
    const isRepasse = isCredit && e.category === "REPASSE";
    const categoriaUp = (e.category || "").toUpperCase();
    const descricaoUp = (e.description || "").toUpperCase();
    const isDesconto = e.type === "DEBITO" &&
      (categoriaUp === "DESCONTO" || categoriaUp === "ACORDO" || descricaoUp.includes("DESCONTO"));

    if (isRepasse || isDesconto) {
      const g = groups.get(useContractId)!;
      const gAny = g as any;
      if (!gAny._pendingRepasses) gAny._pendingRepasses = [];
      if (!gAny._pendingDescontos) gAny._pendingDescontos = [];
      if (isRepasse) {
        gAny._pendingRepasses.push({ entry: e, noteData, refDate, dateStr });
      } else {
        gAny._pendingDescontos.push({ entry: e, refDate, dateStr });
      }
    } else {
      const g = groups.get(useContractId)!;
      g.movimentos.push({
        date: dateStr,
        descricao: e.description,
        entrada: isCredit ? value : 0,
        saida: isCredit ? 0 : value,
      });
      if (isCredit) g.totalEntradas += value;
      else g.totalSaidas += value;
      // Tracking pra dedupe: registra valores de DEBITOs nao-desconto do owner.
      // Sao usados depois pra evitar duplicar com outrosCreditosLocatario
      // (caso o admin tenha propagado a cobranca do locatario pro owner).
      if (!isCredit) {
        const gAny = g as any;
        if (!gAny._outrosDebitosOwner) gAny._outrosDebitosOwner = [];
        gAny._outrosDebitosOwner.push({ value, desc: e.description });
      }
    }
  }

  // Processar REPASSEs com descontos
  for (const [contractId, g] of groups.entries()) {
    const pendingRepasses = ((g as any)._pendingRepasses || []) as Array<{
      entry: any; noteData: any; refDate: Date; dateStr: string;
    }>;
    const pendingDescontos = ((g as any)._pendingDescontos || []) as Array<{
      entry: any; refDate: Date; dateStr: string;
    }>;

    if (pendingRepasses.length === 0) {
      for (const d of pendingDescontos) {
        g.movimentos.push({
          date: d.dateStr,
          descricao: d.entry.description,
          entrada: 0,
          saida: d.entry.value,
        });
        g.totalSaidas += d.entry.value;
      }
      continue;
    }

    const descontoOwnerEntries = pendingDescontos.reduce((s, d) => s + d.entry.value, 0);
    const lancsLocatario = paymentLancByContract.get(contractId) || [];
    const descontosLocatarioAll = lancsLocatario.filter((l) => {
      if (l.tipo !== "CREDITO" || !l.valor || l.valor <= 0) return false;
      const cat = (l.categoria || "").toUpperCase();
      const desc = (l.descricao || "").toUpperCase();
      return cat === "DESCONTO" || cat === "ACORDO" || desc.includes("DESCONTO");
    });

    const ownerDescontoValues = pendingDescontos.map((d) => d.entry.value);
    // Dedupe: descontosLocatario vs pendingDescontos.
    // pendingDescontos.value e PROPORCIONAL (ex: R$ 250 = R$ 1.000 * 25%).
    // descontosLocatarioAll[i].valor e o valor CHEIO do contrato.
    // Pra comparar, descobrimos o sharePercent do REPASSE principal pra
    // aplicar no `l.valor`. Caso CTR-214: 4 coproprietarios 25% cada
    // tinham R$ 250 (DESCONTO proporcional) + R$ 250 (descontoLocatario
    // R$ 1.000 * 25%) — duplicacao silenciosa porque o filter comparava
    // 250 vs 1000 e nao batia.
    const firstRepasseNotes = pendingRepasses[0]?.noteData;
    const firstRepasseDesc = pendingRepasses[0]?.entry?.description || "";
    let dedupeShareRatio = 1;
    if (typeof firstRepasseNotes?.sharePercent === "number" && firstRepasseNotes.sharePercent > 0) {
      dedupeShareRatio = firstRepasseNotes.sharePercent / 100;
    } else {
      const m = firstRepasseDesc.match(/\(([\d.,]+)%\)/);
      if (m) {
        const pct = parseFloat(m[1].replace(",", "."));
        if (Number.isFinite(pct) && pct > 0 && pct < 100) dedupeShareRatio = pct / 100;
      }
    }
    const usedOwnerIdx = new Set<number>();
    const descontosLocatario = descontosLocatarioAll.filter((l) => {
      const valorProporcional = (l.valor || 0) * dedupeShareRatio;
      const idx = ownerDescontoValues.findIndex(
        (ov, i) => !usedOwnerIdx.has(i) && Math.abs(ov - valorProporcional) < 0.01
      );
      if (idx >= 0) { usedOwnerIdx.add(idx); return false; }
      return true;
    });
    const descontoLocatarioTotal = descontosLocatario.reduce((s, l) => s + (l.valor || 0), 0);

    // Outros creditos do locatario (IPTU, condominio, agua, luz, taxas)
    // que viraram cobranca repassada ao owner. Mas se o admin ja propagou
    // como OwnerEntry DEBITO (caso comum: "Chamada Extra Academia" cobrada
    // do locatario E criada como DEBITO no owner), nao duplicar.
    const outrosDebitosOwner = ((g as any)._outrosDebitosOwner || []) as Array<{ value: number; desc: string }>;
    const usedDebitoIdx = new Set<number>();
    const outrosCreditosLocatario = lancsLocatario.filter((l) => {
      if (l.tipo !== "CREDITO" || !l.valor || l.valor <= 0) return false;
      const cat = (l.categoria || "").toUpperCase();
      const desc = (l.descricao || "").toUpperCase();
      if (cat === "DESCONTO" || cat === "ACORDO" || desc.includes("DESCONTO")) return false;
      // Dedupe: se ha OwnerEntry DEBITO nao-desconto com mesmo valor PROPORCIONAL, pula.
      // outrosDebitosOwner.value: ja proporcional (R$ 250 para 25%).
      // l.valor: cheio do contrato (R$ 1.000). Multiplicar pra comparar
      // na mesma escala (mesmo bug do dedupe de descontosLocatario).
      const valorProporcional = (l.valor || 0) * dedupeShareRatio;
      const idx = outrosDebitosOwner.findIndex(
        (od, i) => !usedDebitoIdx.has(i) && Math.abs(od.value - valorProporcional) < 0.01
      );
      if (idx >= 0) { usedDebitoIdx.add(idx); return false; }
      return true;
    });

    // Flag pra evitar duplicacao quando ha mais de um repasse no mesmo
    // contrato (raro: troca de inquilino no meio do mes). Sem isso,
    // pendingDescontos e descontosLocatario eram somados N vezes.
    let descontosJaAdicionados = false;

    // Lookup do contrato pra usar rentalValue como fallback quando
    // notes.aluguelBruto nao existir. Antes, o fallback era e.value
    // (que e o LIQUIDO ja calculado) — gerava aluguel menor que o
    // real + admin fee em cima do valor errado.
    const contractInfo = contractMap.get(contractId);
    const contractRentalValue = (contractInfo as any)?.rentalValue ?? 0;
    const contractAdminPct = (contractInfo as any)?.adminFeePercent ?? null;

    for (const rp of pendingRepasses) {
      const { entry: e, noteData, refDate, dateStr } = rp;
      const refDateObj = new Date(refDate);
      const refY = refDateObj.getMonth() === 0 ? refDateObj.getFullYear() - 1 : refDateObj.getFullYear();
      const refM = (refDateObj.getMonth() + 11) % 12;
      const monthRef = `${String(refM + 1).padStart(2, "0")}/${refY}`;

      // Ordem de prioridade pro bruto total do contrato:
      // 1. notes.aluguelBruto (fonte da verdade quando billing/generate criou)
      // 2. Contract.rentalValue (fallback historico — entries antigas sem notes)
      // 3. e.value (ultima opcao — mas e o LIQUIDO ja calculado, gera erro
      //    no recalculo de admin fee. So usa se nada mais disponivel.)
      const brutoTotalContrato =
        noteData?.aluguelBruto ||
        (contractRentalValue > 0 ? contractRentalValue : e.value);
      const adminFeePercent = noteData?.adminFeePercent ?? contractAdminPct ?? 10;
      // Tenta sharePercent das notes; senao, extrai da description "(X%)".
      // Caso historico: repair-coowner-repasses corrigiu o value mas nao
      // persistiu sharePercent nas notes — sem fallback, o demonstrativo
      // multiplicava por 100% e mostrava o valor cheio do contrato.
      let sharePercent = noteData?.sharePercent;
      if (typeof sharePercent !== "number" || sharePercent <= 0) {
        const descMatch = e.description?.match(/\(([\d.,]+)%\)/);
        if (descMatch) {
          const pct = parseFloat(descMatch[1].replace(",", "."));
          if (Number.isFinite(pct) && pct > 0 && pct < 100) {
            sharePercent = pct;
          }
        }
      }
      if (typeof sharePercent !== "number" || sharePercent <= 0) sharePercent = 100;
      const shareRatio = sharePercent / 100;
      const isPartial = sharePercent < 100;
      const shareLabel = isPartial ? ` (${sharePercent}%)` : "";

      const bruto = Math.round(brutoTotalContrato * shareRatio * 100) / 100;
      const descontoLocatarioProprio = Math.round(descontoLocatarioTotal * shareRatio * 100) / 100;
      const descontoProprio = descontoOwnerEntries + descontoLocatarioProprio;
      const brutoLiquido = Math.max(0, bruto - descontoProprio);
      // Fix Leo 13/05: respeitar adminWaived das notes do REPASSE.
      // Quando contrato tem intermediacao no mes, admin = 0 (regra Leo).
      // Demonstrativo precisa bater EXATO com o repasse.
      const adminWaived = noteData?.adminWaived === true || noteData?.adminFeeValue === 0;
      const adminFeeRecalc = adminWaived ? 0 : Math.round((brutoLiquido * adminFeePercent / 100) * 100) / 100;

      let irrfRecalc = 0;
      const irrfOriginal = noteData?.irrfValue || 0;
      const adminTotalOriginal = noteData?.adminFeeValue || 0;
      const grossOwnerOriginalContrato = brutoTotalContrato - adminTotalOriginal;
      if (irrfOriginal > 0 && grossOwnerOriginalContrato > 0) {
        const grossOwnerRecalc = brutoLiquido - adminFeeRecalc;
        const irrfRateTotal = irrfOriginal / grossOwnerOriginalContrato;
        irrfRecalc = Math.round(grossOwnerRecalc * irrfRateTotal * 100) / 100;
      }

      if (bruto > 0) {
        g.movimentos.push({
          date: dateStr,
          descricao: `Aluguel Ref ${monthRef}${shareLabel}`,
          entrada: bruto,
          saida: 0,
        });
        g.totalEntradas += bruto;
        g.aluguelBruto += bruto;
        g.aluguelLiquido += brutoLiquido;
      }

      // Descontos do proprio proprietario e descontos do locatario que
      // foram repassados — adicionar UMA UNICA VEZ por contrato, mesmo
      // que haja mais de um pendingRepasse (raro: troca de inquilino).
      if (!descontosJaAdicionados) {
        for (const d of pendingDescontos) {
          g.movimentos.push({
            date: d.dateStr,
            descricao: d.entry.description,
            entrada: 0,
            saida: d.entry.value,
          });
          g.totalSaidas += d.entry.value;
        }

        for (const l of descontosLocatario) {
          const valorProprio = Math.round((l.valor || 0) * shareRatio * 100) / 100;
          if (valorProprio <= 0) continue;
          const descText = `${l.descricao || "Desconto"} Ref ${monthRef}${shareLabel}`;
          g.movimentos.push({ date: dateStr, descricao: descText, entrada: 0, saida: valorProprio });
          g.totalSaidas += valorProprio;
        }
      }

      if (adminFeeRecalc > 0) {
        g.movimentos.push({
          date: dateStr,
          descricao: `Taxa de Administracao Aluguel Ref ${monthRef}${shareLabel}`,
          entrada: 0,
          saida: adminFeeRecalc,
        });
        g.totalSaidas += adminFeeRecalc;
        g.adminFee += adminFeeRecalc;
      }

      if (irrfRecalc > 0) {
        g.movimentos.push({
          date: dateStr,
          descricao: `IRRF Retido na Fonte Ref ${monthRef}${shareLabel}`,
          entrada: 0,
          saida: irrfRecalc,
        });
        g.totalSaidas += irrfRecalc;
        g.irrf += irrfRecalc;
      }

      // Outros creditos do locatario (IPTU, condominio, agua, luz que ele
      // pagou e foram retidos pra cobrir terceiros). Tambem uma vez so.
      if (!descontosJaAdicionados) {
        for (const l of outrosCreditosLocatario) {
          const valorProprio = Math.round((l.valor || 0) * shareRatio * 100) / 100;
          if (valorProprio <= 0) continue;
          g.movimentos.push({
            date: dateStr,
            descricao: l.descricao || "Credito",
            entrada: 0,
            saida: valorProprio,
          });
          g.totalSaidas += valorProprio;
        }
      }
      descontosJaAdicionados = true;

      // Juros/multa por atraso (Lei do Leo: dia <= 10 = imob; dia > 10 = owner; aluguel garantido = imob sempre)
      // Adicionar apenas uma vez por contrato — descontosJaAdicionados
      // ja foi setado true acima, entao aqui usamos a mesma protecao.
      const fi = fineInterestByContract.get(contractId);
      if (fi && (rp === pendingRepasses[0])) {
        const dataPagto = fi.paidAt
          ? new Date(fi.paidAt).toLocaleDateString("pt-BR", { timeZone: "UTC" })
          : dateStr;
        // ENTRADAS — quando juros/multa foi REPASSADO ao proprietario
        const jurosOwner = Math.round(fi.interestToOwner * shareRatio * 100) / 100;
        const multaOwner = Math.round(fi.fineToOwner * shareRatio * 100) / 100;
        if (jurosOwner > 0) {
          g.movimentos.push({
            date: dataPagto,
            descricao: `Juros por atraso Ref ${monthRef}${shareLabel}`,
            entrada: jurosOwner,
            saida: 0,
          });
          g.totalEntradas += jurosOwner;
        }
        if (multaOwner > 0) {
          g.movimentos.push({
            date: dataPagto,
            descricao: `Multa por atraso Ref ${monthRef}${shareLabel}`,
            entrada: multaOwner,
            saida: 0,
          });
          g.totalEntradas += multaOwner;
        }
        // INFO — quando juros/multa foi RETIDO pela imobiliaria
        // (nao soma nos totais, eh apenas nota de transparencia)
        const jurosImob = Math.round(fi.interestToImob * shareRatio * 100) / 100;
        const multaImob = Math.round(fi.fineToImob * shareRatio * 100) / 100;
        if (jurosImob + multaImob > 0) {
          (g as any).infoRetidoPelaImobiliaria = {
            juros: jurosImob,
            multa: multaImob,
            total: jurosImob + multaImob,
          };
        }
      }
    }

    delete (g as any)._pendingRepasses;
    delete (g as any)._pendingDescontos;
    delete (g as any)._outrosDebitosOwner;
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const gruposArray = Array.from(groups.values()).map((g) => ({
    ...g,
    totalEntradas: round2(g.totalEntradas),
    totalSaidas: round2(g.totalSaidas),
    totalLiquido: round2(g.totalEntradas - g.totalSaidas),
    aluguelBruto: round2(g.aluguelBruto),
    aluguelLiquido: round2(g.aluguelLiquido),
    adminFee: round2(g.adminFee),
    irrf: round2(g.irrf),
  }));

  const totalFinalEntradas = round2(
    gruposArray.reduce((s, g) => s + g.totalEntradas, 0) + avulsasEntrada
  );
  const totalFinalSaidas = round2(
    gruposArray.reduce((s, g) => s + g.totalSaidas, 0) + avulsasSaida
  );
  const totalMovimento = round2(totalFinalEntradas - totalFinalSaidas);

  const pf = { aluguel: 0, comissao: 0, irrf: 0 };
  const pj = { aluguel: 0, comissao: 0, irrf: 0 };
  for (const g of gruposArray) {
    const isPJ = g.tenant?.personType === "PJ";
    const target = isPJ ? pj : pf;
    target.aluguel += g.aluguelLiquido;
    target.comissao += g.adminFee;
    target.irrf += g.irrf;
  }
  pf.aluguel = round2(pf.aluguel);
  pf.comissao = round2(pf.comissao);
  pf.irrf = round2(pf.irrf);
  pj.aluguel = round2(pj.aluguel);
  pj.comissao = round2(pj.comissao);
  pj.irrf = round2(pj.irrf);

  const beneficiarioName = owner.thirdPartyName || owner.name;
  const chavePix = owner.thirdPartyPix || owner.bankPix;
  const pixType = owner.thirdPartyPixKeyType || owner.bankPixType;
  const bankInfo = owner.thirdPartyBank || owner.bankName;
  const bankAgency = owner.thirdPartyAgency || owner.bankAgency;
  const bankAccount = owner.thirdPartyAccount || owner.bankAccount;
  const formaPagamento = chavePix ? "PIX" : bankAgency && bankAccount ? "TED" : "-";

  const paidAtDates = entries
    .map((e) => e.paidAt)
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime());
  const dataReferencia = paidAtDates[0]
    ? paidAtDates[0].toLocaleDateString("pt-BR", { timeZone: "UTC" })
    : "-";

  return {
    ok: true,
    data: {
      periodo: {
        start: periodStart,
        end: periodEnd,
        month: mLabel,
        mesReferencia: mLabel,
        mesVencimento: `${String(targetMonth + 1).padStart(2, "0")}/${targetYear}`,
      },
      empresa: {
        nome: "Somma Imoveis Ltda",
        cnpj: "40.528.068/0001-62",
      },
      proprietario: {
        id: owner.id,
        name: owner.name,
        cpfCnpj: owner.cpfCnpj,
        personType: owner.personType,
      },
      dataReferenciaPagamento: dataReferencia,
      contratos: gruposArray,
      avulsas,
      totais: {
        entradas: totalFinalEntradas,
        saidas: totalFinalSaidas,
        movimento: totalMovimento,
        saldoMesAnterior: 0,
        valorRetido: 0,
        totalPago: totalMovimento,
      },
      totaisPFPJ: { pf, pj },
      pagamento: {
        beneficiario: beneficiarioName,
        data: dataReferencia,
        forma: formaPagamento,
        chavePix: chavePix || "",
        pixType: pixType || "",
        bank: bankInfo || "",
        agency: bankAgency || "",
        account: bankAccount || "",
        valor: totalMovimento,
      },
      // Split de beneficiarios: lista quem mais recebe parte do liquido
      // (caso Roberta — paga 100% do imposto mas reparte com a irma).
      // Mostra como OBSERVACAO no demonstrativo, sem afetar valores
      // fiscais (IRRF, totais, etc) — Owner continua sendo o unico
      // contribuinte. Reuniao 12/05/2026.
      splitBeneficiarios: ((owner as any).payoutBeneficiaries || []).length > 0
        ? {
            ownerNome: owner.name,
            ownerPercent: Math.max(
              0,
              100 - ((owner as any).payoutBeneficiaries || []).reduce(
                (s: number, b: any) => s + (b.percentage || 0),
                0
              )
            ),
            beneficiarios: ((owner as any).payoutBeneficiaries || []).map((b: any) => ({
              nome: b.name,
              percentual: b.percentage,
              chavePix: b.pixKey,
              tipoChavePix: b.pixKeyType,
              valorEstimado: Math.round((totalMovimento * (b.percentage || 0) / 100) * 100) / 100,
            })),
            valorOwnerEstimado: Math.round(
              (totalMovimento *
                Math.max(0, 100 - ((owner as any).payoutBeneficiaries || []).reduce(
                  (s: number, b: any) => s + (b.percentage || 0),
                  0
                )) /
                100) *
                100
            ) / 100,
            observacao: "O proprietario e responsavel por 100% da declaracao fiscal. O split acima e apenas a divisao do liquido para fins de PIX.",
          }
        : null,
    },
  };
}
