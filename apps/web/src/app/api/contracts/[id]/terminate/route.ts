/**
 * POST /api/contracts/:id/terminate
 *
 * Rescinde um contrato:
 * - Muda status para RESCINDIDO
 * - Grava terminatedAt (data) e terminationReason (motivo opcional)
 * - Dados permanecem no banco para relatorios fiscais (DIMOB)
 * - Billing/generate ignora contratos RESCINDIDOS (sem novas cobrancas)
 *
 * Body opcional:
 *   { terminatedAt?: "YYYY-MM-DD", terminationReason?: string }
 *
 * Se terminatedAt nao for informado, usa data atual.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    const existing = await prisma.contract.findUnique({
      where: { id },
      select: { id: true, code: true, status: true },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Contrato nao encontrado" },
        { status: 404 }
      );
    }

    // Bloqueia rescisao se ja estiver RESCINDIDO/ENCERRADO/CANCELADO
    if (["RESCINDIDO", "ENCERRADO", "CANCELADO"].includes(existing.status)) {
      return NextResponse.json(
        { error: `Contrato ja esta no status ${existing.status}. Nao pode ser rescindido novamente.` },
        { status: 400 }
      );
    }

    // Parse data
    let terminatedAt: Date;
    if (body.terminatedAt) {
      const parsed = new Date(body.terminatedAt + "T12:00:00.000Z");
      if (isNaN(parsed.getTime())) {
        return NextResponse.json(
          { error: "Data de rescisao invalida. Use formato YYYY-MM-DD." },
          { status: 400 }
        );
      }
      terminatedAt = parsed;
    } else {
      terminatedAt = new Date();
    }

    const terminationReason = typeof body.terminationReason === "string"
      ? body.terminationReason.trim().slice(0, 500)
      : null;

    const updated = await prisma.contract.update({
      where: { id },
      data: {
        status: "RESCINDIDO",
        terminatedAt,
        terminationReason: terminationReason || null,
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Erro ao rescindir contrato:", error);
    return NextResponse.json(
      { error: "Erro ao rescindir contrato" },
      { status: 500 }
    );
  }
}
