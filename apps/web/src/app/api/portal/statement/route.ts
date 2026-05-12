import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPortalToken } from "@/lib/portal-auth";

interface EntryDetail {
  category: string;
  description: string;
  value: number;
  status: string;
  type: "CREDITO" | "DEBITO";
}

interface MonthGroup {
  month: number;
  year: number;
  label: string;
  payments: {
    id: string;
    code: string;
    dueDate: string;
    paidAt: string | null;
    status: string;
    value: number;
    paidValue: number | null;
    splitOwnerValue: number | null;
    splitAdminValue: number | null;
    description: string | null;
    property: string;
    tenant: string;
    // Breakdown detalhado das entries do owner (creditos e debitos)
    breakdown: {
      aluguelBruto: number;
      adminFee: number;
      adminFeePercent: number;
      iptu: number;
      condominio: number;
      intermediacao: number;
      irrf: number;
      outrosDebitos: number;
      outrosCreditos: number;
      repasseLiquido: number;
      entries: EntryDetail[];
    };
  }[];
  totals: {
    totalValue: number;
    totalPaid: number;
    totalOwner: number;
    totalAdmin: number;
    totalIptu: number;
    totalCondominio: number;
    totalIntermediacao: number;
    totalOutrosDebitos: number;
  };
}

export async function GET(request: NextRequest) {
  const auth = await verifyPortalToken(request);
  if (!auth) {
    return NextResponse.json(
      { error: "Nao autorizado" },
      { status: 401 }
    );
  }

  try {
    const { ownerId } = auth;
    const { searchParams } = new URL(request.url);

    const year = searchParams.get("year");

    // Achar contratos onde o owner atual eh DIRETO (ownerId) ou
    // CO-PROPRIETARIO via PropertyOwner. Manoela e Gabriel, por exemplo,
    // sao co-proprietarios sem ser ownerId principal — precisam aparecer.
    const propertyShares = await prisma.propertyOwner.findMany({
      where: { ownerId },
      select: { propertyId: true, percentage: true },
    });
    const sharedPropertyIds = propertyShares.map((s) => s.propertyId);
    const shareByProperty = new Map(
      propertyShares.map((s) => [s.propertyId, s.percentage]),
    );

    // Filtros base — pagamentos cujo contrato tem o owner direto OU cujo
    // imovel tem co-ownership do owner atual.
    const where: Record<string, unknown> = {
      OR: [
        { ownerId },
        ...(sharedPropertyIds.length > 0
          ? [{ contract: { propertyId: { in: sharedPropertyIds } } }]
          : []),
      ],
    };

    if (year) {
      const y = parseInt(year, 10);
      where.dueDate = {
        gte: new Date(y, 0, 1),
        lt: new Date(y + 1, 0, 1),
      };
    }

    // Buscar todos os pagamentos
    const payments = await prisma.payment.findMany({
      where,
      include: {
        contract: {
          include: {
            property: { select: { id: true, title: true } },
          },
        },
        tenant: { select: { name: true } },
      },
      orderBy: { dueDate: "desc" },
    });

    // Buscar OwnerEntries do owner para enriquecer com breakdown (IPTU,
    // condominio, intermediacao, etc descontados/creditados no mes).
    const yearFilter = year ? { gte: new Date(parseInt(year, 10), 0, 1), lt: new Date(parseInt(year, 10) + 1, 0, 1) } : undefined;
    const ownerEntries = await prisma.ownerEntry.findMany({
      where: {
        ownerId,
        status: { in: ["PAGO", "PENDENTE"] },
        ...(yearFilter ? { dueDate: yearFilter } : {}),
      },
      select: {
        id: true,
        type: true,
        category: true,
        description: true,
        value: true,
        status: true,
        dueDate: true,
        paidAt: true,
        contractId: true,
      },
    });

    // Agrupar por mes
    const monthsMap = new Map<string, MonthGroup>();

    const monthNames = [
      "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
      "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
    ];

    for (const payment of payments) {
      const dueDate = new Date(payment.dueDate);
      // Agrupa por MES DE REFERENCIA do aluguel (= mes anterior ao vencimento,
      // ja que cobranca eh in-arrears). Boleto vencendo em maio = aluguel
      // referente a abril → aparece no grupo "Abril".
      let m = dueDate.getMonth() - 1;
      let y = dueDate.getFullYear();
      if (m < 0) {
        m = 11;
        y -= 1;
      }
      const key = `${y}-${String(m + 1).padStart(2, "0")}`;

      if (!monthsMap.has(key)) {
        monthsMap.set(key, {
          month: m + 1,
          year: y,
          label: `${monthNames[m]} ${y}`,
          payments: [],
          totals: {
            totalValue: 0,
            totalPaid: 0,
            totalOwner: 0,
            totalAdmin: 0,
            totalIptu: 0,
            totalCondominio: 0,
            totalIntermediacao: 0,
            totalOutrosDebitos: 0,
          },
        });
      }

      const group = monthsMap.get(key)!;

      // Calcular split se nao estiver preenchido
      const adminFeePercent = payment.contract.adminFeePercent ?? 10;
      const paidValue = payment.paidValue ?? payment.value;
      const splitAdminTotal =
        payment.splitAdminValue ?? paidValue * (adminFeePercent / 100);
      const splitOwnerTotal =
        payment.splitOwnerValue ?? paidValue - splitAdminTotal;

      // Se o owner atual eh CO-PROPRIETARIO (nao ownerId direto do contrato),
      // aplica o share% pra mostrar so a parte que cabe a ele.
      const propId = payment.contract.property?.id;
      const isPrincipalOwner = payment.ownerId === ownerId;
      const sharePercent = !isPrincipalOwner && propId
        ? (shareByProperty.get(propId) ?? 0)
        : 100;
      const shareFactor = sharePercent / 100;
      const splitAdmin = Math.round(splitAdminTotal * shareFactor * 100) / 100;
      const splitOwner = Math.round(splitOwnerTotal * shareFactor * 100) / 100;

      // Breakdown detalhado: OwnerEntries do mesmo contrato + mes referencia.
      // Considera entries com dueDate no mes m+1 (= mes de processamento do
      // repasse no sistema, geralmente 1 mes apos competencia do aluguel).
      const refMonth = m + 1; // mes de competencia (0-indexed +1)
      const refYear = y;
      // O processamento do repasse acontece no MES SEGUINTE a competencia
      // (aluguel de abril → entries com dueDate em maio). Pega entries com
      // dueDate +1 mes da competencia.
      const procMonth = refMonth === 12 ? 1 : refMonth + 1;
      const procYear = refMonth === 12 ? refYear + 1 : refYear;
      const procStart = new Date(procYear, procMonth - 1, 1);
      const procEnd = new Date(procYear, procMonth, 1);

      const ctrEntries = ownerEntries.filter(
        (e) =>
          e.contractId === payment.contractId &&
          e.dueDate &&
          e.dueDate >= procStart &&
          e.dueDate < procEnd,
      );

      let iptuTotal = 0, condTotal = 0, interTotal = 0, irrfTotal = 0;
      let outrosDeb = 0, outrosCred = 0;
      const entriesDetalhe: EntryDetail[] = [];

      for (const e of ctrEntries) {
        const entryShare = e.value * shareFactor;
        entriesDetalhe.push({
          category: e.category,
          description: e.description || "",
          value: Math.round(entryShare * 100) / 100,
          status: e.status,
          type: e.type as "CREDITO" | "DEBITO",
        });
        if (e.type === "DEBITO") {
          if (e.category === "INTERMEDIACAO") interTotal += entryShare;
          else if (e.category === "IPTU") iptuTotal += entryShare;
          else if (e.category === "CONDOMINIO") condTotal += entryShare;
          else if (e.category === "IRRF") irrfTotal += entryShare;
          else outrosDeb += entryShare;
        } else if (e.type === "CREDITO" && e.category !== "REPASSE") {
          // IPTU/condominio creditados (devolucao) ou outros creditos avulsos
          if (e.category === "IPTU") iptuTotal -= entryShare; // credito IPTU = devolucao = reduz desconto
          else if (e.category === "CONDOMINIO") condTotal -= entryShare;
          else outrosCred += entryShare;
        }
      }

      const aluguelBruto = payment.value * shareFactor;
      const adminFeeShare = Math.round(splitAdminTotal * shareFactor * 100) / 100;

      group.payments.push({
        id: payment.id,
        code: payment.code,
        dueDate: payment.dueDate.toISOString(),
        paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
        status: payment.status,
        value: payment.value,
        paidValue: payment.paidValue,
        splitOwnerValue: splitOwner,
        splitAdminValue: splitAdmin,
        description: payment.description,
        property: payment.contract.property?.title || "N/A",
        tenant: payment.tenant?.name || "N/A",
        breakdown: {
          aluguelBruto: Math.round(aluguelBruto * 100) / 100,
          adminFee: adminFeeShare,
          adminFeePercent,
          iptu: Math.round(iptuTotal * 100) / 100,
          condominio: Math.round(condTotal * 100) / 100,
          intermediacao: Math.round(interTotal * 100) / 100,
          irrf: Math.round(irrfTotal * 100) / 100,
          outrosDebitos: Math.round(outrosDeb * 100) / 100,
          outrosCreditos: Math.round(outrosCred * 100) / 100,
          repasseLiquido: Math.round((splitOwner - iptuTotal - condTotal - interTotal - irrfTotal - outrosDeb + outrosCred) * 100) / 100,
          entries: entriesDetalhe,
        },
      });

      // Totais respeitam o share% do owner atual (co-proprietario ve apenas
      // a parte dele).
      group.totals.totalValue += payment.value * shareFactor;
      if (payment.status === "PAGO") {
        group.totals.totalPaid += paidValue * shareFactor;
        group.totals.totalOwner += splitOwner;
        group.totals.totalAdmin += splitAdmin;
        group.totals.totalIptu += iptuTotal;
        group.totals.totalCondominio += condTotal;
        group.totals.totalIntermediacao += interTotal;
        group.totals.totalOutrosDebitos += outrosDeb;
      }
    }

    // Arredonda totais
    for (const m of monthsMap.values()) {
      m.totals.totalValue = Math.round(m.totals.totalValue * 100) / 100;
      m.totals.totalPaid = Math.round(m.totals.totalPaid * 100) / 100;
      m.totals.totalOwner = Math.round(m.totals.totalOwner * 100) / 100;
      m.totals.totalAdmin = Math.round(m.totals.totalAdmin * 100) / 100;
      m.totals.totalIptu = Math.round(m.totals.totalIptu * 100) / 100;
      m.totals.totalCondominio = Math.round(m.totals.totalCondominio * 100) / 100;
      m.totals.totalIntermediacao = Math.round(m.totals.totalIntermediacao * 100) / 100;
      m.totals.totalOutrosDebitos = Math.round(m.totals.totalOutrosDebitos * 100) / 100;
    }

    // Ordenar meses por data (mais recente primeiro)
    const months = Array.from(monthsMap.values()).sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.month - a.month;
    });

    // Totais gerais
    const grandTotals = months.reduce(
      (acc, m) => ({
        totalValue: acc.totalValue + m.totals.totalValue,
        totalPaid: acc.totalPaid + m.totals.totalPaid,
        totalOwner: acc.totalOwner + m.totals.totalOwner,
        totalAdmin: acc.totalAdmin + m.totals.totalAdmin,
      }),
      { totalValue: 0, totalPaid: 0, totalOwner: 0, totalAdmin: 0 }
    );

    return NextResponse.json({
      months,
      grandTotals,
      ownerName: auth.ownerName,
    });
  } catch (error) {
    console.error("Erro ao buscar extrato do portal:", error);
    return NextResponse.json(
      { error: "Erro ao buscar extrato financeiro" },
      { status: 500 }
    );
  }
}
