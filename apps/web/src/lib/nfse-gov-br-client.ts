/**
 * Cliente HTTP para NFS-e Padrão Nacional (gov.br).
 *
 * Documentação:
 *   https://www.gov.br/nfse/pt-br
 *   https://www.gov.br/nfse/pt-br/centrais-de-conteudo/manuais-1
 *
 * Endpoints:
 *   Homologação: https://sefin.producaorestrita.nfse.gov.br/SefinNacional
 *   Produção:    https://sefin.nfse.gov.br/SefinNacional
 *
 * Autenticação: mTLS com certificado A1 da empresa emissora.
 *
 * Operacoes principais:
 *   POST /nfse        — envia DPS assinada, recebe NFS-e ou erro
 *   GET  /nfse/{chave} — consulta NFS-e por chave de acesso
 *   POST /eventos     — cancelamento, substituicao
 */
import https from "https";
import zlib from "zlib";
import { extractPfx } from "./nfse-pfx";
import { buildDpsXml, type PrestadorData, type TomadorData, type ServicoData } from "./nfse-dps-builder";
import { signDps } from "./nfse-xades-signer";

export type Ambiente = "HOMOLOGACAO" | "PRODUCAO";

const ENDPOINT = {
  HOMOLOGACAO: "https://sefin.producaorestrita.nfse.gov.br/SefinNacional",
  PRODUCAO: "https://sefin.nfse.gov.br/SefinNacional",
} as const;

export interface EmitirNFSeParams {
  ambiente: Ambiente;
  certificado: {
    pfx: Buffer;        // raw PFX bytes
    password: string;   // senha em claro
  };
  prestador: {
    cnpj: string;
    inscricaoMunicipal: string;
    razaoSocial: string;
    endereco: {
      logradouro: string;
      numero: string;
      complemento?: string;
      bairro: string;
      cidade: string;
      uf: string;
      cep: string;
    };
    email?: string;
    telefone?: string;
    regimeTributario: "SIMPLES_NACIONAL" | "LUCRO_PRESUMIDO" | "LUCRO_REAL" | "MEI";
    /** Aliquota efetiva do Simples Nacional do mes (ex: 6 = 6%). */
    simplesAliquota?: number;
  };
  tomador: {
    tipo: "PF" | "PJ";
    documento: string;
    nome: string;
    email?: string;
    endereco?: {
      logradouro: string;
      numero: string;
      complemento?: string;
      bairro: string;
      cidade: string;
      uf: string;
      cep: string;
    };
  };
  servico: {
    codigoServico: string;
    discriminacao: string;
    valorServicos: number;
    aliquotaIss: number;
    issRetido: boolean;
    municipioPrestacao: string;
  };
  numeroSerie?: string;  // default "00001"
  numeroDps: number;     // sequencial — DEVE ser incremental e unico
  /** Competencia da nota no formato YYYY-MM (mes/ano de referencia do servico).
   *  Padrao: mes corrente em America/Sao_Paulo. */
  competencia?: string;
}

export interface EmitirNFSeResult {
  sucesso: boolean;
  numero?: string;
  serie?: string;
  codigoVerificacao?: string;
  chaveAcesso?: string;
  pdfUrl?: string;
  xmlRetorno?: string;
  rejeicaoCodigo?: string;
  rejeicaoMotivo?: string;
  ambiente: Ambiente;
  dpsXml?: string;
}

/**
 * Emite uma NFS-e no Padrão Nacional via webservice.
 *
 * Fluxo:
 *  1. Extrai cert + key do PFX
 *  2. Monta o XML DPS no formato Padrao Nacional (emissao completa)
 *  3. Assina com XAdES-Enveloped (RSA-SHA256, C14N exclusiva)
 *  4. Faz POST mTLS no endpoint /nfse
 *  5. Processa retorno (autorizada / rejeitada / processando)
 */
