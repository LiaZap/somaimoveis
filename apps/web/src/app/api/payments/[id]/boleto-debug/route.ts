import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";
import { sicrediCreateBoleto } from "@/lib/sicredi-client";
import type { CreateBoletoParams } from "@/lib/sicredi-client";

/**
 * POST /api/payments/[id]/boleto-debug?mode=minimal|nofees|novalidade|full
 *
 * Endpoint de DEBUG (so admin) — tenta emitir o boleto com diferentes
 * configuracoes pra isolar qual campo o Sicredi esta rejeitando.
 *
 * NAO atualiza o Payment no banco — eh so um teste isolado. Se sucesso,
 * o boleto fica orfao no Sicredi (cancelar manualmente depois) mas
 * pelo menos sabemos qual config funciona.
 */
function tipoPessoa(cpfCnpj: string): "PESSOA_FISICA" | "PESSOA_JURIDICA" {
  return cpfCnpj.replace(/\D/g, "").length === 11
    ? "PESSOA_FISICA"
    : "PESSOA_JURIDICA";
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  const { id } = await params;
  const mode = new URL(request.url).searchParams.get("mode") || "minimal";

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: { tenant: true, owner: true },
  });
  if (!payment || !payment.tenant || !payment.owner) {
    return NextResponse.json({ error: "Pagamento ou partes nao encontrados" }, { status: 404 });
  }

  const tenant = payment.tenant;
  const owner = payment.owner;

  // Ajusta dueDate se passada
  let due = new Date(payment.dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  if (due < today) {
    due = new Date();
    due.setHours(12, 0, 0, 0);
  }

  // Boleto MINIMAL: sem multa, sem juros, sem validade, sem informativos
  const minimal: CreateBoletoParams = {
    pagador: {
      nome: tenant.name,
      documento: (tenant.cpfCnpj || "").replace(/\D/g, ""),
      endereco: `${tenant.street || ""} ${tenant.number || ""}`.trim() || "Rua Sem Nome 1",
      cidade: tenant.city || "Santa Cruz do Sul",
      uf: tenant.state || "RS",
      cep: (tenant.zipCode || "96810000").replace(/\D/g, ""),
      tipoPessoa: tipoPessoa(tenant.cpfCnpj || ""),
    },
    beneficiarioFinal: {
      nome: owner.name,
      documento: (owner.cpfCnpj || "").replace(/\D/g, ""),
      logradouro: `${owner.street || ""} ${owner.number || ""}`.trim() || "Rua Sem Nome 1",
      cidade: owner.city || "Santa Cruz do Sul",
      uf: owner.state || "RS",
      cep: (owner.zipCode || "96810000").replace(/\D/g, ""),
      tipoPessoa: tipoPessoa(owner.cpfCnpj || ""),
    },
    valor: payment.value,
    dataVencimento: formatDate(due),
    seuNumero: `DBG-${Date.now().toString().slice(-8)}`,
    tipoCobranca: "HIBRIDO",
  };

  const params2: CreateBoletoParams = { ...minimal };

  switch (mode) {
    case "minimal":
      // Apenas pagador + beneficiarioFinal + valor + dueDate
      break;
    case "fees":
      // Adiciona multa + juros
      params2.multa = { tipo: "PERCENTUAL", valor: 2 };
      params2.juros = { tipo: "PERCENTUAL_MES", valor: 1 };
      break;
    case "validade":
      // Adiciona so validadeAposVencimento
      params2.validadeAposVencimento = 30;
      break;
    case "informativos":
      // Adiciona so informativos
      params2.informativos = ["Teste 1", "Teste 2"];
      break;
    case "full":
      params2.multa = { tipo: "PERCENTUAL", valor: 2 };
      params2.juros = { tipo: "PERCENTUAL_MES", valor: 1 };
      params2.validadeAposVencimento = 30;
      params2.informativos = ["Teste full"];
      break;
  }

  console.log(`[DEBUG] Tentando boleto em modo "${mode}":`, JSON.stringify(params2, null, 2));

  const result = await sicrediCreateBoleto(params2);

  return NextResponse.json({
    mode,
    result,
    sentParams: params2,
  });
}
