import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPortalToken } from "@/lib/portal-auth";
import {
  calculateIRRF,
  MONTH_NAMES,
  type FiscalReportData,
  type FiscalPropertySummary,
  type FiscalMonthRow,
} from "@/lib/fiscal";

export async function GET(request: NextRequest) {
  const auth = await verifyPortalToken(request);
  if (!auth) {
    return NextResponse.json({ error: "Nao autorizado" }, { status: 401 });
  }

  try {
    const { ownerId } = auth;
    const { searchParams } = new URL(request.url);
    const year = parseInt(searchParams.get("year") || String(new Date().getFullYear()));

    const owner = await prisma.owner.findUnique({ where: { id: ownerId } });
    if (!owner) {
      return NextResponse.json({ error: "Proprietario nao encontrado" }, { status: 404 });
    }

    // Inclui imoveis em que o owner eh co-proprietario via PropertyOwner
    const propertyShares = await prisma.propertyOwner.findMany({
      where: { ownerId },
      select: { propertyId: true },
    });
    const sharedPropertyIds = propertyShares.map((s) => s.propertyId);

    const payments = await prisma.payment.findMany({
      where: {
        OR: [
          { ownerId },
          ...(sharedPropertyIds.length > 0
            ? [{ contract: { propertyId: { in: sharedPropertyIds } } }]
            : []),
        ],
        status: "PAGO",
        paidAt: {
          gte: new Date(year, 0, 1),
          lt: new Date(year + 1, 0, 1),
        },
      },
      include: {
        contract: {
          include: {
            property: { select: { id: true, title: true } },
          },
        },
      },
      orderBy: { paidAt: "asc" },
    });

    // Manutencoes — inclui imoveis em que owner eh co-proprietario
    const ownerProperties = await prisma.property.findMany({
      where: {
        OR: [
          { ownerId },
          ...(sharedPropertyIds.length > 0 ? [{ id: { in: sharedPropertyIds } }] : []),
        ],
      },
      select: { id: true },
    });
    const propertyIds = ownerProperties.map((p) => p.id);

    const maintenances = await prisma.maintenanceRecord.findMany({
      where: {
        propertyId: { in: propertyIds },
        status: "CONCLUIDO",
        completedAt: {
          gte: new Date(year, 0, 1),
          lt: new Date(year + 1, 0, 1),
        },
      },
    });

    const maintenanceMap = new Map<string, number>();
    for (const m of maintenances) {
      if (!m.completedAt) continue;
      const date = new Date(m.completedAt);
      const key = `${m.propertyId}-${date.getMonth()}`;
      maintenanceMap.set(key, (maintenanceMap.get(key) || 0) + (m.cost ?? 0));
    }

    // Agrupar por propriedade/mes
    const propertyMap = new Map<
      string,
      {
        id: string;
        title: string;
        months: Map<number, { gross: number; admin: number; net: number; irrf: number }>;
      }
    >();

    for (const payment of payments) {
      const propId = payment.contract.property?.id || "unknown";
      const propTitle = payment.contract.property?.title || "N/A";

      if (!propertyMap.has(propId)) {
        propertyMap.set(propId, { id: propId, title: propTitle, months: new Map() });
      }

      const prop = propertyMap.get(propId)!;
      const paidDate = new Date(payment.paidAt!);
      const month = paidDate.getMonth();

      if (!prop.months.has(month)) {
        prop.months.set(month, { gross: 0, admin: 0, net: 0, irrf: 0 });
      }

      const monthData = prop.months.get(month)!;
      const paidValue = payment.paidValue ?? payment.value;
      const adminFeePercent = payment.contract.adminFeePercent ?? 10;
      const splitAdmin = payment.splitAdminValue ?? paidValue * (adminFeePercent / 100);
      const splitOwner = payment.splitOwnerValue ?? paidValue - splitAdmin;

      monthData.gross += paidValue;
      monthData.admin += splitAdmin;
      monthData.net += splitOwner;
      // IRRF do pagamento real (gravado pelo billing). Reflete o que foi
      // efetivamente retido — nao recalcula.
      (monthData as any).irrf = ((monthData as any).irrf || 0) + (payment.irrfValue || 0);
    }

    const properties: FiscalPropertySummary[] = [];

    for (const [propId, propData] of propertyMap) {
      const months: FiscalMonthRow[] = [];
      let annualGross = 0, annualAdmin = 0, annualNet = 0;
      let annualMaintenance = 0, annualTaxable = 0, annualIrrf = 0;

      for (let m = 0; m < 12; m++) {
        const monthData = propData.months.get(m) as { gross: number; admin: number; net: number; irrf?: number } | undefined;
        if (!monthData) continue;

        const maintenanceCost = maintenanceMap.get(`${propId}-${m}`) || 0;
        const taxableIncome = Math.max(0, monthData.net - maintenanceCost);
        const irrfValue = Math.round((monthData.irrf || 0) * 100) / 100;
        const irrfRate = taxableIncome > 0 ? irrfValue / taxableIncome : 0;

        months.push({
          month: m + 1,
          label: MONTH_NAMES[m],
          grossRental: Math.round(monthData.gross * 100) / 100,
          adminFee: Math.round(monthData.admin * 100) / 100,
          netToOwner: Math.round(monthData.net * 100) / 100,
          maintenanceCost: Math.round(maintenanceCost * 100) / 100,
          taxableIncome: Math.round(taxableIncome * 100) / 100,
          irrfRate,
          irrfValue,
        });

        annualGross += monthData.gross;
        annualAdmin += monthData.admin;
        annualNet += monthData.net;
        annualMaintenance += maintenanceCost;
        annualTaxable += taxableIncome;
        annualIrrf += irrfValue;
      }

      properties.push({
        propertyId: propId,
        propertyTitle: propData.title,
        months,
        annualGross: Math.round(annualGross * 100) / 100,
        annualAdminFee: Math.round(annualAdmin * 100) / 100,
        annualNet: Math.round(annualNet * 100) / 100,
        annualMaintenance: Math.round(annualMaintenance * 100) / 100,
        annualTaxable: Math.round(annualTaxable * 100) / 100,
        annualIrrf: Math.round(annualIrrf * 100) / 100,
      });
    }

    const totals = properties.reduce(
      (acc, p) => ({
        grossRental: acc.grossRental + p.annualGross,
        adminFee: acc.adminFee + p.annualAdminFee,
        netToOwner: acc.netToOwner + p.annualNet,
        maintenanceCost: acc.maintenanceCost + p.annualMaintenance,
        taxableIncome: acc.taxableIncome + p.annualTaxable,
        totalIrrf: acc.totalIrrf + p.annualIrrf,
      }),
      { grossRental: 0, adminFee: 0, netToOwner: 0, maintenanceCost: 0, taxableIncome: 0, totalIrrf: 0 }
    );

    const report: FiscalReportData = {
      ownerId: owner.id,
      ownerName: owner.name,
      ownerCpfCnpj: owner.cpfCnpj || "",
      personType: owner.personType || "PF",
      year,
      properties,
      totals: {
        grossRental: Math.round(totals.grossRental * 100) / 100,
        adminFee: Math.round(totals.adminFee * 100) / 100,
        netToOwner: Math.round(totals.netToOwner * 100) / 100,
        maintenanceCost: Math.round(totals.maintenanceCost * 100) / 100,
        taxableIncome: Math.round(totals.taxableIncome * 100) / 100,
        totalIrrf: Math.round(totals.totalIrrf * 100) / 100,
      },
      generatedAt: new Date().toISOString(),
    };

    return NextResponse.json(report);
  } catch (error) {
    console.error("Erro ao gerar relatorio fiscal do portal:", error);
    return NextResponse.json({ error: "Erro interno do servidor" }, { status: 500 });
  }
}
