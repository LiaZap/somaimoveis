"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";

interface Movimento {
  date: string;
  descricao: string;
  entrada: number;
  saida: number;
}

interface ContratoGroup {
  contractId: string;
  code: string;
  property: {
    id: string;
    title: string;
    type: string;
    address: string;
  } | null;
  tenant: {
    id: string;
    name: string;
    cpfCnpj: string;
    personType: string;
  } | null;
  startDate: string | null;
  lastAdjustmentDate: string | null;
  movimentos: Movimento[];
  totalEntradas: number;
  totalSaidas: number;
  totalLiquido: number;
  aluguelBruto: number;
  adminFee: number;
  irrf: number;
}

interface DemonstrativoData {
  periodo: { start: string; end: string; month: string; mesReferencia?: string; mesVencimento?: string };
  empresa: { nome: string; cnpj: string };
  proprietario: {
    id: string;
    name: string;
    cpfCnpj: string;
    personType: string;
  };
  dataReferenciaPagamento: string;
  contratos: ContratoGroup[];
  avulsas: Movimento[];
  totais: {
    entradas: number;
    saidas: number;
    movimento: number;
    saldoMesAnterior: number;
    valorRetido: number;
    totalPago: number;
  };
  totaisPFPJ: {
    pf: { aluguel: number; comissao: number; irrf: number };
    pj: { aluguel: number; comissao: number; irrf: number };
  };
  pagamento: {
    beneficiario: string;
    data: string;
    forma: string;
    chavePix: string;
    pixType: string;
    bank: string;
    agency: string;
    account: string;
    valor: number;
  };
}

const TIPO_IMOVEL_LABELS: Record<string, string> = {
  CASA: "Casa",
  APARTAMENTO: "Apto",
  COMERCIAL: "Comercial",
  TERRENO: "Terreno",
  SALA: "Sala",
  PAVILHAO: "Pavilhao",
  LOJA: "Loja",
};

function formatMoney(v: number): string {
  if (v === 0) return "";
  return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

function formatMoneyAbs(v: number): string {
  return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v));
}

