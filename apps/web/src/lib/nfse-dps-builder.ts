/**
 * Gerador do XML DPS (Declaracao de Prestacao de Servicos) — Padrao Nacional NFS-e.
 *
 * Schema: ABRASF/RFB - versao 1.0 (DPS 1.0).
 * Modo: Emissao Completa (todos os campos obrigatorios + endereco completo).
 *
 * Documentacao oficial:
 *   https://www.gov.br/nfse/pt-br/centrais-de-conteudo/manuais-1
 *   Manual de Orientacao do Contribuinte (MOC)
 *
 * Estrutura simplificada:
 *   <DPS>
 *     <infDPS Id="DPS-...">
 *       <tpAmb>2</tpAmb> (homologacao=2, producao=1)
 *       <dhEmi>2026-05-05T12:00:00-03:00</dhEmi>
 *       <verAplic>1.00</verAplic>
 *       <serie>00001</serie>
 *       <nDPS>1</nDPS>
 *       <dCompet>2026-04-30</dCompet>
 *       <tpEmit>1</tpEmit> (1=prestador)
 *       <cLocEmi>4316808</cLocEmi> (codigo IBGE municipio)
 *       <subst>0</subst>
 *       <prest>...</prest>
 *       <toma>...</toma>
 *       <serv>...</serv>
 *       <valores>...</valores>
 *     </infDPS>
 *   </DPS>
 */

export interface DpsParams {
  ambiente: "HOMOLOGACAO" | "PRODUCAO";
  /** Numero sequencial da DPS (seq local emissor) */
  numeroSerie: string; // ex: "00001"
  numeroDps: number;   // ex: 1, 2, 3...
  /** Data e hora de emissao (ISO 8601 com offset) */
  dhEmissao: Date;
  /** Competencia (mes da prestacao) — formato YYYY-MM-DD (dia 1) */
  competencia: string;
  /** Codigo IBGE do municipio de emissao (ex: 4316808 = Santa Cruz do Sul) */
  codigoMunicipioEmissao: string;
  prestador: PrestadorData;
  tomador: TomadorData;
  servico: ServicoData;
}

export interface PrestadorData {
  cnpj: string; // 14 digitos
  inscricaoMunicipal: string;
  razaoSocial: string;
  endereco: EnderecoData;
  email?: string;
  telefone?: string;
  /** 1=Simples Nacional, 2=Lucro Real/Presumido, 3=MEI */
  regimeTributario: 1 | 2 | 3;
}

export interface TomadorData {
  /** "PF" ou "PJ" */
  tipo: "PF" | "PJ";
  documento: string; // CPF (11) ou CNPJ (14)
  razaoSocial: string;
  endereco?: EnderecoData;
  email?: string;
  telefone?: string;
}

export interface EnderecoData {
  logradouro: string;
  numero: string;
  complemento?: string;
  bairro: string;
  /** Codigo IBGE 7 digitos */
  codigoMunicipio: string;
  uf: string; // ex: "RS"
  cep: string; // 8 digitos
}

export interface ServicoData {
  /** Codigo da LC 116/2003 (ex: "10.05") */
  codigoServico: string;
  /** Codigo NBS opcional */
  codigoNbs?: string;
  /** Codigo IBGE do municipio onde foi prestado o servico */
  codigoMunicipioPrestacao: string;
  /** Descricao detalhada (max 2000 chars) */
  discriminacao: string;
  /** Valor bruto do servico em R$ */
  valorServicos: number;
  /** Aliquota ISS em % (ex: 2 para 2%) */
  aliquotaIss: number;
  /** Se ISS eh retido na fonte (raro pra Simples) */
  issRetido: boolean;
  /** Item da LC 116 (ex: "10") - geralmente os 2 primeiros digitos do codigoServico */
  cListServ?: string;
  /** Codigo CNAE de 7 digitos (ex: "6822600") */
  cnae?: string;
}

/**
 * Constroi o XML da DPS para envio. NAO inclui assinatura — eh feita
 * separadamente por nfse-xades-signer.ts.
 *
 * Retorna o XML como string, pronto pra ser assinado.
 */
