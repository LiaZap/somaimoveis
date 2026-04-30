import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

/**
 * Aggregated stats for the /contratos summary cards.
 */
export async function GET(_request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const [totalContracts, activeContracts, monthlySum, expiringIn30Days] = await Promise.all([
    prisma.contract.count(),
    prisma.contract.count({ where: { status: "ATIVO" } }),
    prisma.contract.aggregate({
      where: { status: "ATIVO" },
      _sum: { rentalValue: true },
    }),
    prisma.contract.count({
      where: {
        status: "ATIVO",
        endDate: { gte: now, lte: in30Days },
      },
    }),
  ]);

  return NextResponse.json({
    totalContracts,
    activeContracts,
    totalMonthlyValue: monthlySum._sum.rentalValue || 0,
    expiringIn30Days,
  });
}
