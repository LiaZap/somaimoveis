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

  const tpAmb = params.ambiente === "PRODUCAO" ? "1" : "2";

  // ID da DPS no padrao Sefin Nacional v1.6 (pattern: DPS\d{41}, 44 chars).
  // Estrutura observada em XML real:
  //   DPS + cMun(7) + AAMM(4) + tpInsc(1) + nInsc(14) + serie(5) + nDPS(9) + cDV(1)
  // Total: 3 + 41 = 44 caracteres
  const cMun = onlyDigits(params.codigoMunicipioEmissao).padStart(7, "0").substring(0, 7);
  const dt = params.dhEmissao;
  const aamm = `${String(dt.getFullYear() % 100).padStart(2, "0")}${String(dt.getMonth() + 1).padStart(2, "0")}`;
  const tpInsc = "1"; // CNPJ
  const nInsc = onlyDigits(prestador.cnpj).padStart(14, "0");
  const serieStr = onlyDigits(params.numeroSerie).padStart(5, "0").substring(0, 5);
  const nDPSStr = String(params.numeroDps).padStart(9, "0").substring(0, 9);
  const idPartial = cMun + aamm + tpInsc + nInsc + serieStr + nDPSStr;
  const cDV = calcMod11DV(idPartial);
  const idDps = `DPS${idPartial}${cDV}`;
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

  // Estrutura baseada em XML real funcionando do Padrao Nacional v1.01.
  // Prestador minimal (so CNPJ + regTrib). Tomador com estrutura aninhada
  // <end><endNac>...</endNac><xLgr>... </end>. Servico simplificado.
  const codigoServicoNacional = mapearCodigoServicoNacional(servico.codigoServico);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">
  <infDPS Id="${escapeXml(idDps)}">
    <tpAmb>${tpAmb}</tpAmb>
    <dhEmi>${dhEmi}</dhEmi>
    <verAplic>SommaImoveis_1.0</verAplic>
    <serie>${escapeXml(serieStr)}</serie>
    <nDPS>${params.numeroDps}</nDPS>
    <dCompet>${dCompet}</dCompet>
    <tpEmit>1</tpEmit>
    <cLocEmi>${cLocEmi}</cLocEmi>
    <prest>
      <CNPJ>${onlyDigits(prestador.cnpj)}</CNPJ>
      <regTrib>
        <opSimpNac>${prestador.regimeTributario === 1 ? "1" : "2"}</opSimpNac>
        <regEspTrib>0</regEspTrib>
      </regTrib>
    </prest>
    <toma>
      ${tomador.tipo === "PF"
        ? `<CPF>${onlyDigits(tomador.documento)}</CPF>`
        : `<CNPJ>${onlyDigits(tomador.documento)}</CNPJ>`}
      <xNome>${escapeXml(tomador.razaoSocial)}</xNome>
      ${tomador.endereco ? `<end>
        <endNac>
          <cMun>${onlyDigits(tomador.endereco.codigoMunicipio)}</cMun>
          <CEP>${onlyDigits(tomador.endereco.cep)}</CEP>
        </endNac>
        <xLgr>${escapeXml(tomador.endereco.logradouro)}</xLgr>
        <nro>${escapeXml(tomador.endereco.numero)}</nro>
        ${tomador.endereco.complemento ? `<xCpl>${escapeXml(tomador.endereco.complemento)}</xCpl>` : ""}
        <xBairro>${escapeXml(tomador.endereco.bairro)}</xBairro>
      </end>` : ""}
    </toma>
    <serv>
      <locPrest>
        <cLocPrestacao>${onlyDigits(servico.codigoMunicipioPrestacao)}</cLocPrestacao>
      </locPrest>
      <cServ>
        <cTribNac>${codigoServicoNacional}</cTribNac>
        <xDescServ>${escapeXml(servico.discriminacao.substring(0, 2000))}</xDescServ>
      </cServ>
    </serv>
    <valores>
      <vServPrest>
        <vServ>${formatNumber(servico.valorServicos)}</vServ>
      </vServPrest>
      <trib>
        <tribMun>
          <tribISSQN>1</tribISSQN>
          <tpRetISSQN>${servico.issRetido ? "1" : "2"}</tpRetISSQN>
        </tribMun>
        <totTrib>
          <indTotTrib>0</indTotTrib>
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

/**
 * Mapeia codigo de servico municipal (LC 116) para o cTribNac do Padrao
 * Nacional (6 digitos). Codigos sao baseados na tabela oficial do Padrao
 * Nacional (anexo II do MOC).
 *
 * Para "10.05" (Agenciamento, corretagem ou intermediacao): "100501"
 * Para "17.13" (Administracao de bens): "171301"
 * Para outros: tenta gerar a partir do formato XX.XX → XXXX01.
 */
function mapearCodigoServicoNacional(codigoServico: string): string {
  const map: Record<string, string> = {
    "10.05": "100501",
    "10.5": "100501",
    "1005": "100501",
    "17.13": "171301",
    "1713": "171301",
    "17.05": "170501",
    "1705": "170501",
  };
  if (map[codigoServico]) return map[codigoServico];
  // Fallback: extrai digitos e completa pra 6
  const digits = codigoServico.replace(/\D/g, "");
  if (digits.length === 4) return digits + "01";
  return digits.padEnd(6, "0").substring(0, 6);
}

/**
 * Calcula o digito verificador modulo 11 (padrao Receita Federal)
 * para a chave de acesso da DPS. Pesos 2-9 ciclicos da direita pra esquerda.
 * Resultado: '0' se DV = 10 ou 11, senao o digito calculado.
 */
function calcMod11DV(s: string): string {
  const digits = s.replace(/\D/g, "");
  const weights = [2, 3, 4, 5, 6, 7, 8, 9];
  let sum = 0;
  let widx = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += parseInt(digits[i], 10) * weights[widx];
    widx = (widx + 1) % weights.length;
  }
  const remainder = sum % 11;
  const dv = 11 - remainder;
  return dv >= 10 ? "0" : String(dv);
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
