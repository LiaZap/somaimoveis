/**
 * Cliente HTTP para Spedy NFe (provedor SaaS de NFS-e).
 *
 * Documentação: https://api.spedy.com.br/llms.txt
 *
 * Endpoints:
 *   Producao:    https://api.spedy.com.br/v1
 *   Homologacao: https://sandbox-api.spedy.com.br/v1
 *
 * Autenticacao: Header `X-Api-Key: <chave>`
 *
 * Operacoes principais:
 *   POST   /service-invoices        — emitir NFS-e
 *   GET    /service-invoices/{id}   — consultar status
 *   GET    /service-invoices/{id}/xml — baixar XML (sem auth)
 *   GET    /service-invoices/{id}/pdf — baixar PDF (sem auth)
 *   DELETE /service-invoices/{id}   — cancelar (com justification)
 *   POST   /service-invoices/{id}/check-status — forcar refresh de status
 *
 * Fluxo: emissao e assincrona. Status inicial `enqueued`, depois transita
 * para `processing` -> `authorized` | `rejected` | `denied`. Recomenda-se
 * webhook ou polling (5-10s) ate estado final.
 */

export type SpedyAmbiente = "HOMOLOGACAO" | "PRODUCAO";

const ENDPOINT = {
  HOMOLOGACAO: "https://sandbox-api.spedy.com.br/v1",
  PRODUCAO: "https://api.spedy.com.br/v1",
} as const;

export interface SpedyEnderecoTomador {
  street: string;
  number: string;
  complement?: string;
  district: string;
  city: { code: string; name: string; state: string };
  postalCode?: string;
}

export interface SpedyTomadorData {
  name: string;
  federalTaxNumber: string; // CPF ou CNPJ (so digitos)
  email?: string;
  address?: SpedyEnderecoTomador;
}

export interface SpedyTotalData {
  invoiceAmount: number;
  issRate?: number; // decimal: 0.05 = 5%
  issAmount?: number;
  issWithheld?: boolean;
  // Outras retencoes (opcionais)
  pisAmount?: number;
  cofinsAmount?: number;
  inssAmount?: number;
  irAmount?: number;
  csllAmount?: number;
  unconditionalDiscountAmount?: number;
}

export interface SpedyServiceInvoiceBody {
  effectiveDate: string; // ISO YYYY-MM-DDTHH:mm:ss
  status?: "enqueued"; // sempre enqueued na criacao
  sendEmailToCustomer?: boolean;
  description: string;
  federalServiceCode: string;
  cityServiceCode?: string;
  taxationType?: string; // "taxationInMunicipality" etc
  receiver: SpedyTomadorData;
  total: SpedyTotalData;
  integrationId?: string; // idempotencia (max 36 chars)
  additionalInformation?: string;
}

export interface SpedyServiceInvoiceResponse {
  id: string;
  status: string;
  model?: string;
  number?: number | null;
  rps?: { number: number; series: string };
  amount?: number;
  issuedOn?: string;
  authorization?: { date: string; protocol: string };
  processingDetail?: { status: string; message: string | null; code: string | null };
  // pdf/xml URLs costumam vir aqui em alguns casos
  pdf?: string;
  xml?: string;
}

export interface SpedyEmitParams {
  ambiente: SpedyAmbiente;
  apiKey: string;
  body: SpedyServiceInvoiceBody;
}

export interface SpedyApiError {
  status: number;
  message: string;
  body?: unknown;
}

function baseUrl(ambiente: SpedyAmbiente): string {
  return ENDPOINT[ambiente];
}

async function spedyFetch(
  url: string,
  init: RequestInit & { apiKey?: string }
): Promise<Response> {
  const { apiKey, headers, ...rest } = init;
  const finalHeaders: Record<string, string> = {
    Accept: "application/json",
    ...(headers as Record<string, string> | undefined),
  };
  if (apiKey) finalHeaders["X-Api-Key"] = apiKey;
  return fetch(url, { ...rest, headers: finalHeaders });
}

/**
 * Emite uma NFS-e via Spedy. Retorna o objeto criado (geralmente com
 * status `enqueued` ou `processing` — usar consultar() pra acompanhar).
 */
export async function emitirNFSeSpedy(
  params: SpedyEmitParams
): Promise<SpedyServiceInvoiceResponse> {
  const url = `${baseUrl(params.ambiente)}/service-invoices`;
  const res = await spedyFetch(url, {
    method: "POST",
    apiKey: params.apiKey,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params.body),
  });

  if (!res.ok) {
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* ignore */ }
    throw {
      status: res.status,
      message: `Spedy emit falhou: HTTP ${res.status}`,
      body,
    } satisfies SpedyApiError;
  }
  return (await res.json()) as SpedyServiceInvoiceResponse;
}