function formatDateShort(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

function RelatorioContent() {
  const searchParams = useSearchParams();
  const ownerId = searchParams.get("ownerId");
  const month = searchParams.get("month");
  const [data, setData] = useState<DemonstrativoData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ownerId) {
      setLoading(false);
      return;
    }
    const url = `/api/repasses/demonstrativo?ownerId=${ownerId}${month ? `&month=${month}` : ""}`;
    fetch(url)
      .then((r) => r.json())
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [ownerId, month]);

  useEffect(() => {
    if (!loading && data) {
      setTimeout(() => window.print(), 500);
    }
  }, [loading, data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-lg text-gray-500">Carregando demonstrativo...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-lg text-red-500">Dados nao encontrados.</p>
      </div>
    );
  }

  const today = new Date().toLocaleString("pt-BR");

  return (
    <div className="demo-page">
      <style>{styles}</style>
      <button className="print-btn no-print" onClick={() => window.print()}>
        Imprimir / Salvar PDF
      </button>

      {/* Header */}
      <div className="top-header">
        <div className="empresa-block">
          <div className="empresa-nome">{data.empresa.nome}</div>
          <div className="empresa-cnpj">{data.empresa.cnpj}</div>
        </div>
        <div className="titulo-block">
          <div className="titulo">Demonstrativo de Pagamentos</div>
          <div className="periodo">
            Mes Referencia: {data.periodo.mesReferencia || data.periodo.month}
            {data.periodo.mesVencimento ? ` (Venc: ${data.periodo.mesVencimento})` : ""}
          </div>
          <div style={{ fontSize: "10px", fontWeight: 400 }}>
            Periodo: {data.periodo.start} a {data.periodo.end}
          </div>
        </div>
        <div className="pagina">Pagina 1</div>
      </div>

      {/* Proprietario */}
      <div className="prop-box">
        <div className="prop-line">
          <strong>Proprietario:</strong> {data.proprietario.name}
          <span className="prop-doc">
            {data.proprietario.personType === "PJ" ? "CNPJ:" : "CPF:"} {data.proprietario.cpfCnpj}
          </span>
        </div>
        <div className="prop-line ref">
          <strong>Data referencia pagamento:</strong> {data.dataReferenciaPagamento}
        </div>
      </div>

      {/* Tabela principal */}
      <table className="main-table">
        <thead>
          <tr>
            <th style={{ width: "80px" }}>Data</th>
            <th>Movimentos</th>
            <th style={{ width: "110px", textAlign: "right" }}>Entrada</th>
            <th style={{ width: "110px", textAlign: "right" }}>Saida</th>
          </tr>
        </thead>
        <tbody>
          {data.contratos.length === 0 && data.avulsas.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                Nenhum movimento encontrado no periodo.
              </td>
            </tr>
          )}

          {data.contratos.map((c) => (
            <>
              {/* Cabecalho do imovel/contrato */}
              <tr key={`h-${c.contractId}`} className="contract-header">
                <td colSpan={2}>
                  <div className="imovel-line">
                    <strong>Imovel: {c.code}</strong>
                    {c.property?.title && <span> - {c.property.title}</span>}
                    {c.property?.address && <span className="addr"> - {c.property.address}</span>}
                  </div>
                  <div className="tenant-line">
                    <strong>Locatario:</strong> {c.tenant?.name || "-"}
                    {c.tenant?.cpfCnpj && (
                      <span className="tenant-doc">
                        {" "}
                        {c.tenant?.personType === "PJ" ? "CNPJ:" : "CPF:"} {c.tenant.cpfCnpj}
                      </span>
                    )}
                  </div>
                </td>
                <td colSpan={2} className="contract-dates">
                  <div>Dt Inicio: {formatDateShort(c.startDate)}</div>
                  <div>
                    Dt ult. reajuste:{" "}
                    {c.lastAdjustmentDate ? formatDateShort(c.lastAdjustmentDate) : "-"}
                  </div>
                  {c.property?.type && (
                    <div className="tipo-imovel">
                      {TIPO_IMOVEL_LABELS[c.property.type] || c.property.type}
                    </div>
                  )}
                </td>
              </tr>

              {/* Movimentos */}
              {c.movimentos.map((m, i) => (
                <tr key={`m-${c.contractId}-${i}`}>
                  <td>{m.date}</td>
                  <td>{m.descricao}</td>
                  <td className="right">{m.entrada > 0 ? formatMoney(m.entrada) : ""}</td>
                  <td className="right minus">{m.saida > 0 ? `-${formatMoney(m.saida)}` : ""}</td>
                </tr>
              ))}

              {/* Totais */}
              <tr className="totais-row">
                <td colSpan={2} style={{ textAlign: "right" }}>
                  <strong>Totais:</strong>
                </td>
                <td className="right bold">{formatMoney(c.totalEntradas)}</td>
                <td className="right bold minus">
                  {c.totalSaidas > 0 ? `-${formatMoney(c.totalSaidas)}` : ""}
                </td>
              </tr>
              <tr className="total-contrato-row">
                <td colSpan={3} style={{ textAlign: "right" }}>
                  <strong>Total contrato:</strong>
                </td>
                <td className="right bold">{formatMoney(c.totalLiquido)}</td>
              </tr>
            </>
          ))}

          {/* Movimentos avulsos */}
          {data.avulsas.length > 0 && (
            <>
              <tr className="contract-header">
                <td colSpan={4}>
                  <strong>Movimentos avulsos (sem contrato vinculado)</strong>
                </td>
              </tr>
              {data.avulsas.map((m, i) => (
                <tr key={`a-${i}`}>
                  <td>{m.date}</td>
                  <td>{m.descricao}</td>
                  <td className="right">{m.entrada > 0 ? formatMoney(m.entrada) : ""}</td>
                  <td className="right minus">
                    {m.saida > 0 ? `-${formatMoney(m.saida)}` : ""}
                  </td>
                </tr>
              ))}
            </>
          )}

          {/* Total final */}
          <tr className="total-final-row">
            <td colSpan={2} style={{ textAlign: "right" }}>
              <strong>Total final:</strong>
            </td>
            <td className="right bold">{formatMoney(data.totais.entradas)}</td>
            <td className="right bold minus">
              {data.totais.saidas > 0 ? `-${formatMoney(data.totais.saidas)}` : ""}
            </td>
          </tr>
          <tr className="total-movimento-row">
            <td colSpan={3} style={{ textAlign: "right" }}>
              <strong>Total movimento:</strong>
            </td>
            <td className="right bold">{formatMoney(data.totais.movimento)}</td>
          </tr>
        </tbody>
      </table>

      {/* Resumo em 2 colunas */}
      <div className="resumo-grid">
        <div className="resumo-left">
          <table className="pfpj-table">
            <thead>
              <tr>
                <th>Total aluguel locatarios:</th>
                <th className="right">Aluguel</th>
                <th className="right">Comissao</th>
                <th className="right">Total I.R.</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Pessoa Fisica</td>
                <td className="right">{formatMoney(data.totaisPFPJ.pf.aluguel)}</td>
                <td className="right minus">
                  {data.totaisPFPJ.pf.comissao > 0 ? `-${formatMoney(data.totaisPFPJ.pf.comissao)}` : ""}
                </td>
                <td className="right">
                  {formatMoney(data.totaisPFPJ.pf.aluguel - data.totaisPFPJ.pf.comissao)}
                </td>
              </tr>
              <tr>
                <td>Pessoa Juridica</td>
                <td className="right">{formatMoney(data.totaisPFPJ.pj.aluguel)}</td>
                <td className="right minus">
                  {data.totaisPFPJ.pj.comissao > 0 ? `-${formatMoney(data.totaisPFPJ.pj.comissao)}` : ""}
                </td>
                <td className="right">
                  {formatMoney(data.totaisPFPJ.pj.aluguel - data.totaisPFPJ.pj.comissao)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="resumo-right">
          <table className="resumo-table">
            <tbody>
              <tr>
                <td>Total movimento:</td>
                <td className="right bold">{formatMoney(data.totais.movimento)}</td>
              </tr>
              <tr>
                <td>Saldo mes anterior:</td>
                <td className="right">{formatMoney(data.totais.saldoMesAnterior)}</td>
              </tr>
              <tr>
                <td>Valor retido:</td>
                <td className="right">{formatMoney(data.totais.valorRetido)}</td>
              </tr>
              <tr className="total-pago-row">
                <td>
                  <strong>Total pago:</strong>
                </td>
                <td className="right bold">{formatMoney(data.totais.totalPago)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagamentos relacionados */}
      <div className="pagamentos-section">
        <div className="pagamentos-title">Pagamentos relacionados</div>
        <table className="pagamentos-table">
          <thead>
            <tr>
              <th>Beneficiario</th>
              <th>Data</th>
              <th>Forma de pag.</th>
              <th>Chave Pix / Conta</th>
              <th className="right">Valor</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{data.pagamento.beneficiario}</td>
              <td>{data.pagamento.data}</td>
              <td>{data.pagamento.forma}</td>
              <td>
                {data.pagamento.forma === "PIX"
                  ? data.pagamento.chavePix
                  : data.pagamento.forma === "TED"
                  ? `${data.pagamento.bank} Ag ${data.pagamento.agency} CC ${data.pagamento.account}`
                  : "-"}
              </td>
              <td className="right bold">{formatMoney(data.pagamento.valor)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="footer">
        <p>Acesse seu demonstrativo no portal do cliente.</p>
        <p style={{ marginTop: 10 }}>{today}</p>
      </div>
    </div>
  );
}

