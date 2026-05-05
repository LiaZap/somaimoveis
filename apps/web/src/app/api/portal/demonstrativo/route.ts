import { NextRequest, NextResponse } from "next/server";
import { verifyPortalToken } from "@/lib/portal-auth";
import { buildDemonstrativo } from "@/lib/demonstrativo";

/**
 * GET /api/portal/demonstrativo?month=YYYY-MM
 *
 * Versão do demonstrativo para o portal do proprietário. Força o ownerId
 * a partir do JWT do portal — o proprietário só pode ver os próprios
 * demonstrativos. Não expõe nada da empresa nem de outros proprietários.
 */
export async function GET(request: NextRequest) {
  const auth = await verifyPortalToken(request);
  if (!auth) {
    return NextResponse.json({ error: "Nao autorizado" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const monthStr = searchParams.get("month");

    const result = await buildDemonstrativo({
      ownerId: auth.ownerId,
      monthStr,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result.data);
  } catch (error) {
    console.error("[Portal Demonstrativo]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro" },
      { status: 500 },
    );
  }
}
