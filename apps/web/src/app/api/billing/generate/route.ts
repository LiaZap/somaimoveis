import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { consolidateIRRFByOwnerMonth } from "@/lib/fiscal-consolidate";
import { nextBusinessDay } from "@/lib/business-days";

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
    const body = await request.json().catch(() => ({}));
    const monthStr = body.month as string | undefined;
    // Lista opcional de codigos de contrato para gerar — se vazia/ausente,
    // gera para todos. Permite o usuario selecionar especificos no dialog.
    const contractCodesFilter: string[] | undefined = Array.isArray(body.contractCodes)
      ? body.contractCodes.filter((c: unknown) => typeof c === "string" && c.length > 0)
      : undefined;

    // ============================================================
    // COBRANCA EM ATRASO (in-arrears)
    // ============================================================
    // O parametro `month` indica o MES DO VENCIMENTO do boleto.
    // O boleto cobra o aluguel do MES ANTERIOR (referenceMonth).
    //
    // Ex: month=2026-05 → boletos vencem em maio cobrando aluguel de abril.
    // Contrato que comecou 20/04: ao gerar maio, cobra pro-rata de abril
    // (11 dias = R$ 1.100). Em junho cobra maio cheio (R$ 3.000).
    // ============================================================
    let targetYear: number;
    let targetMonth: number; // 0-indexed (mes do vencimento)

    if (monthStr && /^\d{4}-\d{2}$/.test(monthStr)) {
      const [y, m] = monthStr.split("-").map(Number);
      targetYear = y;
      targetMonth = m - 1;
    } else {
      // Default: next month
      const now = new Date();
      targetYear = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
      targetMonth = (now.getMonth() + 1) % 12;
    }

    // Reference month = targetMonth - 1 (o mes que sera cobrado)
    let refYear = targetYear;
    let refMonth = targetMonth - 1;
    if (refMonth < 0) {
      refMonth = 11;
      refYear -= 1;
    }
    const refMonthStart = new Date(refYear, refMonth, 1);
    const refMonthEnd = new Date(refYear, refMonth + 1, 0, 23, 59, 59, 999);
    const refDaysInMonth = new Date(refYear, refMonth + 1, 0).getDate();

    // Range do mes de vencimento (para checar duplicatas pelo dueDate)
    const monthStart = new Date(targetYear, targetMonth, 1);
    const monthEnd = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59, 999);

    // Contratos: status ATIVO ou PENDENTE_RENOVACAO, ja existentes no mes de referencia.
    // NAO filtra por endDate: contrato 'vencido' (endDate no passado) com status
    // ATIVO segue gerando cobranca, ja que o locatario continua no imovel ate
    // que o status seja mudado para ENCERRADO/RESCINDIDO manualmente.
    // RESCINDIDO/ENCERRADO/CANCELADO NUNCA geram cobranca.
    const contracts = await prisma.contract.findMany({
      where: {
        status: { in: ["ATIVO", "PENDENTE_RENOVACAO"] },
        startDate: { lte: refMonthEnd },
        ...(contractCodesFilter && contractCodesFilter.length > 0
          ? { code: { in: contractCodesFilter } }
          : {}),
      },
      include: {
        property: {
          select: {
            id: true,
            title: true,
            condoFee: true,
            iptuValue: true,
          },
        },
        tenant: { select: { name: true, personType: true } },
        owner: { select: { name: true, personType: true } },
      },
    });

    if (contracts.length === 0) {
      return NextResponse.json({
        generated: 0,
        skipped: 0,
        errors: [],
        message: "Nenhum contrato ativo encontrado para este periodo.",
      });
    }

    // Find existing payments for this month to avoid duplicates
    const existingPayments = await prisma.payment.findMany({
      where: {
        dueDate: { gte: monthStart, lte: monthEnd },
        status: { not: "CANCELADO" },
      },
      select: { contractId: true },
    });
    const existingContractIds = new Set(existingPayments.map((p) => p.contractId));

    // Get the highest payment code number to continue sequence
    const allCodes = await prisma.payment.findMany({
      select: { code: true },
    });
    let nextNumber = 1;
    for (const p of allCodes) {
      const match = p.code.match(/PAG-(\d+)/);
      if (match) {
        const num = parseInt(match[1]);
        if (num >= nextNumber) nextNumber = num + 1;
      }
    }

    let generated = 0;
    let skipped = 0;
    const errors: { contract: string; message: string }[] = [];
    // Lista detalhada de contratos pulados com motivo
    const skippedDetails: {
      contract: string;
      tenant: string | null;
      reason: string;
    }[] = [];

    for (const contract of contracts) {
      const contractCode = contract.code;
      const tenantName = (contract as any).tenant?.name || null;

      // Skip contracts without tenant (e.g. ADMINISTRACAO, VISTORIA)
      if (!contract.tenantId) {
        skipped++;
        skippedDetails.push({
          contract: contractCode,
          tenant: null,
          reason: `Contrato sem locatario vinculado (tipo ${contract.type || "desconhecido"})`,
        });
        continue;
      }
      // Skip if payment already exists for this contract+month
      if (existingContractIds.has(contract.id)) {
        skipped++;
        skippedDetails.push({
          contract: contractCode,
          tenant: tenantName,
          reason: "Ja existe cobranca para este contrato neste mes",
        });
        continue;
      }

      try {
        // Calculate due date using paymentDay (no mes de vencimento = targetMonth)
        let paymentDay = contract.paymentDay || 10;
        const lastDayOfMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
        if (paymentDay > lastDayOfMonth) paymentDay = lastDayOfMonth;

        // Se vencimento cair em final de semana ou feriado, mover para proximo dia util
        const rawDueDate = new Date(targetYear, targetMonth, paymentDay, 12, 0, 0);
        const dueDate = nextBusinessDay(rawDueDate);

        // ============================================================
        // PRO-RATA: contrato que comecou ou terminou no meio do mes
        // de REFERENCIA (mes que esta sendo cobrado, nao mes do vencimento)
        // ============================================================
        const contractStart = new Date(contract.startDate);
        const contractEnd = contract.endDate ? new Date(contract.endDate) : null;
        // Normalizar para evitar problemas de timezone (usar UTC)
        const csYear = contractStart.getUTCFullYear();
        const csMonth = contractStart.getUTCMonth();
        const csDay = contractStart.getUTCDate();

        let prorataDays = 30; // padrão: mês cheio (base 30)
        let isProrata = false;

        // Primeiro mês do contrato: início no meio do mês de referencia
        if (csYear === refYear && csMonth === refMonth && csDay > 1) {
          prorataDays = refDaysInMonth - csDay + 1;
          isProrata = true;
        }

        // Último mês do contrato: término no meio do mês de referencia.
        // SO aplica se o contrato esta ENCERRADO (terminou de fato).
        // Contratos com status ATIVO ou PENDENTE_RENOVACAO seguem em vigencia
        // (renovacao automatica), entao cobram mes cheio mesmo com endDate
        // no passado/no mes corrente.
        if (contractEnd && contract.status === "ENCERRADO") {
          const ceYear = contractEnd.getUTCFullYear();
          const ceMonth = contractEnd.getUTCMonth();
          const ceDay = contractEnd.getUTCDate();
          if (ceYear === refYear && ceMonth === refMonth && ceDay < refDaysInMonth) {
            if (isProrata) {
              // Começou e terminou no mesmo mês
              prorataDays = ceDay - csDay + 1;
            } else {
              prorataDays = ceDay;
              isProrata = true;
            }
          }
        }

        const dailyRate = contract.rentalValue / 30;
        const prorataRentalValue = isProrata
          ? Math.round(dailyRate * prorataDays * 100) / 100
          : contract.rentalValue;

        if (isProrata) {
          console.log(`[Billing] Pro-rata ${contract.code}: ref=${String(refMonth + 1).padStart(2, "0")}/${refYear}, dias=${prorataDays}, aluguel=${contract.rentalValue} → ${prorataRentalValue}`);
        }

        // Calculate condominium and IPTU values
        const condoFee = contract.property?.condoFee || 0;
        const iptuMonthly = contract.property?.iptuValue
          ? Math.round((contract.property.iptuValue / 12) * 100) / 100
          : 0;

        // Check for pending tenant entries (CREDITO = discount, DEBITO = extra charge)
        // Include entries with dueDate in target month OR entries without dueDate (applied to next billing)
        const tenantEntries = await prisma.tenantEntry.findMany({
          where: {
            tenantId: contract.tenantId,
            status: "PENDENTE",
            OR: [
              {
                dueDate: {
                  gte: new Date(targetYear, targetMonth, 1),
                  lt: new Date(targetYear, targetMonth + 1, 1),
                },
              },
              { dueDate: null },
            ],
          },
        });
        // Fix Leo 13/05/2026: caso bilateral - OwnerEntry destination=LOCATARIO
        // afeta o boleto do inquilino. Conceito: "debito pro proprietario por
        // desconto, credito pro inquilino".
        // Ex: Owner DEBITO desconto destination=LOCATARIO -> tenant CREDITO
        //     (inquilino paga menos no boleto)
        // Ex: Owner CREDITO destination=LOCATARIO -> tenant DEBITO (paga mais)
        const ownerEntriesForTenant = await prisma.ownerEntry.findMany({
          where: {
            ownerId: contract.ownerId,
            destination: "LOCATARIO",
            status: "PENDENTE",
            OR: [
              {
                dueDate: {
                  gte: new Date(targetYear, targetMonth, 1),
                  lt: new Date(targetYear, targetMonth + 1, 1),
                },
              },
              { dueDate: null },
            ],
          },
        });
        // Inverter tipo: Owner DEBITO -> Tenant CREDITO; Owner CREDITO -> Tenant DEBITO
        const ownerToTenantInverted = ownerEntriesForTenant.map(oe => ({
          ...oe,
          type: oe.type === "DEBITO" ? "CREDITO" : "DEBITO",
          _fromOwnerEntry: oe.id,
        }));

        const discountEntries = [
          ...tenantEntries.filter(e => e.type === "CREDITO"),
          ...ownerToTenantInverted.filter(e => e.type === "CREDITO"),
        ];
        const chargeEntries = [
          ...tenantEntries.filter(e => e.type === "DEBITO"),
          ...ownerToTenantInverted.filter(e => e.type === "DEBITO"),
        ];
        const totalCredits = discountEntries.reduce((sum, e) => sum + e.value, 0);
        // Fix Bug 2: se ja temos iptuMonthly (calculado de property.iptuValue/12),
        // ignoramos TenantEntry IPTU pra nao cobrar 2x. Idem condomínio.
        const dedupCategorias = new Set<string>();
        if (iptuMonthly > 0) dedupCategorias.add("IPTU");
        if (condoFee > 0) dedupCategorias.add("CONDOMINIO");
        const totalDebits = chargeEntries
          .filter(e => !dedupCategorias.has((e.category || "").toUpperCase()))
          .reduce((sum, e) => sum + e.value, 0);

        // Total = aluguel (proporcional se pro-rata) + condominio + IPTU + seguro + taxa bancaria + debitos - creditos
        const bankFee = contract.bankFee || 0;
        const insuranceFee = contract.insuranceFee || 0;
        const totalValue = Math.max(0, Math.round((prorataRentalValue + condoFee + iptuMonthly + bankFee + insuranceFee + totalDebits - totalCredits) * 100) / 100);

        // Calculate split values (admin fee applies to rental value proporcional)
        // Fix Leo 13/05: quando ha desconto de ALUGUEL (acordo de reducao do
        // valor mensal por periodo), a taxa de admin e calculada sobre o
        // aluguel LIQUIDO (apos desconto). Descontos de outras categorias
        // (chamada extra, reserva, IPTU) NAO reduzem a base.
        // Ex: aluguel R$ 4.600, desconto R$ 600 -> taxa sobre R$ 4.000 = R$ 400.
        const adminFee = contract.adminFeePercent || 10;
        const descontoAluguel = discountEntries
          .filter(e => (e.category || "").toUpperCase() === "DESCONTO")
          .reduce((sum, e) => sum + e.value, 0);
        const aluguelLiquidoParaAdmin = Math.max(0, prorataRentalValue - descontoAluguel);
        let adminFeeBase = Math.round(aluguelLiquidoParaAdmin * (adminFee / 100) * 100) / 100;

        // ============================================================
        // INTERMEDIACAO COM SALDO PENDENTE (rolo)
        // - Divide igual em N parcelas
        // - Se a parcela do mes nao cabe no aluguel disponivel,
        //   o que sobrou vira saldo pendente e e somado a parcela
        //   do mes seguinte
        // ============================================================
        let intermediationParcelaTeorica = 0;  // valor "ideal" da parcela do mes
        let intermediationDescontado = 0;       // quanto foi efetivamente descontado
        let intermediationSaldoNovo = 0;        // saldo que fica pendente
        let intermediationNote = "";
        let intermediationMonthNumber = 0;
        const saldoAnterior = contract.intermediacaoSaldoPendente || 0;

        if (
          contract.intermediationFee != null &&
          contract.intermediationFee > 0
        ) {
          // Mes do contrato calculado pelo mes de REFERENCIA, nao do vencimento.
          // Mes 1 = mes em que o contrato comecou.
          const contractMonthNumber =
            (refYear - csYear) * 12 + (refMonth - csMonth) + 1;
          intermediationMonthNumber = contractMonthNumber;

          const installments = contract.intermediationInstallments || 1;
          const baseIntermedRental = contract.rentalValue || prorataRentalValue;
          const totalIntermediationValue = baseIntermedRental * (contract.intermediationFee / 100);
          const valorPorParcela = Math.round((totalIntermediationValue / installments) * 100) / 100;

          // Parcela do mes (so durante as N parcelas previstas)
          let parcelaBase = 0;
          if (contractMonthNumber >= 1 && contractMonthNumber <= installments) {
            parcelaBase = valorPorParcela;
          }

          // Total a cobrar este mes = parcela do mes + saldo pendente acumulado
          intermediationParcelaTeorica = Math.round((parcelaBase + saldoAnterior) * 100) / 100;
        } else if (saldoAnterior > 0) {
          // Sem intermediacao nova, mas tem saldo pendente → tenta cobrar
          intermediationParcelaTeorica = saldoAnterior;
        }

        // ============================================================
        // CALCULO DO QUE EFETIVAMENTE CABE NO REPASSE
        // ============================================================
        // Regras:
        // 1) PRIMEIRO MES com intermediacao: SEMPRE isenta taxa adm
        //    (Leo: 'no primeiro mes, que tera a intermediacao, o
        //    proprietario nao recebera nada — sem comissao')
        // 2) Se a intermediacao nao cabe no aluguel: primeiro waive
        //    taxa adm; depois desconta o que cabe e acumula saldo
        // 3) Caso contrario: cobra tudo normalmente
        let adminWaived = false;
        let adminWaivedReason = "";

        // REGRA LEO 13/05/2026: SEMPRE que tem intermediacao no mes, admin = 0
        // "a intermediacao sempre vai ser sobre o valor completo e quando tiver
        // isso nao precisa ter administracao" - Leo Constantin
        if (intermediationParcelaTeorica > 0 && adminFeeBase > 0) {
          adminFeeBase = 0;
          adminWaived = true;
          adminWaivedReason = `Taxa admin isenta — contrato com intermediacao no mes ${intermediationMonthNumber} (regra Leo: intermediacao + admin nao acumulam)`;
        }

        // Quanto sobra apos cobrar taxa adm (que ja pode ter sido isentada acima)
        const sobraAposAdm = prorataRentalValue - adminFeeBase;

        // REGRA 2: se ainda nao couber, waive admin (caso 1o mes ja tenha sido isentado, esse if nao pega)
        if (sobraAposAdm < intermediationParcelaTeorica) {
          if (intermediationParcelaTeorica > 0 && adminFeeBase > 0) {
            adminFeeBase = 0;
            adminWaived = true;
            adminWaivedReason = `Taxa de administracao isenta no mes ${intermediationMonthNumber} (intermediacao consome o repasse)`;
          }

          // Recalcula sobra (agora sem taxa adm)
          const sobraSemAdm = prorataRentalValue;

          if (sobraSemAdm >= intermediationParcelaTeorica) {
            intermediationDescontado = intermediationParcelaTeorica;
            intermediationSaldoNovo = 0;
          } else {
            // Fix Leo 13/05: quando intermediacao excede o aluguel disponivel
            // (caso primeiro mes com 100% intermediacao + pro-rata, ou similar),
            // a imobiliaria ABRE MAO do excedente. NAO gera saldo carry-forward
            // pro proximo mes. Leo: "Cai fora e nao vai para o proximo mes —
            // eu nao ganho nada mesmo isso."
            intermediationDescontado = Math.max(0, sobraSemAdm);
            intermediationSaldoNovo = 0;
          }
        } else {
          // Cabe tudo normalmente
          intermediationDescontado = intermediationParcelaTeorica;
          intermediationSaldoNovo = 0;
        }

        // Note explicativo
        if (intermediationParcelaTeorica > 0) {
          const installments = contract.intermediationInstallments || 1;
          let noteText = `Intermediação parcela ${intermediationMonthNumber}/${installments}: R$ ${intermediationDescontado.toFixed(2)}`;
          if (saldoAnterior > 0) {
            noteText += ` (inclui saldo anterior R$ ${saldoAnterior.toFixed(2)})`;
          }
          if (intermediationSaldoNovo > 0) {
            noteText += ` — saldo pendente para proximo mes: R$ ${intermediationSaldoNovo.toFixed(2)}`;
          }
          intermediationNote = noteText;
        }

        // intermediationInstallmentValue mantido como o valor efetivamente descontado
        // (compatibilidade com o resto do codigo)
        const intermediationInstallmentValue = intermediationDescontado;

        const splitAdminValue = Math.round((adminFeeBase + intermediationInstallmentValue) * 100) / 100;
        const splitOwnerValue = Math.round((prorataRentalValue - splitAdminValue) * 100) / 100;

        // grossToOwner = aluguel - taxa de administracao (nao inclui condominio, IPTU, etc.)
        // IRRF NAO eh calculado aqui — fica para a consolidacao mensal por CPF
        // (consolidateIRRFByOwnerMonth) que agrupa todos os Payments do mesmo CPF
        // de proprietario antes de aplicar a tabela. Isso evita reter sobre boletos
        // que isolados parecem acima do piso mas que na soma do CPF ficam isentos
        // (ou vice-versa). A consolidacao pode ser disparada manualmente ou ao
        // final do generate (ver Fase 2.5 do plano).
        const grossToOwner = splitOwnerValue;
        const irrfValue = 0;
        const irrfRate = 0;
        const netToOwner = grossToOwner;

        const code = `PAG-${String(nextNumber).padStart(3, "0")}`;
        nextNumber++;

        // Build description with breakdown
        // mLabel = mes de REFERENCIA (mes que esta sendo cobrado, nao o mes do vencimento)
        const mLabel = `${String(refMonth + 1).padStart(2, "0")}/${refYear}`;
        const descParts = [
          isProrata
            ? `Aluguel ${mLabel} (${prorataDays} dias) - ${contract.code}`
            : `Aluguel ${mLabel} - ${contract.code}`,
        ];
        if (isProrata) descParts.push(`Pro-rata: R$ ${prorataRentalValue.toFixed(2)} (${prorataDays}/30 dias)`);
        if (totalCredits > 0) descParts.push(`Créditos: -R$ ${totalCredits.toFixed(2)}`);
        if (totalDebits > 0) descParts.push(`Débitos: +R$ ${totalDebits.toFixed(2)}`);
        if (condoFee > 0) descParts.push(`Condominio: R$ ${condoFee.toFixed(2)}`);
        if (iptuMonthly > 0) descParts.push(`IPTU: R$ ${iptuMonthly.toFixed(2)}`);
        if (insuranceFee > 0) descParts.push(`Seguro Fianca: R$ ${insuranceFee.toFixed(2)}`);
        if (bankFee > 0) descParts.push(`Taxa Bancaria: R$ ${bankFee.toFixed(2)}`);
        if (intermediationNote) descParts.push(intermediationNote);
        if (adminWaived) descParts.push(adminWaivedReason);
        if (intermediationSaldoNovo > 0) {
          descParts.push(`Saldo intermediacao para proximo mes: R$ ${intermediationSaldoNovo.toFixed(2)}`);
        }

        // Store structured breakdown in notes for programmatic access
        const breakdown: Record<string, unknown> = {
          aluguel: isProrata ? prorataRentalValue : contract.rentalValue,
          aluguelOriginal: isProrata ? contract.rentalValue : undefined,
          isProrata,
          prorataDias: isProrata ? prorataDays : undefined,
          mesReferencia: mLabel,
          creditos: totalCredits,
          debitos: totalDebits,
          condominio: condoFee,
          iptu: iptuMonthly,
          seguroFianca: insuranceFee,
          taxaBancaria: bankFee,
          total: totalValue,
          adminFeePercent: adminFee,
          adminFeeValue: adminFeeBase,
          adminWaived,
          adminWaivedReason: adminWaived ? adminWaivedReason : undefined,
        };
        if (intermediationInstallmentValue > 0 || intermediationSaldoNovo > 0 || saldoAnterior > 0) {
          breakdown.intermediacao = intermediationInstallmentValue;
          breakdown.intermediacaoMes = intermediationMonthNumber;
          breakdown.intermediacaoParcelaTeorica = intermediationParcelaTeorica;
          breakdown.intermediacaoSaldoAnterior = saldoAnterior;
          breakdown.intermediacaoSaldoNovo = intermediationSaldoNovo;
        }
        // Detail of each tenant entry applied
        if (tenantEntries.length > 0) {
          breakdown.lancamentos = tenantEntries.map(e => ({
            id: e.id,
            tipo: e.type,
            categoria: e.category,
            descricao: e.description,
            valor: e.value,
          }));
        }

        await prisma.payment.create({
          data: {
            code,
            contractId: contract.id,
            tenantId: contract.tenantId!,
            ownerId: contract.ownerId,
            value: totalValue,
            discountValue: totalCredits > 0 ? totalCredits : null,
            dueDate,
            status: "PENDENTE",
            splitAdminValue,
            splitOwnerValue,
            intermediationFee: intermediationInstallmentValue > 0 ? intermediationInstallmentValue : null,
            grossToOwner,
            irrfValue: irrfValue > 0 ? irrfValue : null,
            irrfRate: irrfValue > 0 ? irrfRate : null,
            netToOwner,
            description: descParts.join(" | "),
            notes: JSON.stringify(breakdown),
          },
        });

        // Atualizar saldo pendente da intermediacao no contrato (se mudou)
        if (intermediationSaldoNovo !== saldoAnterior) {
          await prisma.contract.update({
            where: { id: contract.id },
            data: { intermediacaoSaldoPendente: intermediationSaldoNovo },
          });
        }

        // Lançamentos NÃO são marcados como PAGO aqui.
        // Serão marcados quando o pagamento for confirmado (status PAGO).
        // Para entries sem dueDate, definir o dueDate para o mês alvo para evitar dupla aplicação.
        const nullDateEntries = tenantEntries.filter(e => !e.dueDate);
        if (nullDateEntries.length > 0) {
          await prisma.tenantEntry.updateMany({
            where: { id: { in: nullDateEntries.map(e => e.id) } },
            data: { dueDate: new Date(targetYear, targetMonth, 1, 12, 0, 0) },
          });
        }

        // Create owner entry records split by PropertyOwner percentages
        // Buscar shares de proprietários (usado para repasse e créditos do locatário)
        const ownerShares = contract.property?.id
          ? await prisma.propertyOwner.findMany({ where: { propertyId: contract.property.id } })
          : [];

        // Notes com valores TOTAIS do contrato + porcentagem do proprietário
        // Taxa adm é sobre o valor total, depois divide pela porcentagem.
        // Se adminWaived (taxa isenta no mes pq intermediacao consumiu o repasse),
        // o totalAdminFeeValue eh ZERO.
        const baseAluguel = prorataRentalValue;
        const totalAdminFeeValue = adminWaived
          ? 0
          : Math.round(prorataRentalValue * (adminFee / 100) * 100) / 100;

        const buildOwnerNotes = (sharePercent: number) => {
          // Fix Bug 4: intermediacao e netToOwner sao guardados PROPORCIONAIS
          // por sharePercent. Antes guardavam valor cheio em todas as entries
          // de coproprietarios — ferramentas downstream (repair-missing-intermediacao,
          // demonstrativos) liam o valor cheio e somavam N vezes.
          const shareRatio = sharePercent / 100;
          return JSON.stringify({
            aluguelBruto: baseAluguel,
            adminFeePercent: adminFee,
            adminFeeValue: Math.round(totalAdminFeeValue * shareRatio * 100) / 100,
            sharePercent: sharePercent < 100 ? sharePercent : undefined,
            intermediacao: intermediationInstallmentValue > 0
              ? Math.round(intermediationInstallmentValue * shareRatio * 100) / 100
              : undefined,
            intermediacaoNota: intermediationNote || undefined,
            irrfValue: irrfValue > 0
              ? Math.round(irrfValue * shareRatio * 100) / 100
              : undefined,
            irrfRate: irrfValue > 0 ? irrfRate : undefined,
            netToOwner: Math.round(netToOwner * shareRatio * 100) / 100,
          });
        };

        const ownerEntryNotes = buildOwnerNotes(100);

        if (contract.property?.id) {

          if (ownerShares.length > 0) {
            // Multiple owners: create split entries for each
            const totalSharePercent = ownerShares.reduce((s, sh) => s + sh.percentage, 0);

            for (const share of ownerShares) {
              const ownerPortion = Math.round(splitOwnerValue * (share.percentage / 100) * 100) / 100;
              await prisma.ownerEntry.create({
                data: {
                  type: "CREDITO",
                  category: "REPASSE",
                  description: `Repasse aluguel ${mLabel} - ${contract.code} (${share.percentage}%)`,
                  value: ownerPortion,
                  dueDate,
                  status: "PENDENTE",
                  ownerId: share.ownerId,
                  contractId: contract.id,
                  propertyId: contract.property.id,
                  notes: buildOwnerNotes(share.percentage),
                },
              });
            }

            // Fix Bug 1: se a soma das porcentagens nao da 100%, o proprietario
            // do contrato recebe o restante — INDEPENDENTE de ja estar em
            // ownerShares. Antes, se o contract.ownerId estava em ownerShares
            // (com qualquer percentage), o restante NAO era criado e o owner
            // perdia metade do repasse silenciosamente.
            if (totalSharePercent < 100) {
              const remainingPercent = Math.round((100 - totalSharePercent) * 100) / 100;
              const remainingValue = Math.round(splitOwnerValue * (remainingPercent / 100) * 100) / 100;
              await prisma.ownerEntry.create({
                data: {
                  type: "CREDITO",
                  category: "REPASSE",
                  description: `Repasse aluguel ${mLabel} - ${contract.code} (${remainingPercent}% restante)`,
                  value: remainingValue,
                  dueDate,
                  status: "PENDENTE",
                  ownerId: contract.ownerId,
                  contractId: contract.id,
                  propertyId: contract.property.id,
                  notes: buildOwnerNotes(remainingPercent),
                },
              });
            }
          } else {
            // Single owner (no PropertyOwner records): create one entry
            await prisma.ownerEntry.create({
              data: {
                type: "CREDITO",
                category: "REPASSE",
                description: `Repasse aluguel ${mLabel} - ${contract.code}`,
                value: splitOwnerValue,
                dueDate,
                status: "PENDENTE",
                ownerId: contract.ownerId,
                contractId: contract.id,
                propertyId: contract.property.id,
                notes: ownerEntryNotes,
              },
            });
          }
        }

        // Criar créditos no proprietário para lançamentos do locatário com destino=PROPRIETARIO
        // Ex: IPTU cobrado do locatário que deve ser repassado ao proprietário
        const ownerCreditEntries = chargeEntries.filter(
          (e) => e.destination === "PROPRIETARIO"
        );
        for (const tenantEntry of ownerCreditEntries) {
          const categoryMap: Record<string, string> = {
            IPTU: "IPTU",
            CONDOMINIO: "CONDOMINIO",
          };
          const ownerCategory = categoryMap[tenantEntry.category] || tenantEntry.category;
          const installmentLabel = tenantEntry.installmentNumber && tenantEntry.installmentTotal
            ? ` ${tenantEntry.installmentNumber}/${tenantEntry.installmentTotal}`
            : "";

          if (ownerShares && ownerShares.length > 0) {
            const totalSharePctCredits = ownerShares.reduce((s, sh) => s + sh.percentage, 0);

            for (const share of ownerShares) {
              const portion = Math.round(tenantEntry.value * (share.percentage / 100) * 100) / 100;
              await prisma.ownerEntry.create({
                data: {
                  type: "CREDITO",
                  category: ownerCategory,
                  description: `${tenantEntry.category}${installmentLabel} ${mLabel} - ${contract.code} (${share.percentage}%)`,
                  value: portion,
                  dueDate,
                  status: "PENDENTE",
                  ownerId: share.ownerId,
                  contractId: contract.id,
                  propertyId: contract.property?.id,
                  notes: JSON.stringify({
                    tenantEntryId: tenantEntry.id,
                    originalDescription: tenantEntry.description,
                    destination: "PROPRIETARIO",
                  }),
                },
              });
            }

            // Proprietário principal recebe o restante se soma < 100%
            const contractOwnerInSharesCredits = ownerShares.some(s => s.ownerId === contract.ownerId);
            if (totalSharePctCredits < 100 && !contractOwnerInSharesCredits) {
              const remainPct = Math.round((100 - totalSharePctCredits) * 100) / 100;
              const remainVal = Math.round(tenantEntry.value * (remainPct / 100) * 100) / 100;
              await prisma.ownerEntry.create({
                data: {
                  type: "CREDITO",
                  category: ownerCategory,
                  description: `${tenantEntry.category}${installmentLabel} ${mLabel} - ${contract.code} (${remainPct}%)`,
                  value: remainVal,
                  dueDate,
                  status: "PENDENTE",
                  ownerId: contract.ownerId,
                  contractId: contract.id,
                  propertyId: contract.property?.id,
                  notes: JSON.stringify({
                    tenantEntryId: tenantEntry.id,
                    originalDescription: tenantEntry.description,
                    destination: "PROPRIETARIO",
                  }),
                },
              });
            }
          } else {
            await prisma.ownerEntry.create({
              data: {
                type: "CREDITO",
                category: ownerCategory,
                description: `${tenantEntry.category}${installmentLabel} ${mLabel} - ${contract.code}`,
                value: tenantEntry.value,
                dueDate,
                status: "PENDENTE",
                ownerId: contract.ownerId,
                contractId: contract.id,
                propertyId: contract.property?.id,
                notes: JSON.stringify({
                  tenantEntryId: tenantEntry.id,
                  originalDescription: tenantEntry.description,
                  destination: "PROPRIETARIO",
                }),
              },
            });
          }
        }

        // Criar DÉBITOS no proprietário para descontos do locatário com destino=PROPRIETARIO
        // Ex: Desconto dado ao locatário que o proprietário absorve
        const ownerDebitEntries = discountEntries.filter(
          (e) => e.destination === "PROPRIETARIO"
        );
        for (const tenantEntry of ownerDebitEntries) {
          const ownerCategory = tenantEntry.category || "DESCONTO";
          const installmentLabel = tenantEntry.installmentNumber && tenantEntry.installmentTotal
            ? ` ${tenantEntry.installmentNumber}/${tenantEntry.installmentTotal}`
            : "";

          if (ownerShares && ownerShares.length > 0) {
            const totalSharePctDebits = ownerShares.reduce((s, sh) => s + sh.percentage, 0);

            for (const share of ownerShares) {
              const portion = Math.round(tenantEntry.value * (share.percentage / 100) * 100) / 100;
              await prisma.ownerEntry.create({
                data: {
                  type: "DEBITO",
                  category: ownerCategory,
                  description: `${tenantEntry.description || tenantEntry.category}${installmentLabel} ${mLabel} - ${contract.code} (${share.percentage}%)`,
                  value: portion,
                  dueDate,
                  status: "PENDENTE",
                  ownerId: share.ownerId,
                  contractId: contract.id,
                  propertyId: contract.property?.id,
                  notes: JSON.stringify({
                    tenantEntryId: tenantEntry.id,
                    originalDescription: tenantEntry.description,
                    destination: "PROPRIETARIO",
                    type: "desconto_locatario",
                  }),
                },
              });
            }

            const contractOwnerInSharesDebits = ownerShares.some(s => s.ownerId === contract.ownerId);
            if (totalSharePctDebits < 100 && !contractOwnerInSharesDebits) {
              const remainPct = Math.round((100 - totalSharePctDebits) * 100) / 100;
              const remainVal = Math.round(tenantEntry.value * (remainPct / 100) * 100) / 100;
              await prisma.ownerEntry.create({
                data: {
                  type: "DEBITO",
                  category: ownerCategory,
                  description: `${tenantEntry.description || tenantEntry.category}${installmentLabel} ${mLabel} - ${contract.code} (${remainPct}%)`,
                  value: remainVal,
                  dueDate,
                  status: "PENDENTE",
                  ownerId: contract.ownerId,
                  contractId: contract.id,
                  propertyId: contract.property?.id,
                  notes: JSON.stringify({
                    tenantEntryId: tenantEntry.id,
                    originalDescription: tenantEntry.description,
                    destination: "PROPRIETARIO",
                    type: "desconto_locatario",
                  }),
                },
              });
            }
          } else {
            await prisma.ownerEntry.create({
              data: {
                type: "DEBITO",
                category: ownerCategory,
                description: `${tenantEntry.description || tenantEntry.category}${installmentLabel} ${mLabel} - ${contract.code}`,
                value: tenantEntry.value,
                dueDate,
                status: "PENDENTE",
                ownerId: contract.ownerId,
                contractId: contract.id,
                propertyId: contract.property?.id,
                notes: JSON.stringify({
                  tenantEntryId: tenantEntry.id,
                  originalDescription: tenantEntry.description,
                  destination: "PROPRIETARIO",
                  type: "desconto_locatario",
                }),
              },
            });
          }
        }

        generated++;
      } catch (err) {
        errors.push({
          contract: contract.code,
          message: err instanceof Error ? err.message : "Erro desconhecido",
        });
      }
    }

    const monthLabel = `${String(targetMonth + 1).padStart(2, "0")}/${targetYear}`;

    // Consolida IRRF por CPF/mes apos a geracao. Agrupa todos os Payments do
    // mesmo CPF de proprietario PF (com locatario PJ) e aplica a tabela
    // progressiva sobre a soma — distribuindo o IRRF total proporcionalmente
    // entre os boletos do grupo. Ver Fase 2 do plano IRRF.
    let irrfReport: Awaited<ReturnType<typeof consolidateIRRFByOwnerMonth>> | null = null;
    if (generated > 0) {
      try {
        irrfReport = await consolidateIRRFByOwnerMonth(prisma, {
          refMonth: new Date(targetYear, targetMonth, 1),
        });
      } catch (err) {
        console.error("[Billing/generate] Erro ao consolidar IRRF:", err);
      }
    }

    return NextResponse.json({
      generated,
      skipped,
      skippedDetails,
      totalContratos: contracts.length,
      errors,
      month: monthLabel,
      message: generated > 0
        ? `${generated} cobranca(s) gerada(s) para ${monthLabel}.${skipped > 0 ? ` ${skipped} ja existiam.` : ""}`
        : `Nenhuma cobranca gerada. ${skipped} ja existiam para ${monthLabel}.`,
      irrf: irrfReport
        ? {
            grupos: irrfReport.totalGroups,
            pagamentos: irrfReport.totalPayments,
            irrfTotal: irrfReport.totalIrrf,
          }
        : null,
    });
  } catch (error) {
    console.error("Erro ao gerar cobrancas:", error);
    return NextResponse.json(
      { error: "Erro ao gerar cobrancas" },
      { status: 500 }
    );
  }
}

