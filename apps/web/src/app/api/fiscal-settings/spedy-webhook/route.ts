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

function getReceiverUrl(request: NextRequest): string {
  // Permite override via env (util pra dev/staging)
  const fromEnv = process.env.SPEDY_WEBHOOK_URL;
  if (fromEnv) return fromEnv;

  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host = request.headers.get("x-forwarded-host") ||
    request.headers.get("host") || "sommaimob.bahflash.tech";
  return `${proto}://${host}/api/webhook/spedy`;
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
    const err = e as { status?: number; message?: string };
    return NextResponse.json(
      { error: err.message || "Erro ao listar webhooks" },
      { status: err.status || 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requirePagePermission("notas_fiscais");
  if (isAuthError(auth)) return auth;

  const ctx = await getSpedyContext();
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  const receiverUrl = getReceiverUrl(request);
  const secret = process.env.WEBHOOK_SPEDY_SECRET || undefined;

  try {
    // Antes de criar, lista existentes e remove duplicados apontando pra mesma URL
    const existentes = await listarWebhooksSpedy(ctx.ambiente, ctx.apiKey);
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
      events: ["invoice.status_changed"],
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