export async function emitirNFSe(params: EmitirNFSeParams): Promise<EmitirNFSeResult> {
  // Modo MOCK pra dev/testes
  if (process.env.NFSE_MOCK === "true") {
    console.log("[NFS-e MOCK]", {
      ambiente: params.ambiente,
      cnpj: params.prestador.cnpj,
      tomador: params.tomador.nome,
      valor: params.servico.valorServicos,
    });
    return {
      sucesso: true,
      numero: `${Math.floor(Math.random() * 100000).toString().padStart(8, "0")}`,
      serie: "1",
      codigoVerificacao: Math.random().toString(36).substring(2, 10).toUpperCase(),
      chaveAcesso: `${params.prestador.cnpj}${Date.now()}`.substring(0, 50),
      ambiente: params.ambiente,
      dpsXml: "<DPS>... (mock) ...</DPS>",
    };
  }

  // 1) Extrai certificado do PFX
  let certData;
  try {
    certData = extractPfx(params.certificado.pfx, params.certificado.password);
  } catch (err: any) {
    return {
      sucesso: false,
      rejeicaoCodigo: "PFX_ERROR",
      rejeicaoMotivo: `Erro ao ler certificado: ${err?.message || err}`,
      ambiente: params.ambiente,
    };
  }

  // 2) Monta XML DPS
  const numeroSerie = params.numeroSerie || "00001";
  const ibgePrestador = params.servico.municipioPrestacao;

  const prestador: PrestadorData = {
    cnpj: params.prestador.cnpj,
    inscricaoMunicipal: params.prestador.inscricaoMunicipal,
    razaoSocial: params.prestador.razaoSocial,
    endereco: {
      logradouro: params.prestador.endereco.logradouro,
      numero: params.prestador.endereco.numero,
      complemento: params.prestador.endereco.complemento,
      bairro: params.prestador.endereco.bairro,
      codigoMunicipio: ibgePrestador,
      uf: params.prestador.endereco.uf,
      cep: params.prestador.endereco.cep,
    },
    email: params.prestador.email,
    telefone: params.prestador.telefone,
    regimeTributario: params.prestador.regimeTributario === "SIMPLES_NACIONAL" ? 1 :
                      params.prestador.regimeTributario === "MEI" ? 3 : 2,
    simplesAliquota: params.prestador.simplesAliquota,
  };

  const tomador: TomadorData = {
    tipo: params.tomador.tipo,
    documento: params.tomador.documento,
    razaoSocial: params.tomador.nome,
    email: params.tomador.email,
    endereco: params.tomador.endereco ? {
      logradouro: params.tomador.endereco.logradouro,
      numero: params.tomador.endereco.numero,
      complemento: params.tomador.endereco.complemento,
      bairro: params.tomador.endereco.bairro,
      codigoMunicipio: ibgePrestador, // simplificacao — idealmente buscaria pelo CEP
      uf: params.tomador.endereco.uf,
      cep: params.tomador.endereco.cep,
    } : undefined,
  };

  const servico: ServicoData = {
    codigoServico: params.servico.codigoServico,
    codigoMunicipioPrestacao: ibgePrestador,
    discriminacao: params.servico.discriminacao,
    valorServicos: params.servico.valorServicos,
    aliquotaIss: params.servico.aliquotaIss,
    issRetido: params.servico.issRetido,
  };

  // Competencia: aceita YYYY-MM (do emit) ou usa primeiro dia do mes atual em BR.
  // dCompet no Padrao Nacional eh AAAA-MM-DD com dia=01 (primeiro dia do mes).
  let competenciaIso: string;
  if (params.competencia && /^\d{4}-\d{2}$/.test(params.competencia)) {
    competenciaIso = `${params.competencia}-01`;
  } else if (params.competencia && /^\d{4}-\d{2}-\d{2}$/.test(params.competencia)) {
    // forca dia=01
    competenciaIso = `${params.competencia.slice(0, 7)}-01`;
  } else {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
    });
    const parts = fmt.formatToParts(now);
    const y = parts.find((p) => p.type === "year")?.value || String(now.getFullYear());
    const m = parts.find((p) => p.type === "month")?.value || String(now.getMonth() + 1).padStart(2, "0");
    competenciaIso = `${y}-${m}-01`;
  }

  const { xml: dpsXml, idDps } = buildDpsXml({
    ambiente: params.ambiente,
    numeroSerie,
    numeroDps: params.numeroDps,
    dhEmissao: new Date(),
    competencia: competenciaIso,
    codigoMunicipioEmissao: ibgePrestador,
    prestador,
    tomador,
    servico,
  });

  // 3) Assina o XML
  let signedXml: string;
  try {
    signedXml = signDps({
      xml: dpsXml,
      idDps,
      privateKeyPem: certData.keyPem,
      certificatePem: certData.certPem,
    });
  } catch (err: any) {
    return {
      sucesso: false,
      rejeicaoCodigo: "SIGN_ERROR",
      rejeicaoMotivo: `Erro ao assinar XML: ${err?.message || err}`,
      ambiente: params.ambiente,
      dpsXml,
    };
  }

  // 4) Envia via mTLS
  // O endpoint Padrao Nacional NAO aceita XML cru — exige JSON com o XML
  // gzipped + base64 no campo dpsXmlGZipB64 (ou similar).
  const baseUrl = ENDPOINT[params.ambiente];
  const gzipped = zlib.gzipSync(Buffer.from(signedXml, "utf8"));
  const dpsB64 = gzipped.toString("base64");
  const requestBody = JSON.stringify({ dpsXmlGZipB64: dpsB64 });

  try {
    const response = await postMtls({
      url: `${baseUrl}/nfse`,
      body: requestBody,
      contentType: "application/json",
      certPem: certData.certPem,
      keyPem: certData.keyPem,
      caPem: certData.caPem,
    });

    // 5) Processa resposta
    const responseText = response.body;
    if (response.statusCode >= 200 && response.statusCode < 300) {
      const parsed = parseSefinResponse(responseText);
      return {
        sucesso: true,
        numero: parsed.numero,
        serie: parsed.serie,
        codigoVerificacao: parsed.codigoVerificacao,
        chaveAcesso: parsed.chaveAcesso,
        xmlRetorno: responseText,
        ambiente: params.ambiente,
        dpsXml: signedXml,
      };
    } else {
      const erro = parseSefinError(responseText, response.statusCode);
      return {
        sucesso: false,
        rejeicaoCodigo: erro.codigo || String(response.statusCode),
        rejeicaoMotivo: erro.motivo || responseText.substring(0, 500),
        xmlRetorno: responseText,
        ambiente: params.ambiente,
        dpsXml: signedXml,
      };
    }
  } catch (err: any) {
    return {
      sucesso: false,
      rejeicaoCodigo: "HTTP_ERROR",
      rejeicaoMotivo: err?.message || String(err),
      ambiente: params.ambiente,
      dpsXml: signedXml,
    };
  }
}

