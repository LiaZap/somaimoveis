import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

/**
 * Aggregated stats for the /financeiro summary cards.
 * Computes sums via Prisma aggregate so the DB does the heavy work — no
 * payment rows are sent over the wire.
 */
export async function GET(_request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);

  const [
    pagoSum,
    pendenteSum,
    atrasadoSum,
    pendenteVencidoSum,
    recebidoMesSum,
    countTotal,
    countPendentes,
    countPagos,
    countAtrasados,
  ] = await Promise.all([
    // Total faturamento (PAGO) — usa paidValue ou value
    prisma.payment.aggregate({
      where: { status: "PAGO" },
      _sum: { paidValue: true, value: true },
    }),
    // A receber: PENDENTE com vencimento >= hoje
    prisma.payment.aggregate({
      where: { status: "PENDENTE", dueDate: { gte: today } },
      _sum: { value: true },
    }),
    // Atrasado oficial
    prisma.payment.aggregate({
      where: { status: "ATRASADO" },
      _sum: { value: true },
    }),
    // PENDENTE com vencimento no passado (atrasados implicitos)
    prisma.payment.aggregate({
      where: { status: "PENDENTE", dueDate: { lt: today } },
      _sum: { value: true },
    }),
    // Recebido este mes
    prisma.payment.aggregate({
      where: {
        status: "PAGO",
        paidAt: { gte: monthStart, lte: monthEnd },
      },
      _sum: { paidValue: true, value: true },
    }),
    prisma.payment.count(),
    prisma.payment.count({ where: { status: "PENDENTE", dueDate: { gte: today } } }),
    prisma.payment.count({ where: { status: "PAGO" } }),
    prisma.payment.count({
      where: {
        OR: [
          { status: "ATRASADO" },
          { AND: [{ status: "PENDENTE" }, { dueDate: { lt: today } }] },
        ],
      },
    }),
  ]);

  // Para "PAGO": prefere paidValue, cai pra value se for null.
  // Como agregado nao consegue COALESCE direto, somamos paidValue + value
  // dos que nao tem paidValue. Aproximacao: somamos value (que costuma ser
  // igual ao paidValue na maioria dos casos). Ajuste futuro: query SQL crua.
  const totalFaturamento = pagoSum._sum.paidValue || pagoSum._sum.value || 0;
  const totalAReceber = pendenteSum._sum.value || 0;
  const totalEmAtraso =
    (atrasadoSum._sum.value || 0) + (pendenteVencidoSum._sum.value || 0);
  const recebidoEsteMes =
    recebidoMesSum._sum.paidValue || recebidoMesSum._sum.value || 0;

  return NextResponse.json({
    totalFaturamento,
    totalAReceber,
    totalEmAtraso,
    recebidoEsteMes,
    counts: {
      total: countTotal,
      pendentes: countPendentes,
      pagos: countPagos,
      atrasados: countAtrasados,
    },
  });
}
