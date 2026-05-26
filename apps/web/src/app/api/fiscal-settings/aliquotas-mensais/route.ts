/**
 * GET    /api/fiscal-settings/aliquotas-mensais       -> lista todas (ordem desc por ano/mes)
 * POST   /api/fiscal-settings/aliquotas-mensais       -> upsert por (ano, mes)
 *         body: { ano, mes, aliquotaIss, simplesAliquota?, notes? }
 * DELETE /api/fiscal-settings/aliquotas-mensais?id=X  -> remove por id
 *
 * Modelo: MonthlyAliquota. Usado pra sobrescrever aliquotaIss/simplesAliquota
 * globais do FiscalSettings no mes da competencia da NFS-e. Util no Simples
 * Nacional, onde a aliquota efetiva varia com o RBT12.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePagePermission, isAuthError } from "@/lib/api-auth";

export async function GET() {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const rows = await prisma.monthlyAliquota.findMany({
    orderBy: [{ ano: "desc" }, { mes: "desc" }],
  });
  return NextResponse.json({ items: rows });
}

function parseMonthInput(body: Record<string, unknown>): {
  ano: number;
  mes: number;
  aliquotaIss: number;
  simplesAliquota: number | null;
  notes: string | null;
} | { error: string } {
  const ano = Number(body.ano);
  const mes = Number(body.mes);
  const aliquotaIss = body.aliquotaIss === "" || body.aliquotaIss == null
    ? NaN
    : Number(body.aliquotaIss);
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) {
    return { error: "Ano invalido (esperado 2000-2100)" };
  }
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) {
    return { error: "Mes invalido (esperado 1-12)" };
  }
  if (!Number.isFinite(aliquotaIss) || aliquotaIss < 0 || aliquotaIss > 100) {
    return { error: "Aliquota ISS invalida (esperado 0-100)" };
  }
  const simplesAliquota = body.simplesAliquota === "" || body.simplesAliquota == null
    ? null
    : Number(body.simplesAliquota);
  if (simplesAliquota != null && (!Number.isFinite(simplesAliquota) || simplesAliquota < 0 || simplesAliquota > 100)) {
    return { error: "Aliquota Simples invalida (esperado 0-100)" };
  }
  const notes = typeof body.notes === "string" && body.notes.trim() !== ""
    ? body.notes.trim()
    : null;
  return { ano, mes, aliquotaIss, simplesAliquota, notes };
}

export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const body = await request.json().catch(() => ({}));
  const parsed = parseMonthInput(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { ano, mes, aliquotaIss, simplesAliquota, notes } = parsed;
  const row = await prisma.monthlyAliquota.upsert({
    where: { ano_mes: { ano, mes } },
    create: { ano, mes, aliquotaIss, simplesAliquota, notes },
    update: { aliquotaIss, simplesAliquota, notes },
  });

  return NextResponse.json({ ok: true, item: row });
}

export async function DELETE(request: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Parametro id obrigatorio" }, { status: 400 });
  }

  try {
    await prisma.monthlyAliquota.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erro ao remover" },
      { status: 500 },
    );
  }
}
