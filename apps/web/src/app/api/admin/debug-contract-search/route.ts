import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";

/**
 * GET /api/admin/debug-contract-search?q=TERMO
 *
 * Debug endpoint pra investigar busca de contratos. Mostra QUAL
 * contrato e QUAL campo casaram com o termo, sem filtros de status
 * ou paginacao.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  const q = new URL(request.url).searchParams.get("q") || "";
  if (!q.trim()) {
    return NextResponse.json({ error: "q obrigatorio" }, { status: 400 });
  }

  // Busca direta SEM o helper, gerando 3 variantes
  const variants = [q, q.toUpperCase(), q.toLowerCase()].filter(
    (v, i, arr) => arr.indexOf(v) === i,
  );
  const digits = q.replace(/\D/g, "");

  const all = await prisma.contract.findMany({
    select: {
      id: true,
      code: true,
      status: true,
      tenant: { select: { name: true, cpfCnpj: true } },
      owner: { select: { name: true, cpfCnpj: true } },
      property: { select: { title: true, street: true, neighborhood: true } },
    },
  });

  type Match = {
    code: string;
    status: string;
    matchedField: string;
    matchedValue: string;
    matchedVariant: string;
  };
  const matches: Match[] = [];

  for (const c of all) {
    const fields: Array<{ name: string; value: string | null }> = [
      { name: "code", value: c.code },
      { name: "tenant.name", value: c.tenant?.name || null },
      { name: "tenant.cpfCnpj", value: c.tenant?.cpfCnpj || null },
      { name: "owner.name", value: c.owner?.name || null },
      { name: "owner.cpfCnpj", value: c.owner?.cpfCnpj || null },
      { name: "property.title", value: c.property?.title || null },
      { name: "property.street", value: c.property?.street || null },
      { name: "property.neighborhood", value: c.property?.neighborhood || null },
    ];

    for (const f of fields) {
      if (!f.value) continue;
      // Tenta cada variante
      for (const v of variants) {
        if (f.value.includes(v)) {
          matches.push({
            code: c.code,
            status: c.status,
            matchedField: f.name,
            matchedValue: f.value,
            matchedVariant: v,
          });
          break;
        }
      }
      // Tenta digitos puros em campos numericos
      if (digits.length >= 3 && (f.name.includes("cpfCnpj") || f.name === "code")) {
        const fieldDigits = f.value.replace(/\D/g, "");
        if (fieldDigits.includes(digits)) {
          if (!matches.find((m) => m.code === c.code && m.matchedField === f.name)) {
            matches.push({
              code: c.code,
              status: c.status,
              matchedField: f.name + " (digits)",
              matchedValue: f.value,
              matchedVariant: digits,
            });
          }
        }
      }
    }
  }

  // Tambem retorna contratos cujo code numerico contem o termo
  // (ex: CTR-490 quando q="490")
  const codeOnlyMatches = all
    .filter((c) => {
      const codeDigits = c.code.replace(/\D/g, "");
      return digits.length >= 1 && codeDigits.includes(digits);
    })
    .map((c) => ({
      code: c.code,
      status: c.status,
      tenant: c.tenant?.name,
      owner: c.owner?.name,
    }));

  return NextResponse.json({
    query: q,
    variants,
    digits,
    totalContratos: all.length,
    totalMatches: matches.length,
    matches,
    codeOnlyMatches,
  });
}
