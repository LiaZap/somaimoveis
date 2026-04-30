import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

/**
 * Aggregated stats for the /proprietarios summary cards.
 */
export async function GET(_request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [totalOwners, totalProperties, activeContracts, newThisMonth] = await Promise.all([
    prisma.owner.count({ where: { active: true } }),
    prisma.property.count({ where: { active: true } }),
    prisma.contract.findMany({
      where: { status: "ATIVO" },
      select: { rentalValue: true },
    }),
    prisma.owner.count({
      where: { active: true, createdAt: { gte: monthStart } },
    }),
  ]);

  const totalMonthlyIncome = activeContracts.reduce(
    (sum, c) => sum + (c.rentalValue || 0),
    0,
  );

  return NextResponse.json({
    totalOwners,
    totalProperties,
    totalMonthlyIncome,
    newThisMonth,
  });
}
