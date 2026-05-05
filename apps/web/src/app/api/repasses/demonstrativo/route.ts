import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

/**
 * GET /api/repasses/demonstrativo?ownerId=X&month=YYYY-MM
 * Retorna demonstrativo DETALHADO de pagamentos do proprietario no mes.
 * Formato inspirado no padrao Via Imob (usado pelas contadoras).
 *
 * Agrupa por CONTRATO/IMOVEL, mostra para cada:
 * - Locatario, CPF/CNPJ
 * - Dt inicio e ult. reajuste
 * - Tipo do imovel (loja, sala, casa, etc)
 * - Endereco
 * - Lista de movimentos (entradas e saidas) com data
 * - Totais do contrato
 *
 * E os grandes totais:
 * - Total entradas, saidas, liquido
 * - Separacao PF/PJ para IRRF
 * - Info do pagamento (beneficiario, data, forma, valor)
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const ownerId = searchParams.get("ownerId");
    const monthStr = searchParams.get("month");

    if (!ownerId) {
      return NextResponse.json({ error: "ownerId obrigatorio" }, { status: 400 });
    }

    // O parametro `month` representa o MES DO BOLETO (vencimento) — o
    // mesmo mes que o usuario seleciona no filtro. O mes de REFERENCIA
    // do aluguel eh o mes ANTERIOR (cobranca in-arrears).
    //
    // Ex: month=2026-04 (boletos vencendo em abril) → aluguel referente
    //     a marco/2026. Label do demonstrativo: "Mes Referencia: 03/2026".
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

    // refMonth = targetMonth - 1 (= mes do aluguel cobrado in-arrears)
    let refYear = targetYear;
    let refMonth = targetMonth - 1;
    if (refMonth < 0) {
      refMonth = 11;
      refYear -= 1;
    }

    const monthStart = new Date(targetYear, targetMonth, 1);
    const monthEnd = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59, 999);
    // Label mostra o mes de REFERENCIA do aluguel (= mes anterior ao venc)
    const mLabel = `${String(refMonth + 1).padStart(2, "0")}/${refYear}`;
    const periodStart = monthStart.toLocaleDateString("pt-BR", { timeZone: "UTC" });
    const periodEnd = monthEnd.toLocaleDateString("pt-BR", { timeZone: "UTC" });

    const owner = await prisma.owner.findUnique({
      where: { id: ownerId },
    });
    if (!owner) {
      return NextResponse.json({ error: "Proprietario nao encontrado" }, { status: 404 });
    }

    // Buscar TODAS as entries do proprietario no mes (creditos E debitos)
    const entries = await prisma.ownerEntry.findMany({
      where: {
        ownerId,
        OR: [
          { dueDate: { gte: monthStart, lte: monthEnd } },
          {
            AND: [{ dueDate: null }, { paidAt: { gte: monthStart, lte: monthEnd } }],
          },
          { paidAt: { gte: monthStart, lte: monthEnd } },
        ],
        status: { not: "CANCELADO" },
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    });

    // Buscar contratos
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
              select: {
                id: true,
                name: true,
                cpfCnpj: true,
                personType: true,
              },
            },
          },
        })
      : [];
    const contractMap = new Map(contracts.map((c) => [c.id, c]));

    // Buscar Payments do mes para estes contratos, para extrair lancamentos do locatario
    // (descontos, creditos etc que afetam o repasse mas estao apenas no Payment)
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
            notes: true,
          },
        })
      : [];
    // Agrupar lancamentos do Payment por contractId
    type TenantLanc = {
      id?: string;
      tipo?: string;      // DEBITO | CREDITO
      categoria?: string; // DESCONTO, IPTU, etc
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
      } catch {
        // notes nao eh JSON
      }
    }

    // Agrupar por contrato (imovel)
    type Movimento = {
      date: string;
      descricao: string;
      entrada: number;
      saida: number;
    };

    type ContractGroup = {
      contractId: string;
      code: string;
      property: {
        id: string;
        title: string;
        type: string;
        address: string;
      } | null;
      tenant: {
        id: string;
        name: string;
        cpfCnpj: string;
        personType: string;
      } | null;
      startDate: string | null;
      lastAdjustmentDate: string | null;
      movimentos: Movimento[];
      totalEntradas: number;
      totalSaidas: number;
      totalLiquido: number;
      // Para totais PF/PJ
      aluguelBruto: number;       // aluguel bruto (sem desconto)
      aluguelLiquido: number;     // aluguel liquido (ja considerando desconto)
      adminFee: number;
      irrf: number;
    };

    const groups = new Map<string, ContractGroup>();

    // Entries avulsas (sem contrato) vao para um grupo "outros"
    const avulsas: Movimento[] = [];
    let avulsasEntrada = 0;
    let avulsasSaida = 0;

    // Buscar TODOS os contratos relacionados ao proprietario para fazer fallback por description
    // Inclui:
    //   1) Contratos onde eh proprietario principal (ownerId)
    //   2) Contratos de imoveis onde eh co-proprietario (via PropertyOwner)
    const [ownContracts, propertyShares] = await Promise.all([
      prisma.contract.findMany({
        where: { ownerId },
        select: { id: true, code: true },
      }),
      prisma.propertyOwner.findMany({
        where: { ownerId },
        select: { propertyId: true },
      }),
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

    // Helper: tentar achar o contractId por codigo no description
    function resolveContractFromDescription(desc: string): string | null {
      const match = desc.match(/CTR[-\s]?(\d+)/i);
      if (!match) return null;
      const code = `CTR-${match[1]}`;
      return contractCodeMap.get(code) || null;
    }

    for (const e of entries) {
      const refDate = e.paidAt || e.dueDate || monthStart;
      const dateStr = new Date(refDate).toLocaleDateString("pt-BR", { timeZone: "UTC" });
      const value = e.value;

      // Interpretar notes se for JSON
      let noteData: any = null;
      if (e.notes) {
        try {
          noteData = JSON.parse(e.notes);
        } catch {
          // notes nao e JSON
        }
      }

      // Tentar resolver contractId: primeiro do campo, senao pela descricao
      let resolvedContractId = e.contractId;
      if (!resolvedContractId || !contractMap.has(resolvedContractId)) {
        const fromDesc = resolveContractFromDescription(e.description);
        if (fromDesc) {
          resolvedContractId = fromDesc;
          // Se esse contrato ainda nao esta no map, buscar
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
                tenant: {
                  select: { id: true, name: true, cpfCnpj: true, personType: true },
                },
              },
            });
            if (fullContract) {
              contractMap.set(fromDesc, fullContract);
            } else {
              resolvedContractId = null;
            }
          }
        }
      }

      if (!resolvedContractId || !contractMap.has(resolvedContractId)) {
        // Entry sem contrato (taxa avulsa, acordo, etc)
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

      // Usar resolvedContractId daqui pra frente
      const useContractId = resolvedContractId;

      const contract = contractMap.get(useContractId)!;
      if (!groups.has(useContractId)) {
        const p = contract.property;
        const addr = p
          ? [
              p.street ? `${p.street}${p.number ? ` ${p.number}` : ""}${p.complement ? ` ${p.complement}` : ""}` : null,
              p.neighborhood,
              p.city && p.state ? `${p.city}/${p.state}` : p.city,
            ]
              .filter(Boolean)
              .join(", ")
          : "";

        groups.set(useContractId, {
          contractId: contract.id,
          code: contract.code,
          property: p
            ? {
                id: p.id,
                title: p.title,
                type: p.type,
                address: addr,
              }
            : null,
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

      // Classificar entries: REPASSE vai ser processado depois (precisa agregacao de descontos)
      // DEBITOs de desconto tambem. Outros vao direto para movimentos.
      const isCredit = e.type === "CREDITO";
      const isRepasse = isCredit && e.category === "REPASSE";
      const categoriaUp = (e.category || "").toUpperCase();
      const descricaoUp = (e.description || "").toUpperCase();
      const isDesconto =
        e.type === "DEBITO" &&
        (categoriaUp === "DESCONTO" ||
          categoriaUp === "ACORDO" ||
          descricaoUp.includes("DESCONTO"));

      if (isRepasse || isDesconto) {
        // Sera processado no proximo passo (agregando tudo por contrato)
        // Armazenar no grupo para processamento posterior
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
        // Entry normal (DEBITO nao-desconto, CREDITO nao-REPASSE, etc)
        const g = groups.get(useContractId)!;
        g.movimentos.push({
          date: dateStr,
          descricao: e.description,
          entrada: isCredit ? value : 0,
          saida: isCredit ? 0 : value,
        });
        if (isCredit) g.totalEntradas += value;
        else g.totalSaidas += value;
      }
    }

    // SEGUNDO PASSO: processar REPASSEs com descontos agregados
    // Para cada contrato, calcular:
    //   aluguel liquido = bruto - descontos (OwnerEntry DEBITO desconto + Payment lancamentos CREDITO)
    //   taxa adm = liquido × adminFeePercent%
    //   IRRF = sobre (liquido - taxa adm)
    for (const [contractId, g] of groups.entries()) {
      const pendingRepasses = ((g as any)._pendingRepasses || []) as Array<{
        entry: any;
        noteData: any;
        refDate: Date;
        dateStr: string;
      }>;
      const pendingDescontos = ((g as any)._pendingDescontos || []) as Array<{
        entry: any;
        refDate: Date;
        dateStr: string;
      }>;

      if (pendingRepasses.length === 0) {
        // Sem REPASSE nesse mes: apenas adicionar descontos como saidas simples
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

      // Somar descontos do proprietario (OwnerEntry DEBITO)
      const descontoOwnerEntries = pendingDescontos.reduce(
        (s, d) => s + d.entry.value,
        0
      );

      // Somar descontos do locatario (Payment.notes.lancamentos CREDITO tipo DESCONTO)
      const lancsLocatario = paymentLancByContract.get(contractId) || [];
      const descontosLocatarioAll = lancsLocatario.filter((l) => {
        if (l.tipo !== "CREDITO" || !l.valor || l.valor <= 0) return false;
        const cat = (l.categoria || "").toUpperCase();
        const desc = (l.descricao || "").toUpperCase();
        return cat === "DESCONTO" || cat === "ACORDO" || desc.includes("DESCONTO");
      });

      // DEDUPLICACAO: se o desconto do locatario ja esta representado como
      // OwnerEntry DEBITO (mesmo valor, tolerancia 0.01), ignoramos para nao
      // contar 2x. Caso comum: o usuario cria manualmente um "Desconto" no
      // proprietario alem do desconto que ja veio no boleto.
      const ownerDescontoValues = pendingDescontos.map((d) => d.entry.value);
      const usedOwnerIdx = new Set<number>();
      const descontosLocatario = descontosLocatarioAll.filter((l) => {
        const v = l.valor || 0;
        const idx = ownerDescontoValues.findIndex(
          (ov, i) => !usedOwnerIdx.has(i) && Math.abs(ov - v) < 0.01
        );
        if (idx >= 0) {
          usedOwnerIdx.add(idx);
          return false; // ja contabilizado como OwnerEntry DEBITO
        }
        return true;
      });
      const descontoLocatarioTotal = descontosLocatario.reduce(
        (s, l) => s + (l.valor || 0),
        0
      );

      // Outros CREDITOs do locatario (nao descontos) sao saidas simples
      const outrosCreditosLocatario = lancsLocatario.filter((l) => {
        if (l.tipo !== "CREDITO" || !l.valor || l.valor <= 0) return false;
        const cat = (l.categoria || "").toUpperCase();
        const desc = (l.descricao || "").toUpperCase();
        return !(cat === "DESCONTO" || cat === "ACORDO" || desc.includes("DESCONTO"));
      });

      // Processar cada REPASSE
      for (const rp of pendingRepasses) {
        const { entry: e, noteData, refDate, dateStr } = rp;
        // Mes de REFERENCIA do aluguel = mes anterior ao vencimento
        // (cobranca in-arrears: boleto vence em maio cobrando aluguel
        // de abril). monthRef deve ser "04/2026", nao "05/2026".
        const refDateObj = new Date(refDate);
        const refY = refDateObj.getMonth() === 0 ? refDateObj.getFullYear() - 1 : refDateObj.getFullYear();
        const refM = (refDateObj.getMonth() + 11) % 12;
        const monthRef = `${String(refM + 1).padStart(2, "0")}/${refY}`;

        const brutoTotalContrato = noteData?.aluguelBruto || e.value;
        const adminFeePercent = noteData?.adminFeePercent || 10;
        const sharePercent = noteData?.sharePercent || 100;
        const shareRatio = sharePercent / 100;
        const isPartial = sharePercent < 100;
        const shareLabel = isPartial ? ` (${sharePercent}%)` : "";

        // Aluguel bruto do proprietario (aplicando share)
        const bruto = Math.round(brutoTotalContrato * shareRatio * 100) / 100;

        // Desconto proporcional a cota:
        // - OwnerEntry DEBITO ja eh do proprietario (valor dele, sem multiplicar)
        // - Payment lancamentos eh valor TOTAL do contrato, aplica share
        const descontoLocatarioProprio = Math.round(
          descontoLocatarioTotal * shareRatio * 100
        ) / 100;
        const descontoProprio = descontoOwnerEntries + descontoLocatarioProprio;

        // Aluguel liquido (ja na cota do proprietario)
        const brutoLiquido = Math.max(0, bruto - descontoProprio);

        // Taxa adm recalculada sobre aluguel liquido (do proprietario)
        const adminFeeRecalc = Math.round((brutoLiquido * adminFeePercent / 100) * 100) / 100;

        // IRRF recalculado: mantem a proporcao do IRRF original em relacao ao bruto do owner
        let irrfRecalc = 0;
        const irrfOriginal = noteData?.irrfValue || 0;
        const adminTotalOriginal = noteData?.adminFeeValue || 0;
        const grossOwnerOriginalContrato = brutoTotalContrato - adminTotalOriginal;
        if (irrfOriginal > 0 && grossOwnerOriginalContrato > 0) {
          const grossOwnerRecalc = brutoLiquido - adminFeeRecalc;
          // IRRF proporcional: (irrfOriginal/grossOriginal) * grossOwnerRecalc
          // IRRF original tambem deveria refletir share, mas seguimos proporcao
          const irrfRateTotal = irrfOriginal / grossOwnerOriginalContrato;
          irrfRecalc = Math.round(grossOwnerRecalc * irrfRateTotal * 100) / 100;
        }

        // Entrada: aluguel bruto (com cota aplicada)
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

        // Saida: descontos (OwnerEntry DEBITO desconto — ja eh do proprietario)
        for (const d of pendingDescontos) {
          g.movimentos.push({
            date: d.dateStr,
            descricao: d.entry.description,
            entrada: 0,
            saida: d.entry.value,
          });
          g.totalSaidas += d.entry.value;
        }

        // Saida: descontos (Payment lancamentos CREDITO tipo DESCONTO — aplicar share)
        for (const l of descontosLocatario) {
          const valorProprio = Math.round((l.valor || 0) * shareRatio * 100) / 100;
          if (valorProprio <= 0) continue;
          const descText = `${l.descricao || "Desconto"} Ref ${monthRef}${shareLabel}`;
          g.movimentos.push({
            date: dateStr,
            descricao: descText,
            entrada: 0,
            saida: valorProprio,
          });
          g.totalSaidas += valorProprio;
        }

        // Saida: taxa de administracao (recalculada sobre liquido do proprietario)
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

        // Saida: IRRF (recalculado com share)
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

        // Outros creditos do locatario (nao descontos) — aplicar share
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

      // Limpar campos temporarios
      delete (g as any)._pendingRepasses;
      delete (g as any)._pendingDescontos;
    }

    // Calcular totais liquidos por contrato
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

    // Grand totais
    const totalFinalEntradas = round2(
      gruposArray.reduce((s, g) => s + g.totalEntradas, 0) + avulsasEntrada
    );
    const totalFinalSaidas = round2(
      gruposArray.reduce((s, g) => s + g.totalSaidas, 0) + avulsasSaida
    );
    const totalMovimento = round2(totalFinalEntradas - totalFinalSaidas);

    // Separar PF / PJ para a tabela de IR
    const pf = { aluguel: 0, comissao: 0, irrf: 0 };
    const pj = { aluguel: 0, comissao: 0, irrf: 0 };
    for (const g of gruposArray) {
      const isPJ = g.tenant?.personType === "PJ";
      const target = isPJ ? pj : pf;
      // Usar aluguel LIQUIDO (com desconto aplicado) como base para IR
      // Assim o "Total I.R." = aluguelLiquido - comissao reflete o valor real
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

    // Info de pagamento (beneficiario, chave pix)
    const beneficiarioName = owner.thirdPartyName || owner.name;
    const chavePix = owner.thirdPartyPix || owner.bankPix;
    const pixType = owner.thirdPartyPixKeyType || owner.bankPixType;
    const bankInfo = owner.thirdPartyBank || owner.bankName;
    const bankAgency = owner.thirdPartyAgency || owner.bankAgency;
    const bankAccount = owner.thirdPartyAccount || owner.bankAccount;
    const formaPagamento = chavePix ? "PIX" : bankAgency && bankAccount ? "TED" : "-";

    // Data de referencia do pagamento: maior paidAt entre entries ou dia de pagamento do proprietario
    const paidAtDates = entries
      .map((e) => e.paidAt)
      .filter((d): d is Date => !!d)
      .sort((a, b) => b.getTime() - a.getTime());
    const dataReferencia = paidAtDates[0]
      ? paidAtDates[0].toLocaleDateString("pt-BR", { timeZone: "UTC" })
      : "-";

    return NextResponse.json({
      periodo: {
        start: periodStart,
        end: periodEnd,
        month: mLabel,           // Mes de REFERENCIA (aluguel cobrado)
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
    });
  } catch (error) {
    console.error("[Demonstrativo]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro" },
      { status: 500 }
    );
  }
}
