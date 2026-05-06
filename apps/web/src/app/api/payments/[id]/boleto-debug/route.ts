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
    // seuNumero max 10 chars no Sicredi
    seuNumero: `DBG${Date.now().toString().slice(-7)}`,
    tipoCobranca: "HIBRIDO",
  };

  const params2: CreateBoletoParams = { ...minimal };

  switch (mode) {
    case "minimal":
      // Apenas pagador + beneficiarioFinal + valor + dueDate (HIBRIDO)
      break;
    case "normal":
      // Igual minimal mas com tipoCobranca=NORMAL (sem PIX)
      params2.tipoCobranca = "NORMAL";
      break;
    case "fees":
      params2.multa = { tipo: "PERCENTUAL", valor: 2 };
      params2.juros = { tipo: "PERCENTUAL_MES", valor: 1 };
      break;
    case "fees-normal":
      params2.tipoCobranca = "NORMAL";
      params2.multa = { tipo: "PERCENTUAL", valor: 2 };
      params2.juros = { tipo: "PERCENTUAL_MES", valor: 1 };
      break;
    case "only-multa":
      // SO multa, sem juros
      params2.multa = { tipo: "PERCENTUAL", valor: 2 };
      break;
    case "only-juros":
      // SO juros, sem multa
      params2.juros = { tipo: "PERCENTUAL_MES", valor: 1 };
      break;
    case "multa-com-data":
      // Multa com data explicita (D+1 do venc)
      const d1 = new Date(due);
      d1.setDate(d1.getDate() + 1);
      params2.multa = { tipo: "PERCENTUAL", valor: 2, data: formatDate(d1) };
      break;
    case "multa-valor-fixo":
      // Multa em VALOR fixo (R$), nao percentual
      params2.multa = { tipo: "VALOR", valor: 50 };
      break;
    case "juros-com-data":
      const d2 = new Date(due);
      d2.setDate(d2.getDate() + 1);
      params2.juros = { tipo: "PERCENTUAL_MES", valor: 1, data: formatDate(d2) };
      break;
    case "validade":
      params2.validadeAposVencimento = 30;
      break;
    case "informativos":
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
