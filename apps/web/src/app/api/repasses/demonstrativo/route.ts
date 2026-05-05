import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthError } from "@/lib/api-auth";
import { buildDemonstrativo } from "@/lib/demonstrativo";

/**
 * GET /api/repasses/demonstrativo?ownerId=X&month=YYYY-MM
 * Demonstrativo detalhado (admin/dashboard).
 *
 * O parâmetro `month` representa o MÊS DO BOLETO (vencimento). O mês
 * de REFERÊNCIA do aluguel é calculado como month-1 (in-arrears).
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const ownerId = searchParams.get("ownerId");
    const monthStr = searchParams.get("month");

    if (!ownerId) {
      return NextResponse.json({ error: "ownerId obrigatorio" }, { status: 400 });
    }

    const result = await buildDemonstrativo({ ownerId, monthStr });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result.data);
  } catch (error) {
    console.error("[Demonstrativo]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro" },
      { status: 500 },
    );
  }
}
