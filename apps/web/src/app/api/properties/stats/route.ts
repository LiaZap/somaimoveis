import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

/**
 * Aggregated stats for the /imoveis summary cards.
 */
export async function GET(_request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const [totalProperties, availableProperties, rentedProperties] = await Promise.all([
    prisma.property.count({ where: { active: true } }),
    prisma.property.count({ where: { active: true, status: "DISPONIVEL" } }),
    prisma.property.count({ where: { active: true, status: "ALUGADO" } }),
  ]);

  return NextResponse.json({
    totalProperties,
    availableProperties,
    rentedProperties,
  });
}
