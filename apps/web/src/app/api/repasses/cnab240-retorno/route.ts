import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, isAuthError } from "@/lib/api-auth";
import { parseCnab240Retorno } from "@/lib/cnab240-retorno";

/**
 * POST /api/repasses/cnab240-retorno
 * Importa arquivo de retorno CNAB 240 Sicredi (.RET)
 * Faz o match com OwnerEntries pendentes e opcionalmente marca como PAGO.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (isAuthError(auth)) return auth;

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const autoConfirm = formData.get("autoConfirm") === "true";

    if (!file) {
      return NextResponse.json({ error: "Arquivo não enviado" }, { status: 400 });
    }

    const content = await file.text();
    const retorno = parseCnab240Retorno(content);

    // Match pagamentos do retorno com OwnerEntries no banco
    // O documentoEmpresa no CNAB remessa é "REP-{8 últimos dígitos do CPF}"
    // Buscar todas entries CREDITO pendentes ou pagas para match
    const allEntries = await prisma.ownerEntry.findMany({
      where: {
        type: "CREDITO",
        status: { in: ["PENDENTE", "PAGO"] },
      },
      include: {
        owner: { select: { id: true, name: true, cpfCnpj: true } },
      },
    });

    // Indexar entries por CPF (últimos 8 dígitos) para match rápido
    const entriesByCpfSuffix: Record<string, typeof allEntries> = {};
    for (const entry of allEntries) {
      const cpfClean = entry.owner.cpfCnpj.replace(/\D/g, "");
      const suffix = cpfClean.slice(-8);
      const key = `REP-${suffix}`;
      if (!entriesByCpfSuffix[key]) entriesByCpfSuffix[key] = [];
      entriesByCpfSuffix[key].push(entry);
    }

    const resultados: {
      favorecido: string;
      documento: string;
      valor: number;
      status: "sucesso" | "erro" | "sem_match";
      ocorrencias: string;
      entryIds?: string[];
      ownerName?: string;
      marcadoPago?: boolean;
      entriesMarcadas?: number;
    }[] = [];

    const entryIdsToMarkPago: string[] = [];

    for (const pgto of retorno.pagamentos) {
      const docEmpresa = pgto.documentoEmpresa.trim();

      // Tentar match pelo documentoEmpresa
      // O CNAB remessa agrupa TODOS os créditos de um proprietário em um único pagamento,
      // então precisamos marcar TODAS as entries PENDENTES desse proprietário como PAGO.
      const matchedEntries = entriesByCpfSuffix[docEmpresa] || [];
      const pendentes = matchedEntries.filter(e => e.status === "PENDENTE");

      const ocorrenciasStr = pgto.ocorrencias.map(o => `${o.codigo}: ${o.descricao}`).join("; ");

      if (matchedEntries.length === 0) {
        resultados.push({
          favorecido: pgto.favorecidoNome,
          documento: docEmpresa,
          valor: pgto.valorPagamento,
          status: pgto.sucesso ? "sucesso" : "erro",
          ocorrencias: ocorrenciasStr,
        });
        continue;
      }

      const resultado: typeof resultados[0] = {
        favorecido: pgto.favorecidoNome,
        documento: docEmpresa,
        valor: pgto.valorPagamento,
        status: pgto.sucesso ? "sucesso" : "erro",
        ocorrencias: ocorrenciasStr,
        entryIds: matchedEntries.map(e => e.id),
        ownerName: matchedEntries[0].owner.name,
        marcadoPago: false,
        entriesMarcadas: 0,
      };

      // Se sucesso e autoConfirm, marcar TODAS as entries PENDENTES desse proprietário
      if (pgto.sucesso && autoConfirm && pendentes.length > 0) {
        for (const entry of pendentes) {
          entryIdsToMarkPago.push(entry.id);
        }
        resultado.marcadoPago = true;
        resultado.entriesMarcadas = pendentes.length;
      }

      resultados.push(resultado);
    }

    // Batch update: marcar como PAGO
    let totalMarcados = 0;
    if (entryIdsToMarkPago.length > 0) {
      const updated = await prisma.ownerEntry.updateMany({
        where: { id: { in: entryIdsToMarkPago } },
        data: { status: "PAGO", paidAt: new Date() },
      });
      totalMarcados = updated.count;
    }

    return NextResponse.json({
      arquivo: {
        banco: retorno.banco,
        empresa: retorno.empresa,
        dataGeracao: retorno.dataGeracao,
        sequencial: retorno.sequencialArquivo,
        totalLotes: retorno.totalLotes,
        totalRegistros: retorno.totalRegistros,
      },
      resumo: {
        totalPagamentos: retorno.pagamentos.length,
        sucesso: retorno.resumo.sucesso,
        erro: retorno.resumo.erro,
        valorTotal: retorno.resumo.valorTotal,
        valorEfetivado: retorno.resumo.valorEfetivado,
        matchados: resultados.filter(r => r.entryIds && r.entryIds.length > 0).length,
        semMatch: resultados.filter(r => !r.entryIds || r.entryIds.length === 0).length,
        marcadosPago: totalMarcados,
        entriesMarcadas: resultados.reduce((s, r) => s + (r.entriesMarcadas || 0), 0),
      },
      resultados,
    });
  } catch (error) {
    console.error("[CNAB240 Retorno]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao processar arquivo de retorno" },
      { status: 500 }
    );
  }
}
