/**
 * GET /api/fiscal-settings/spedy-city-info?code=4316808
 *
 * Consulta /v1/service-invoices/cities da Spedy pra um codigo IBGE
 * e retorna info do provedor + formato esperado do cTribMun (cityServiceCode).
 *
 * Default: Santa Cruz do Sul (4316808).
 *
 * Util pra descobrir qual o formato exato do "Código do serviço no
 * município" que a prefeitura aceita (pattern do TCCodTribMun varia
 * por cidade — 4, 6, 7 ou 9 digitos).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePagePermission, isAuthError } from "@/lib/api-auth";
import { safeDecryptString } from "@/lib/crypto";

const ENDPOINT = {
  HOMOLOGACAO: "https://sandbox-api.spedy.com.br/v1",
  PRODUCAO: "https://api.spedy.com.br/v1",
} as const;

export async function GET(req: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const code = new URL(req.url).searchParams.get("code") || "4316808"; // SC do Sul

  const settings = await prisma.fiscalSettings.findFirst();
  if (!settings?.apiToken) {
    return NextResponse.json(
      { error: "API Key Spedy nao configurada" },
      { status: 400 }
    );
  }

  const apiKey = safeDecryptString(settings.apiToken);
  const ambienteRaw = (settings.ambiente || "HOMOLOGACAO").toUpperCase();
  const ambiente = ambienteRaw === "PRODUCAO" ? "PRODUCAO" : "HOMOLOGACAO";
  const baseUrl = ENDPOINT[ambiente];
  const url = `${baseUrl}/service-invoices/cities?code=${encodeURIComponent(code)}`;

  let httpStatus: number | null = null;
  let responseBody: unknown = null;
  let fetchError: string | null = null;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "X-Api-Key": apiKey },
    });
    httpStatus = res.status;
    const text = await res.text();
    try { responseBody = JSON.parse(text); } catch { responseBody = text; }
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({
    ambiente,
    url,
    ibgeCode: code,
    spedy: { httpStatus, fetchError, response: responseBody },
    dica: httpStatus === 200
      ? "Procure no response: provider, nationalServiceInvoiceRegimes, cityServiceCodePattern, cityServiceCodeLength ou similar."
      : "Falha na consulta. Verifique se a chave Spedy esta correta e tem permissao.",
  });
}