// GET: Preview - shows which contracts would generate charges
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const monthStr = searchParams.get("month");

    let targetYear: number;
    let targetMonth: number;

    if (monthStr && /^\d{4}-\d{2}$/.test(monthStr)) {
      const [y, m] = monthStr.split("-").map(Number);
      targetYear = y;
      targetMonth = m - 1;
    } else {
      const now = new Date();
      targetYear = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
      targetMonth = (now.getMonth() + 1) % 12;
    }

    // Reference month = mes que esta sendo cobrado (targetMonth - 1)
    let refYear = targetYear;
    let refMonth = targetMonth - 1;
    if (refMonth < 0) {
      refMonth = 11;
      refYear -= 1;
    }
    const refMonthStart = new Date(refYear, refMonth, 1);
    const refMonthEnd = new Date(refYear, refMonth + 1, 0, 23, 59, 59, 999);
    const refDaysInMonth = new Date(refYear, refMonth + 1, 0).getDate();

    const monthStart = new Date(targetYear, targetMonth, 1);
    const monthEnd = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59, 999);

    // Inclui TODOS contratos ja existentes no mes de referencia, independente
    // de endDate. ENCERRADO aparece na lista de 'nao geraveis' com motivo.
    // NAO filtra por endDate: contratos 'vencidos' com status ATIVO seguem
    // vigentes (locatario continua no imovel) e devem aparecer.
    const contracts = await prisma.contract.findMany({
      where: {
        status: { in: ["ATIVO", "PENDENTE_RENOVACAO", "ENCERRADO", "RESCINDIDO"] },
        startDate: { lte: refMonthEnd },
      },
      include: {
        property: {
          select: {
            title: true,
            condoFee: true,
            iptuValue: true,
          },
        },
        tenant: { select: { name: true } },
        owner: { select: { name: true } },
      },
    });

    const existingPayments = await prisma.payment.findMany({
      where: {
        dueDate: { gte: monthStart, lte: monthEnd },
        status: { not: "CANCELADO" },
      },
      select: { contractId: true },
    });
    const existingContractIds = new Set(existingPayments.map((p) => p.contractId));

    // Contratos pulados com motivo (nao geraveis por algum motivo)
    const skippedContracts: {
      contractCode: string;
      property: string;
      tenant: string;
      reason: string;
    }[] = [];

    const preview = contracts
      .map((c) => {
        // Pula se status=ENCERRADO ou RESCINDIDO. Contratos ATIVO/
        // PENDENTE_RENOVACAO com endDate no passado continuam vigentes
        // (renovacao automatica ou aguardando definicao) — devem gerar
        // cobranca normalmente.
        if (c.status === "ENCERRADO" || c.status === "RESCINDIDO") {
          skippedContracts.push({
            contractCode: c.code,
            property: c.property?.title || "—",
            tenant: c.tenant?.name || "—",
            reason: c.status === "RESCINDIDO" ? "Contrato rescindido" : "Contrato encerrado",
          });
          return null;
        }
        // Sem locatario (tipo ADMINISTRACAO/VISTORIA)
        if (!c.tenantId) {
          skippedContracts.push({
            contractCode: c.code,
            property: c.property?.title || "—",
            tenant: "—",
            reason: `Sem locatario (tipo ${c.type || "?"})`,
          });
          return null;
        }
        // Pro-rata se contrato comecou ou terminou no meio do mes de referencia
        const cs = new Date(c.startDate);
        const csYear = cs.getUTCFullYear();
        const csMonth = cs.getUTCMonth();
        const csDay = cs.getUTCDate();
        const ce = c.endDate ? new Date(c.endDate) : null;

        let isProrata = false;
        let prorataDays = 30;
        if (csYear === refYear && csMonth === refMonth && csDay > 1) {
          isProrata = true;
          prorataDays = refDaysInMonth - csDay + 1;
        }
        if (ce) {
          const ceYear = ce.getUTCFullYear();
          const ceMonth = ce.getUTCMonth();
          const ceDay = ce.getUTCDate();
          if (ceYear === refYear && ceMonth === refMonth && ceDay < refDaysInMonth) {
            if (isProrata) {
              prorataDays = ceDay - csDay + 1;
            } else {
              prorataDays = ceDay;
              isProrata = true;
            }
          }
        }
        const dailyRate = c.rentalValue / 30;
        const prorataRentalValue = isProrata
          ? Math.round(dailyRate * prorataDays * 100) / 100
          : c.rentalValue;

        const condoFee = c.property?.condoFee || 0;
        const iptuMonthly = c.property?.iptuValue
          ? Math.round((c.property.iptuValue / 12) * 100) / 100
          : 0;
        const totalValue = Math.round((prorataRentalValue + condoFee + iptuMonthly) * 100) / 100;

        return {
          contractCode: c.code,
          property: c.property?.title || "N/A",
          tenant: c.tenant?.name || "N/A",
          owner: c.owner.name,
          rentalValue: c.rentalValue,
          startDate: c.startDate,
          isProrata,
          prorataDias: isProrata ? prorataDays : undefined,
          prorataRentalValue: isProrata ? prorataRentalValue : undefined,
          mesReferencia: `${String(refMonth + 1).padStart(2, "0")}/${refYear}`,
          condoFee,
          iptuMonthly,
          value: totalValue,
          paymentDay: c.paymentDay,
          alreadyExists: existingContractIds.has(c.id),
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    return NextResponse.json({
      month: `${String(targetMonth + 1).padStart(2, "0")}/${targetYear}`,
      mesReferencia: `${String(refMonth + 1).padStart(2, "0")}/${refYear}`,
      total: contracts.length,
      pending: preview.filter((p) => !p.alreadyExists).length,
      existing: preview.filter((p) => p.alreadyExists).length,
      skipped: skippedContracts.length,
      contracts: preview,
      skippedContracts,
    });
  } catch (error) {
    console.error("Erro ao carregar preview:", error);
    return NextResponse.json(
      { error: "Erro ao carregar preview" },
      { status: 500 }
    );
  }
}