/**
 * Consulta uma NFS-e pelo ID retornado na emissao.
 */
export async function consultarNFSeSpedy(
  ambiente: SpedyAmbiente,
  apiKey: string,
  id: string
): Promise<SpedyServiceInvoiceResponse> {
  const url = `${baseUrl(ambiente)}/service-invoices/${encodeURIComponent(id)}`;
  const res = await spedyFetch(url, { method: "GET", apiKey });
  if (!res.ok) {
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* ignore */ }
    throw {
      status: res.status,
      message: `Spedy consultar falhou: HTTP ${res.status}`,
      body,
    } satisfies SpedyApiError;
  }
  return (await res.json()) as SpedyServiceInvoiceResponse;
}

/**
 * Forca atualizacao de status consultando a prefeitura.
 */
export async function checkStatusSpedy(
  ambiente: SpedyAmbiente,
  apiKey: string,
  id: string
): Promise<SpedyServiceInvoiceResponse> {
  const url = `${baseUrl(ambiente)}/service-invoices/${encodeURIComponent(id)}/check-status`;
  const res = await spedyFetch(url, { method: "POST", apiKey });
  if (!res.ok) {
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* ignore */ }
    throw {
      status: res.status,
      message: `Spedy check-status falhou: HTTP ${res.status}`,
      body,
    } satisfies SpedyApiError;
  }
  return (await res.json()) as SpedyServiceInvoiceResponse;
}

/**
 * Cancela uma NFS-e (depende da prefeitura aceitar).
 */
export async function cancelarNFSeSpedy(
  ambiente: SpedyAmbiente,
  apiKey: string,
  id: string,
  justification: string
): Promise<SpedyServiceInvoiceResponse> {
  const url = `${baseUrl(ambiente)}/service-invoices/${encodeURIComponent(id)}`;
  const res = await spedyFetch(url, {
    method: "DELETE",
    apiKey,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ justification }),
  });
  if (!res.ok) {
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* ignore */ }
    throw {
      status: res.status,
      message: `Spedy cancelar falhou: HTTP ${res.status}`,
      body,
    } satisfies SpedyApiError;
  }
  return (await res.json()) as SpedyServiceInvoiceResponse;
}

/**
 * Baixa o XML da NFS-e (autenticacao nao requerida segundo docs).
 */
export async function baixarXmlSpedy(
  ambiente: SpedyAmbiente,
  id: string
): Promise<Buffer> {
  const url = `${baseUrl(ambiente)}/service-invoices/${encodeURIComponent(id)}/xml`;
  const res = await fetch(url, { headers: { Accept: "application/xml" } });
  if (!res.ok) {
    throw { status: res.status, message: `Spedy XML falhou: HTTP ${res.status}` } satisfies SpedyApiError;
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Baixa o PDF da NFS-e (autenticacao nao requerida segundo docs).
 */
export async function baixarPdfSpedy(
  ambiente: SpedyAmbiente,
  id: string
): Promise<Buffer> {
  const url = `${baseUrl(ambiente)}/service-invoices/${encodeURIComponent(id)}/pdf`;
  const res = await fetch(url, { headers: { Accept: "application/pdf" } });
  if (!res.ok) {
    throw { status: res.status, message: `Spedy PDF falhou: HTTP ${res.status}` } satisfies SpedyApiError;
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Helper: aguarda a NFS-e sair do estado `enqueued`/`processing` ate
 * `authorized`/`rejected`/`denied`/`canceled`, com timeout.
 *
 * Polling padrao: 6s, ate maxTries (default 10) = 60s total.
 */
export async function aguardarProcessamentoSpedy(
  ambiente: SpedyAmbiente,
  apiKey: string,
  id: string,
  opts: { maxTries?: number; intervalMs?: number } = {}
): Promise<SpedyServiceInvoiceResponse> {
  const maxTries = opts.maxTries ?? 10;
  const interval = opts.intervalMs ?? 6000;
  let last: SpedyServiceInvoiceResponse | null = null;
  for (let i = 0; i < maxTries; i++) {
    const nf = await consultarNFSeSpedy(ambiente, apiKey, id);
    last = nf;
    const s = (nf.status || "").toLowerCase();
    if (s === "authorized" || s === "rejected" || s === "denied" || s === "canceled") {
      return nf;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  if (last) return last;
  throw { status: 408, message: `Spedy: timeout aguardando processamento da NFS-e ${id}` } satisfies SpedyApiError;
}