const styles = `
  @media print {
    body { margin: 0; padding: 0; }
    .no-print { display: none !important; }
    .demo-page { padding: 12mm; }
    @page { size: A4 portrait; margin: 0; }
    table { page-break-inside: auto; }
    tr { page-break-inside: avoid; page-break-after: auto; }
  }
  @media screen {
    .demo-page {
      max-width: 210mm;
      margin: 0 auto;
      padding: 15mm;
      background: white;
      box-shadow: 0 0 10px rgba(0,0,0,0.1);
      margin-top: 10px;
      margin-bottom: 20px;
    }
    body { background: #f5f5f5; }
  }
  .demo-page {
    font-family: Arial, Helvetica, sans-serif;
    color: #000;
    font-size: 10px;
    line-height: 1.3;
  }
  .top-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 8px;
    padding-bottom: 4px;
  }
  .empresa-block {
    font-size: 11px;
  }
  .empresa-nome { font-weight: 700; }
  .empresa-cnpj { font-size: 9px; }
  .titulo-block { text-align: center; flex: 1; }
  .titulo { font-size: 13px; font-weight: 700; }
  .periodo { font-size: 11px; font-weight: 700; }
  .pagina { font-size: 10px; text-align: right; }
  .prop-box {
    border: 1px solid #000;
    padding: 4px 8px;
    margin-bottom: 0;
    border-bottom: none;
  }
  .prop-line {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
  }
  .prop-doc { font-weight: 700; }
  .prop-line.ref { font-size: 10px; padding-top: 2px; }
  .main-table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid #000;
    font-size: 10px;
  }
  .main-table thead th {
    background: #f0f0f0;
    border: 1px solid #000;
    padding: 3px 6px;
    text-align: left;
    font-size: 10px;
    font-weight: 700;
  }
  .main-table td {
    border-left: 1px solid #000;
    border-right: 1px solid #000;
    padding: 2px 6px;
    vertical-align: top;
  }
  .main-table td.right { text-align: right; font-variant-numeric: tabular-nums; }
  .main-table td.minus { color: #000; }
  .main-table td.bold { font-weight: 700; }
  tr.contract-header td {
    background: #f5f5f5;
    border-top: 1px solid #000;
    border-bottom: 1px solid #ccc;
    padding: 4px 6px;
    font-size: 10px;
  }
  .imovel-line { font-weight: 700; }
  .imovel-line .addr { font-weight: 400; font-size: 9px; }
  .tenant-line { margin-top: 2px; }
  .tenant-doc { font-size: 9px; }
  .contract-dates {
    font-size: 10px;
    text-align: right;
    white-space: nowrap;
  }
  .tipo-imovel { font-weight: 700; margin-top: 2px; }
  tr.totais-row td {
    border-top: 1px solid #000;
    background: #fafafa;
    padding: 3px 6px;
  }
  tr.total-contrato-row td {
    border-top: 1px solid #000;
    border-bottom: 2px solid #000;
    background: #f0f0f0;
    padding: 4px 6px;
    font-weight: 700;
  }
  tr.total-final-row td {
    border-top: 2px solid #000;
    background: #e8e8e8;
    padding: 4px 6px;
    font-weight: 700;
  }
  tr.total-movimento-row td {
    border-top: 1px solid #000;
    background: #d8d8d8;
    padding: 4px 6px;
    font-weight: 700;
  }
  .empty { text-align: center; padding: 20px; font-style: italic; }
  .resumo-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-top: 10px;
  }
  .pfpj-table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid #000;
    font-size: 10px;
  }
  .pfpj-table th {
    border: 1px solid #000;
    background: #f0f0f0;
    padding: 3px 6px;
    font-weight: 700;
    text-align: left;
  }
  .pfpj-table th.right { text-align: right; }
  .pfpj-table td {
    border: 1px solid #000;
    padding: 2px 6px;
  }
  .pfpj-table td.right { text-align: right; font-variant-numeric: tabular-nums; }
  .resumo-table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid #000;
    font-size: 10px;
  }
  .resumo-table td {
    border: 1px solid #000;
    padding: 3px 8px;
  }
  .resumo-table td.right { text-align: right; font-variant-numeric: tabular-nums; }
  .resumo-table td.bold { font-weight: 700; }
  tr.total-pago-row td {
    background: #f0f0f0;
    font-weight: 700;
    border-top: 2px solid #000;
  }
  .pagamentos-section { margin-top: 10px; }
  .pagamentos-title {
    font-weight: 700;
    font-size: 11px;
    margin-bottom: 2px;
  }
  .pagamentos-table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid #000;
    font-size: 10px;
  }
  .pagamentos-table th {
    background: #f0f0f0;
    border: 1px solid #000;
    padding: 3px 6px;
    text-align: left;
    font-weight: 700;
  }
  .pagamentos-table th.right { text-align: right; }
  .pagamentos-table td {
    border: 1px solid #000;
    padding: 3px 6px;
  }
  .pagamentos-table td.right { text-align: right; font-variant-numeric: tabular-nums; }
  .pagamentos-table td.bold { font-weight: 700; }
  .footer {
    margin-top: 15px;
    font-size: 9px;
    color: #555;
  }
  .print-btn {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: #2563eb;
    color: white;
    border: none;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 100;
  }
  .print-btn:hover { background: #1d4ed8; }
`;

export default function DemonstrativoPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><p>Carregando...</p></div>}>
      <RelatorioContent />
    </Suspense>
  );
}
