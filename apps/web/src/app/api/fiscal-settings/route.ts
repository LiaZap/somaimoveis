import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthError } from "@/lib/api-auth";

/**
 * GET /api/fiscal-settings — retorna o registro singleton (cria se nao existir)
 * PUT /api/fiscal-settings — atualiza o registro singleton
 *
 * Todos os campos sao opcionais — preenchidos gradualmente pela imobiliaria
 * conforme dados forem disponibilizados (CNPJ, certificado, provedor, etc).
 */
export async function GET() {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  let settings = await prisma.fiscalSettings.findFirst();
  if (!settings) {
    settings = await prisma.fiscalSettings.create({ data: {} });
  }
  // Nao expor o apiToken cru, certificadoPfx (binario gigante) nem a senha
  const { certificadoPfx, certificadoPassword, apiToken, ...safe } = settings;
  return NextResponse.json({
    ...safe,
    apiToken: apiToken ? "***" : null,
    apiTokenSet: !!apiToken,
    certificadoUploaded: !!certificadoPfx,
    certificadoPasswordSet: !!certificadoPassword,
  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthError(auth)) return auth;

  try {
    const body = await request.json();
    let existing = await prisma.fiscalSettings.findFirst();
    if (!existing) {
      existing = await prisma.fiscalSettings.create({ data: {} });
    }

    const data: Record<string, unknown> = {};
    const stringFields = [
      "razaoSocial",
      "cnpj",
      "inscricaoMunicipal",
      "inscricaoEstadual",
      "street",
      "number",
      "complement",
      "neighborhood",
      "city",
      "state",
      "zipCode",
      "cnae",
      "codigoServicoMunicipal",
      "regimeTributario",
      "certificadoNome",
      "provedor",
      "ambiente",
      "notes",
    ];
    for (const f of stringFields) {
      if (body[f] !== undefined) {
        data[f] = body[f] === "" ? null : body[f];
      }
    }

    if (body.aliquotaIss !== undefined) {
      data.aliquotaIss = body.aliquotaIss === "" || body.aliquotaIss == null
        ? null
        : parseFloat(body.aliquotaIss);
    }
    if (body.simplesAliquota !== undefined) {
      data.simplesAliquota = body.simplesAliquota === "" || body.simplesAliquota == null
        ? null
        : parseFloat(body.simplesAliquota);
    }
    if (body.optanteSimples !== undefined) data.optanteSimples = !!body.optanteSimples;
    if (body.incentivadorCultural !== undefined) data.incentivadorCultural = !!body.incentivadorCultural;
    if (body.retemIss !== undefined) data.retemIss = !!body.retemIss;
    if (body.certificadoExpiraEm !== undefined) {
      data.certificadoExpiraEm = body.certificadoExpiraEm
        ? new Date(`${body.certificadoExpiraEm}T12:00:00`)
        : null;
    }

    // Token: so atualiza se enviado E nao for o placeholder
    if (body.apiToken && body.apiToken !== "***") {
      data.apiToken = body.apiToken;
    } else if (body.apiToken === null || body.apiToken === "") {
      data.apiToken = null;
    }

    const updated = await prisma.fiscalSettings.update({
      where: { id: existing.id },
      data,
    });

    const { certificadoPfx, certificadoPassword, apiToken, ...safe } = updated;
    return NextResponse.json({
      ...safe,
      apiToken: apiToken ? "***" : null,
      apiTokenSet: !!apiToken,
      certificadoUploaded: !!certificadoPfx,
      certificadoPasswordSet: !!certificadoPassword,
    });
  } catch (error: any) {
    console.error("[Fiscal Settings PUT]", error);
    return NextResponse.json(
      { error: error?.message || "Erro ao salvar configuracoes" },
      { status: 500 }
    );
  }
}