/**
 * Faz POST com autenticacao mTLS usando o certificado A1.
 */
async function postMtls(params: {
  url: string;
  body: string;
  contentType: string;
  certPem: string;
  keyPem: string;
  caPem: string;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(params.url);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        cert: params.certPem,
        key: params.keyPem,
        ca: params.caPem || undefined,
        headers: {
          "Content-Type": params.contentType,
          "Content-Length": Buffer.byteLength(params.body, "utf8"),
        },
        rejectUnauthorized: true,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode || 0, body: data }));
      },
    );
    req.on("error", reject);
    req.write(params.body, "utf8");
    req.end();
  });
}

/**
 * Parser de resposta de sucesso da SEFIN.
 * O retorno pode vir como JSON (envelope) ou XML (NFS-e completa).
 * Tentamos JSON primeiro, fallback pra XML.
 */
function parseSefinResponse(text: string): {
  numero?: string;
  serie?: string;
  codigoVerificacao?: string;
  chaveAcesso?: string;
} {
  // Tenta JSON primeiro
  try {
    const json = JSON.parse(text);
    return {
      numero: json.numeroNFSe || json.numero || json.nNFSe,
      serie: json.serie || json.Serie,
      codigoVerificacao: json.codigoVerificacao || json.cVerifNFSe,
      chaveAcesso: json.chaveAcesso || json.chNFSe,
    };
  } catch {
    // Fallback XML
    return {
      numero: matchTag(text, "nNFSe") || matchTag(text, "NumeroNFSe"),
      serie: matchTag(text, "serie") || matchTag(text, "Serie"),
      codigoVerificacao: matchTag(text, "cVerifNFSe") || matchTag(text, "CodigoVerificacao"),
      chaveAcesso: matchTag(text, "chNFSe") || matchTag(text, "ChaveAcesso"),
    };
  }
}