export function buildDpsXml(params: DpsParams): { xml: string; idDps: string } {
  const { prestador, tomador, servico } = params;

  // ID unico da DPS (formato: "DPS-{cnpj}-{serie}-{numero}-{timestamp}")
  // Maximo 50 chars, comeca com letra, sem espacos
  const idDps = `DPS${prestador.cnpj}${params.numeroSerie}${String(params.numeroDps).padStart(15, "0")}`.substring(0, 50);

  const tpAmb = params.ambiente === "PRODUCAO" ? "1" : "2";
  const dhEmi = formatDateIso(params.dhEmissao);
  const dCompet = params.competencia.split("T")[0];

  // Aliquota como decimal (5% = 0.0500)
  const aliquotaDecimal = (servico.aliquotaIss / 100).toFixed(4);
  const valorIss = servico.issRetido
    ? Math.round(servico.valorServicos * (servico.aliquotaIss / 100) * 100) / 100
    : 0;

  const cLocEmi = onlyDigits(params.codigoMunicipioEmissao);
  const cnaeServ = servico.cnae ? onlyDigits(servico.cnae) : "";

  // Itens da LC 116 (cListServ): formato "XX.XX" → codigo de 4 digitos sem ponto
  const cListServ = (servico.cListServ || servico.codigoServico).replace(/\D/g, "").padStart(4, "0").substring(0, 4);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">
  <infDPS Id="${escapeXml(idDps)}">
    <tpAmb>${tpAmb}</tpAmb>
    <dhEmi>${dhEmi}</dhEmi>
    <verAplic>1.00</verAplic>
    <serie>${escapeXml(params.numeroSerie)}</serie>
    <nDPS>${params.numeroDps}</nDPS>
    <dCompet>${dCompet}</dCompet>
    <tpEmit>1</tpEmit>
    <cLocEmi>${cLocEmi}</cLocEmi>
    <subst>0</subst>
    <prest>
      <CNPJ>${onlyDigits(prestador.cnpj)}</CNPJ>
      <IM>${escapeXml(prestador.inscricaoMunicipal)}</IM>
      <xNome>${escapeXml(prestador.razaoSocial)}</xNome>
      <enderNac>
        <xLgr>${escapeXml(prestador.endereco.logradouro)}</xLgr>
        <nro>${escapeXml(prestador.endereco.numero)}</nro>
        ${prestador.endereco.complemento ? `<xCpl>${escapeXml(prestador.endereco.complemento)}</xCpl>` : ""}
        <xBairro>${escapeXml(prestador.endereco.bairro)}</xBairro>
        <cMun>${onlyDigits(prestador.endereco.codigoMunicipio)}</cMun>
        <UF>${escapeXml(prestador.endereco.uf)}</UF>
        <CEP>${onlyDigits(prestador.endereco.cep)}</CEP>
      </enderNac>
      ${prestador.email ? `<email>${escapeXml(prestador.email)}</email>` : ""}
      ${prestador.telefone ? `<fone>${onlyDigits(prestador.telefone)}</fone>` : ""}
      <regTrib>
        <opSimpNac>${prestador.regimeTributario === 1 ? "1" : "2"}</opSimpNac>
        <regApTribSN>1</regApTribSN>
      </regTrib>
    </prest>
    <toma>
      ${tomador.tipo === "PF"
        ? `<CPF>${onlyDigits(tomador.documento)}</CPF>`
        : `<CNPJ>${onlyDigits(tomador.documento)}</CNPJ>`}
      <xNome>${escapeXml(tomador.razaoSocial)}</xNome>
      ${tomador.endereco ? `<enderNac>
        <xLgr>${escapeXml(tomador.endereco.logradouro)}</xLgr>
        <nro>${escapeXml(tomador.endereco.numero)}</nro>
        ${tomador.endereco.complemento ? `<xCpl>${escapeXml(tomador.endereco.complemento)}</xCpl>` : ""}
        <xBairro>${escapeXml(tomador.endereco.bairro)}</xBairro>
        <cMun>${onlyDigits(tomador.endereco.codigoMunicipio)}</cMun>
        <UF>${escapeXml(tomador.endereco.uf)}</UF>
        <CEP>${onlyDigits(tomador.endereco.cep)}</CEP>
      </enderNac>` : ""}
      ${tomador.email ? `<email>${escapeXml(tomador.email)}</email>` : ""}
      ${tomador.telefone ? `<fone>${onlyDigits(tomador.telefone)}</fone>` : ""}
    </toma>
    <serv>
      <locPrest>
        <cLocPrestacao>${onlyDigits(servico.codigoMunicipioPrestacao)}</cLocPrestacao>
      </locPrest>
      <cServ>
        <cTribNac>${escapeXml(servico.codigoServico)}</cTribNac>
        ${servico.codigoNbs ? `<cNBS>${escapeXml(servico.codigoNbs)}</cNBS>` : ""}
        <cIntContrib>${escapeXml(servico.codigoServico.replace(/\D/g, ""))}</cIntContrib>
        ${cnaeServ ? `<CNAE>${cnaeServ}</CNAE>` : ""}
        <cListServ>${cListServ}</cListServ>
        <xDescServ>${escapeXml(servico.discriminacao.substring(0, 2000))}</xDescServ>
      </cServ>
    </serv>
    <valores>
      <vServPrest>
        <vServ>${formatNumber(servico.valorServicos)}</vServ>
      </vServPrest>
      <trib>
        <tribMun>
          <tribISSQN>${servico.issRetido ? "1" : "2"}</tribISSQN>
          <pAliq>${aliquotaDecimal}</pAliq>
          <tpRetISSQN>${servico.issRetido ? "1" : "2"}</tpRetISSQN>
        </tribMun>
        <totTrib>
          <totTribCalc>
            <vTotTrib>${formatNumber(valorIss)}</vTotTrib>
            <vTotTribFed>0.00</vTotTribFed>
            <vTotTribEst>0.00</vTotTribEst>
            <vTotTribMun>${formatNumber(valorIss)}</vTotTribMun>
          </totTribCalc>
        </totTrib>
      </trib>
    </valores>
  </infDPS>
</DPS>`;

  return { xml: xml.trim(), idDps };
}

/** Formata data como ISO 8601 com offset de Brasilia (-03:00) */
function formatDateIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}-03:00`
  );
}

function onlyDigits(s: string): string {
  return s.replace(/\D/g, "");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatNumber(n: number): string {
  return n.toFixed(2);
}
