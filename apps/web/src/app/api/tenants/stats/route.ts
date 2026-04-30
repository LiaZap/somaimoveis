import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

/**
 * Aggregated stats for the /locatarios summary cards.
 */
export async function GET(_request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const [totalTenants, activeContracts, inadimplentes, newThisMonth] = await Promise.all([
    prisma.tenant.count({ where: { active: true } }),
    // Locatarios com pelo menos 1 contrato ATIVO
    prisma.contract.findMany({
      where: { status: "ATIVO" },
      select: { tenantId: true },
      distinct: ["tenantId"],
    }),
    // Locatarios com pagamentos atrasados
    prisma.payment.findMany({
      where: {
        OR: [
          { status: "ATRASADO" },
          { AND: [{ status: "PENDENTE" }, { dueDate: { lt: today } }] },
        ],
      },
      select: { tenantId: true },
      distinct: ["tenantId"],
    }),
    prisma.tenant.count({
      where: { active: true, createdAt: { gte: monthStart } },
    }),
  ]);

  return NextResponse.json({
    totalTenants,
    activeContracts: activeContracts.length,
    inadimplentes: inadimplentes.length,
    newThisMonth,
  });
}
