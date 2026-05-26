/**
 * GET    /api/fiscal-settings/spedy-webhook  -> lista webhooks cadastrados
 * POST   /api/fiscal-settings/spedy-webhook  -> cria/recadastra webhook apontando pro nosso receiver
 * DELETE /api/fiscal-settings/spedy-webhook?id=XXX  -> remove webhook
 *
 * Util porque a Spedy NAO oferece UI no painel pra gerenciar webhooks —
 * tudo eh feito via API REST com X-Api-Key.
 *
 * O webhook receiver do nosso lado fica em /api/webhook/spedy.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePagePermission, isAuthError } from "@/lib/api-auth";
import { safeDecryptString } from "@/lib/crypto";
import {
  criarWebhookSpedy,
  listarWebhooksSpedy,
  removerWebhookSpedy,
  type SpedyAmbiente,
} from "@/lib/nfse-spedy-client";

async function getSpedyContext(): Promise<
  | { ambiente: SpedyAmbiente; apiKey: string }
  | { error: string; status: number }
> {
  const settings = await prisma.fiscalSettings.findFirst();
  if (!settings) {
    return { error: "Configuracoes fiscais nao definidas", status: 400 };
  }
  const provedor = (settings.provedor || "").toUpperCase();
  if (provedor !== "SPEDY") {
    return { error: "Provedor atual nao e SPEDY", status: 400 };
  }
  if (!settings.apiToken) {
    return { error: "API Key da Spedy nao configurada", status: 400 };
  }
  const apiKey = safeDecryptString(settings.apiToken);
  if (!apiKey) {
    return { error: "API Key vazia apos decifragem", status: 500 };
  }
  const ambiente = (settings.ambiente || "HOMOLOGACAO").toUpperCase() as SpedyAmbiente;
  return { ambiente, apiKey };
}

// Whitelist de hosts aceitos quando SPEDY_WEBHOOK_URL nao esta setado.
// Defesa contra atacante plantando X-Forwarded-Host: attacker.com em proxy mal configurado.
const ALLOWED_HOSTS = ["sommaimob.bahflash.tech", "localhost", "localhost:3000", "127.0.0.1"];

function getReceiverUrl(request: NextRequest): { url: string } | { error: string; status: number } {
  // Permite override via env (util pra dev/staging) — caminho preferencial em producao
  const fromEnv = process.env.SPEDY_WEBHOOK_URL;
  if (fromEnv) return { url: fromEnv };

  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");

  if (!host) {
    return {
      error: "Nao foi possivel determinar o host do receiver. Configure SPEDY_WEBHOOK_URL nas env vars.",
      status: 500,
    };
  }

  if (!ALLOWED_HOSTS.includes(host)) {
    return {
      error: `Host "${host}" nao esta na whitelist de hosts permitidos. Configure SPEDY_WEBHOOK_URL nas env vars pra evitar webhook injection via X-Forwarded-Host.`,
      status: 500,
    };
  }

  return { url: `${proto}://${host}/api/webhook/spedy` };
}

export async function GET(_req: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const ctx = await getSpedyContext();
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  try {
    const webhooks = await listarWebhooksSpedy(ctx.ambiente, ctx.apiKey);
    return NextResponse.json({ webhooks });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string; body?: unknown };
    return NextResponse.json(
      {
        error: err.message || "Erro ao listar webhooks",
        details: err.body,
        ambiente: ctx.ambiente,
      },
      { status: err.status || 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const ctx = await getSpedyContext();
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  // Em PRODUCAO o secret eh obrigatorio — sem ele nao da pra autenticar webhook da Spedy.
  if (ctx.ambiente === "PRODUCAO" && !process.env.WEBHOOK_SPEDY_SECRET) {
    return NextResponse.json(
      {
        error: "WEBHOOK_SPEDY_SECRET nao configurado. Em producao, o secret eh obrigatorio pra autenticar webhooks da Spedy.",
        hint: "Adicione WEBHOOK_SPEDY_SECRET=<valor-aleatorio> nas env vars do servidor e tente de novo.",
      },
      { status: 400 },
    );
  }

  const receiverResult = getReceiverUrl(request);
  if ("error" in receiverResult) {
    return NextResponse.json({ error: receiverResult.error }, { status: receiverResult.status });
  }
  const receiverUrl = receiverResult.url;
  const secret = process.env.WEBHOOK_SPEDY_SECRET || undefined;

  if (ctx.ambiente !== "PRODUCAO" && !secret) {
    console.warn(
      "[Spedy webhook] WEBHOOK_SPEDY_SECRET nao configurado em HOMOLOGACAO — webhook sera criado sem secret.",
    );
  }

  // Lista existentes pra dedupar — se falhar, ABORTA pra nao gerar duplicados acumulando
  let existentes: Awaited<ReturnType<typeof listarWebhooksSpedy>>;
  try {
    existentes = await listarWebhooksSpedy(ctx.ambiente, ctx.apiKey);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string; body?: unknown };
    return NextResponse.json(
      {
        error: "Falha ao listar webhooks existentes antes de criar. Aborte pra evitar duplicados.",
        details: err.body ?? err.message,
      },
      { status: 502 },
    );
  }

  try {
    // Remove duplicados apontando pra mesma URL antes de criar o novo
    const duplicados = existentes.filter((w) => w.url === receiverUrl);
    for (const dup of duplicados) {
      try {
        await removerWebhookSpedy(ctx.ambiente, ctx.apiKey, dup.id);
      } catch (err) {
        console.warn("[Spedy webhook] Falha ao remover duplicata", dup.id, err);
      }
    }

    const created = await criarWebhookSpedy(ctx.ambiente, ctx.apiKey, {
      url: receiverUrl,
      event: "invoice.status_changed",
      description: "Somma Imoveis - integracao automatica",
      secret,
    });

    return NextResponse.json({
      ok: true,
      webhook: created,
      receiverUrl,
      secretConfigured: !!secret,
      removidos: duplicados.length,
    });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string; body?: unknown };
    return NextResponse.json(
      {
        error: err.message || "Erro ao criar webhook",
        details: err.body,
        receiverUrl,
      },
      { status: err.status || 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const ctx = await getSpedyContext();
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Parametro id obrigatorio" }, { status: 400 });
  }

  try {
    await removerWebhookSpedy(ctx.ambiente, ctx.apiKey, id);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return NextResponse.json(
      { error: err.message || "Erro ao remover webhook" },
      { status: err.status || 500 }
    );
  }
}
