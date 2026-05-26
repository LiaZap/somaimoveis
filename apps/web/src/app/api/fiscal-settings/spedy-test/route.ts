/**
 * GET /api/fiscal-settings/spedy-test
 *
 * Endpoint de diagnostico. Faz um GET cru em /webhooks da Spedy e devolve:
 *   - ambiente usado
 *   - chave mascarada (primeiros 4 + ultimos 4 chars, comprimento)
 *   - status HTTP
 *   - body cru da resposta
 *
 * Usado pra debugar 401 / chave invalida sem precisar adivinhar.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePagePermission, isAuthError } from "@/lib/api-auth";
import { safeDecryptString } from "@/lib/crypto";

const ENDPOINT = {
  HOMOLOGACAO: "https://sandbox-api.spedy.com.br/v1",
  PRODUCAO: "https://api.spedy.com.br/v1",
} as const;

function maskKey(k: string): string {
  if (!k) return "(vazia)";
  if (k.length <= 8) return `(${k.length} chars) ${"*".repeat(k.length)}`;
  const first = k.slice(0, 4);
  const last = k.slice(-4);
  return `(${k.length} chars) ${first}...${last}`;
}

export async function GET(_req: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

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

  // Diagnostico da chave (sem expor): tamanho, primeiros/ultimos 4 chars,
  // e checa se tem caracteres estranhos (espaco, quebra de linha)
  const hasWhitespace = /\s/.test(apiKey);
  const startsWithSpace = apiKey !== apiKey.trimStart();
  const endsWithSpace = apiKey !== apiKey.trimEnd();
  const decryptWorked = settings.apiToken !== apiKey; // se decryptou, mudou

  // Faz a chamada crua pra Spedy
  const url = `${baseUrl}/webhooks`;
  let httpStatus: number | null = null;
  let responseBody: unknown = null;
  let fetchError: string | null = null;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Api-Key": apiKey,
      },
    });
    httpStatus = res.status;
    const text = await res.text();
    try { responseBody = JSON.parse(text); } catch { responseBody = text; }
  } catch (err: unknown) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({
    ambiente,
    baseUrl,
    url,
    chave: {
      mascarada: maskKey(apiKey),
      comprimento: apiKey.length,
      temEspacoOuQuebra: hasWhitespace,
      comecaComEspaco: startsWithSpace,
      terminaComEspaco: endsWithSpace,
      decifragemOk: decryptWorked,
    },
    spedy: {
      httpStatus,
      fetchError,
      responseBody,
    },
    dica: httpStatus === 401
      ? "Chave rejeitada. Verifique se eh da mesma ambiente (sandbox vs producao) e se nao tem espaco/quebra. Pegue de novo no painel Spedy > API Keys."
      : httpStatus === 200
      ? "Chave valida e funcionando!"
      : null,
  });
}