function parseSefinError(text: string, statusCode: number): { codigo?: string; motivo?: string } {
  // Tenta JSON primeiro (Padrao Nacional retorna JSON em erros)
  try {
    const json = JSON.parse(text);
    const motivo = json.message || json.mensagem || json.detail || json.error;
    const codigo = json.code || json.codigo || String(statusCode);
    if (motivo) return { codigo, motivo };
  } catch {
    // ignore
  }
  // Fallback XML
  const codigo = matchTag(text, "cMsg") || matchTag(text, "codigo") || matchTag(text, "Codigo");
  const motivo = matchTag(text, "xMsg") || matchTag(text, "mensagem") || matchTag(text, "Mensagem");
  return { codigo, motivo };
}

function matchTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<(?:[\\w]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[\\w]+:)?${tag}>`);
  const m = xml.match(re);
  return m?.[1]?.trim() || undefined;
}

export interface ConsultarNFSeParams {
  ambiente: Ambiente;
  certificado: { pfx: Buffer; password: string };
  numero: string;
  cnpjPrestador: string;
}

export async function consultarNFSe(_params: ConsultarNFSeParams): Promise<{
  status: "AUTORIZADA" | "PROCESSANDO" | "REJEITADA" | "CANCELADA" | "NAO_ENCONTRADA";
  pdfUrl?: string;
  xml?: string;
  motivo?: string;
}> {
  // TODO: implementar GET /nfse/{chaveAcesso}
  return { status: "AUTORIZADA" };
}

export interface CancelarNFSeParams {
  ambiente: Ambiente;
  certificado: { pfx: Buffer; password: string };
  numero: string;
  cnpjPrestador: string;
  motivo: string;
}

export async function cancelarNFSe(_params: CancelarNFSeParams): Promise<{
  sucesso: boolean;
  motivo?: string;
}> {
  // TODO: implementar POST /eventos com tipo de evento "cancelamento"
  return { sucesso: true };
}

/**
 * Codigos IBGE para municipios do RS (lista parcial)
 */
export const IBGE_CODES_RS: Record<string, string> = {
  "SANTA CRUZ DO SUL": "4316808",
  "PORTO ALEGRE": "4314902",
  "VENANCIO AIRES": "4322509",
  "CANOAS": "4304606",
  "PELOTAS": "4314407",
  "CAXIAS DO SUL": "4305108",
  "NOVO HAMBURGO": "4313409",
};

// Mapeamento Cidade -> IBGE por UF (capitais e principais cidades de cada
// estado). Necessario quando o TOMADOR esta em outro estado — antes
// mandavamos sempre o IBGE da Somma (SC do Sul/RS) o que disparava E0240.
// Quando cidade nao esta mapeada, retornamos null e omitimos address.
const IBGE_CODES_BR: Record<string, Record<string, string>> = {
  AC: { "RIO BRANCO": "1200401" },
  AL: { "MACEIO": "2704302" },
  AP: { "MACAPA": "1600303" },
  AM: { "MANAUS": "1302603" },
  BA: { "SALVADOR": "2927408", "FEIRA DE SANTANA": "2910800" },
  CE: { "FORTALEZA": "2304400" },
  DF: { "BRASILIA": "5300108" },
  ES: { "VITORIA": "3205309", "VILA VELHA": "3205200", "SERRA": "3205002", "CARIACICA": "3201308" },
  GO: { "GOIANIA": "5208707", "ANAPOLIS": "5201108" },
  MA: { "SAO LUIS": "2111300" },
  MT: { "CUIABA": "5103403", "VARZEA GRANDE": "5108402" },
  MS: { "CAMPO GRANDE": "5002704" },
  MG: {
    "BELO HORIZONTE": "3106200", "UBERLANDIA": "3170206",
    "CONTAGEM": "3118601", "JUIZ DE FORA": "3136702", "BETIM": "3106705",
  },
  PA: { "BELEM": "1501402" },
  PB: { "JOAO PESSOA": "2507507", "CAMPINA GRANDE": "2504009" },
  PR: {
    "CURITIBA": "4106902", "LONDRINA": "4113700", "MARINGA": "4115200",
    "PONTA GROSSA": "4119905", "CASCAVEL": "4104808", "FOZ DO IGUACU": "4108304",
  },
  PE: { "RECIFE": "2611606", "JABOATAO DOS GUARARAPES": "2607901", "OLINDA": "2609600" },
  PI: { "TERESINA": "2211001" },
  RJ: {
    "RIO DE JANEIRO": "3304557", "NITEROI": "3303302",
    "SAO GONCALO": "3304904", "DUQUE DE CAXIAS": "3301702",
    "NOVA IGUACU": "3303500", "CAMPOS DOS GOYTACAZES": "3301009",
    "PETROPOLIS": "3303906", "VOLTA REDONDA": "3306305",
  },
  RN: { "NATAL": "2408102" },
  RS: IBGE_CODES_RS,
  RO: { "PORTO VELHO": "1100205" },
  RR: { "BOA VISTA": "1400100" },
  SC: {
    "FLORIANOPOLIS": "4205407", "JOINVILLE": "4209102", "BLUMENAU": "4202404",
    "CHAPECO": "4204202", "ITAJAI": "4208203", "CRICIUMA": "4204608",
    "LAGES": "4209300", "BALNEARIO CAMBORIU": "4202008", "SAO JOSE": "4216602",
  },
  SP: {
    "SAO PAULO": "3550308", "GUARULHOS": "3518800", "CAMPINAS": "3509502",
    "SAO BERNARDO DO CAMPO": "3548708", "SANTO ANDRE": "3547809",
    "OSASCO": "3534401", "SAO JOSE DOS CAMPOS": "3549904",
    "RIBEIRAO PRETO": "3543402", "SOROCABA": "3552205",
    "SANTOS": "3548500", "MAUA": "3529401", "SAO JOSE DO RIO PRETO": "3549805",
    "MOGI DAS CRUZES": "3530607", "DIADEMA": "3513801", "JUNDIAI": "3525904",
    "PIRACICABA": "3538709", "CARAPICUIBA": "3510609", "BAURU": "3506003",
    "ITAQUAQUECETUBA": "3523107", "SAO VICENTE": "3551009",
    "FRANCA": "3516200", "GUARUJA": "3518701", "TABOAO DA SERRA": "3552502",
  },
  SE: { "ARACAJU": "2800308" },
  TO: { "PALMAS": "1721000" },
};

function normCity(city: string): string {
  return city
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // remove acentos
}

export function getIbgeCode(city: string, state: string): string | null {
  if (!city || !state) return null;
  const uf = state.toUpperCase();
  const key = normCity(city);
  // 1. Tabela do estado especifico
  const stateMap = IBGE_CODES_BR[uf];
  if (stateMap && stateMap[key]) return stateMap[key];
  // 2. Fallback: tabela RS (compat com codigo antigo que so tinha RS)
  if (uf === "RS" && IBGE_CODES_RS[key]) return IBGE_CODES_RS[key];
  return null;
}
