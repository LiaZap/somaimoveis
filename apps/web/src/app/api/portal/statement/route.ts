import { NextRequest, NextResponse } from "next/server";
import { verifyPortalToken } from "@/lib/portal-auth";
import { buildDemonstrativo } from "@/lib/demonstrativo";

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
    const year = parseInt(searchParams.get("year") || String(new Date().getFullYear()), 10);

    const monthNames = [
      "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
      "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
    ];

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const lastMonth = year < currentYear ? 12 : currentMonth;

    interface MonthResult {
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
      }[];
      totals: {
        totalValue: number;
        totalPaid: number;
        totalOwner: number;
        totalAdmin: number;
      };
    }

    const months: MonthResult[] = [];

    for (let m = 1; m <= lastMonth; m++) {
      const monthStr = `${year}-${String(m).padStart(2, "0")}`;
      const result = await buildDemonstrativo({ ownerId, monthStr });
      if (!result.ok) continue;

      const data = result.data as any;
      const contratos = data.contratos || [];
      const avulsas = data.avulsas || [];

      if (contratos.length === 0 && avulsas.length === 0) continue;

      const totalEntradas = data.totais?.entradas ?? 0;
      const totalPago = data.totais?.totalPago ?? 0;
      const totalAdmin = contratos.reduce((s: number, c: any) => s + (c.adminFee || 0), 0);

      // Mes de referencia do demonstrativo (mes anterior ao vencimento)
      const refMonth = m - 1 === 0 ? 12 : m - 1;
      const refYear = m - 1 === 0 ? year - 1 : year;

      const payments = contratos.map((c: any) => ({
        id: c.contractId || "",
        code: c.code || "",
        dueDate: new Date(year, m - 1, 5).toISOString(),
        paidAt: data.dataReferenciaPagamento !== "-" ? data.dataReferenciaPagamento : null,
        status: totalPago > 0 ? "PAGO" : "PENDENTE",
        value: c.aluguelBruto || 0,
        paidValue: null,
        splitOwnerValue: c.totalLiquido || 0,
        splitAdminValue: c.adminFee || 0,
        description: null,
        property: c.property?.title || "N/A",
        tenant: c.tenant?.name || "N/A",
      }));

      months.push({
        month: refMonth,
        year: refYear,
        label: `${monthNames[refMonth - 1]} ${refYear}`,
        payments,
        totals: {
          totalValue: totalEntradas,
          totalPaid: totalPago,
          totalOwner: totalPago,
          totalAdmin: Math.round(totalAdmin * 100) / 100,
        },
      });
    }

    months.sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.month - a.month;
    });

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
