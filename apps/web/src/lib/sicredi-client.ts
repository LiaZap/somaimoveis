// ==================================================
// Cliente API Sicredi - Cobranca / Boletos
// https://developers.sicredi.com.br
// ==================================================

const SICREDI_API_URL = process.env.SICREDI_API_URL || "https://api-parceiro.sicredi.com.br";
const SICREDI_API_KEY = process.env.SICREDI_API_KEY;
const SICREDI_USERNAME = process.env.SICREDI_USERNAME;
const SICREDI_PASSWORD = process.env.SICREDI_PASSWORD;
const SICREDI_COOPERATIVA = process.env.SICREDI_COOPERATIVA;
const SICREDI_POSTO = process.env.SICREDI_POSTO;
const SICREDI_BENEFICIARIO = process.env.SICREDI_BENEFICIARIO;
const SICREDI_SANDBOX = process.env.SICREDI_SANDBOX === "true";

// Prefixo de sandbox para URLs
const PATH_PREFIX = SICREDI_SANDBOX ? "/sb" : "";

// Cache de token em memoria
let cachedToken: string | null = null;
let tokenExpiresAt = 0;
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutos

// ---- Tipos ----

export interface CreateBoletoParams {
  beneficiarioFinal: {
    cep: string;
    cidade: string;
    documento: string; // CPF/CNPJ
    logradouro: string;
    nome: string;
    tipoPessoa: "PESSOA_FISICA" | "PESSOA_JURIDICA";
    uf: string;
  };
  pagador: {
    cep: string;
    cidade: string;
    documento: string;
    nome: string;
    tipoPessoa: "PESSOA_FISICA" | "PESSOA_JURIDICA";
    endereco: string;
    uf: string;
  };
  valor: number;
  dataVencimento: string; // YYYY-MM-DD
  tipoCobranca?: "NORMAL" | "HIBRIDO";
  seuNumero?: string;
  especieDocumento?: string;
  informativos?: string[];
  mensagens?: string[];
  // Multa e juros apos vencimento
  multa?: {
    tipo: "VALOR" | "PERCENTUAL"; // Valor fixo R$ ou % sobre o valor
    valor: number;
    data?: string; // YYYY-MM-DD - data inicial de cobranca da multa (default: D+1 do venc)
  };
  juros?: {
    tipo: "VALOR_DIA" | "PERCENTUAL_DIA" | "PERCENTUAL_MES" | "ISENTO";
    valor: number;
    data?: string; // YYYY-MM-DD - data inicial dos juros (default: D+1 do venc)
  };
  // Validade do PIX cobv apos vencimento (dias)
  // Por padrao Sicredi expira no vencimento; setar > 0 mantem PIX valido
  validadeAposVencimento?: number;
}

export interface CreateBoletoResult {
  nossoNumero: string;
  linhaDigitavel: string;
  codigoBarras: string;
  pixCopiaECola?: string;
  success: boolean;
  error?: string;
}

// ---- Helpers ----

/**
 * Verifica se a integracao Sicredi esta configurada
 */
export function isSicrediConfigured(): boolean {
  return !!(
    SICREDI_API_KEY &&
    SICREDI_USERNAME &&
    SICREDI_PASSWORD &&
    SICREDI_COOPERATIVA &&
    SICREDI_POSTO &&
    SICREDI_BENEFICIARIO
  );
}

/**
 * Headers comuns para chamadas autenticadas
 */
function commonHeaders(token: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${token}`,
    "x-api-key": SICREDI_API_KEY!,
    "Content-Type": "application/json",
    "cooperativa": SICREDI_COOPERATIVA!,
    "posto": SICREDI_POSTO!,
  };
}

/**
 * Faz fetch com retry automatico em caso de 401 (token expirado)
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit
): Promise<Response> {
  let response = await fetch(url, options);

  if (response.status === 401) {
    console.log("[Sicredi] Token expirado, renovando...");
    cachedToken = null;
    tokenExpiresAt = 0;
    const newToken = await sicrediAuth();

    // Atualiza headers com novo token
    const headers = options.headers as Record<string, string>;
    headers["Authorization"] = `Bearer ${newToken}`;

    response = await fetch(url, { ...options, headers });
  }

  return response;
}

// ---- Autenticacao ----

/**
 * Autentica na API Sicredi e retorna Bearer token.
 * Usa cache em memoria com TTL de 5 minutos.
 */
export async function sicrediAuth(): Promise<string> {
  // Retorna token em cache se ainda valido
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  // Mock se nao configurado
  if (!isSicrediConfigured()) {
    console.log("[Sicredi Mock] Auth - retornando token mock");
    cachedToken = `mock-token-${Date.now()}`;
    tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    return cachedToken;
  }

  const url = `${SICREDI_API_URL}${PATH_PREFIX}/auth/openapi/token`;

  console.log(`[Sicredi] Autenticando em ${url}...`);

  try {
    const body = new URLSearchParams({
      username: SICREDI_USERNAME!,
      password: SICREDI_PASSWORD!,
      scope: "cobranca",
      grant_type: "password",
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": SICREDI_API_KEY!,
        "context": "COBRANCA",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await response.text();
      console.error(`[Sicredi] Resposta nao-JSON na auth (${response.status}):`, text.slice(0, 200));
      throw new Error(
        `Sicredi retornou resposta invalida (${response.status}). Verifique as credenciais (API Key, Username, Password).`
      );
    }

    const data = await response.json();

    if (!response.ok) {
      console.error(`[Sicredi] Erro auth ${response.status}:`, data);
      throw new Error(
        data?.message || data?.error || `Erro HTTP ${response.status}`
      );
    }

    console.log("[Sicredi] Autenticacao bem-sucedida");
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    return cachedToken!;
  } catch (error) {
    const errMsg =
      error instanceof Error ? error.message : "Erro desconhecido na auth";
    console.error(`[Sicredi] Falha na autenticacao:`, errMsg);
    throw new Error(`Sicredi auth falhou: ${errMsg}`);
  }
}

// ---- Boletos ----

/**
 * Cria um boleto na API Sicredi
 */
export async function sicrediCreateBoleto(
  params: CreateBoletoParams
): Promise<CreateBoletoResult> {
  // Mock se nao configurado
  if (!isSicrediConfigured()) {
    const mockNN = `${Date.now()}`.slice(-10);
    console.log(
      `[Sicredi Mock] Criando boleto - Pagador: ${params.pagador.nome}, Valor: ${params.valor}, Venc: ${params.dataVencimento}`
    );
    return {
      nossoNumero: mockNN,
      linhaDigitavel: `74891.11111 11111.111111 11111.111111 1 ${mockNN}`,
      codigoBarras: `74891${mockNN}00000000${Math.floor(params.valor * 100)}`,
      success: true,
    };
  }

  const token = await sicrediAuth();
  const url = `${SICREDI_API_URL}${PATH_PREFIX}/cobranca/boleto/v1/boletos`;

  // Mapeia multa/juros para o formato do Sicredi
  // Doc: tipo de multa: "VALOR" (R$) ou "PERCENTUAL" (% sobre valor do boleto)
  // Doc: tipo de juros: "VALOR_DIA" (R$/dia), "PERCENTUAL_DIA" (%/dia),
  //                     "PERCENTUAL_MES" (%/mes), "ISENTO" (sem juros)
  const body: Record<string, unknown> = {
    codigoBeneficiario: SICREDI_BENEFICIARIO,
    tipoCobranca: params.tipoCobranca || "HIBRIDO",
    especieDocumento: params.especieDocumento || "DUPLICATA_MERCANTIL_INDICACAO",
    valor: params.valor,
    dataVencimento: params.dataVencimento,
    pagador: params.pagador,
    beneficiarioFinal: params.beneficiarioFinal,
    ...(params.seuNumero && { seuNumero: params.seuNumero }),
    ...(params.informativos && { informativos: params.informativos }),
    ...(params.mensagens && { mensagens: params.mensagens }),
  };

  // Multa apos vencimento
  // Sicredi rejeita multa PERCENTUAL > 2% (limite legal CDC art. 52 §1).
  // Se config interna eh maior, cap em 2% pra o boleto sair, e a
  // diferenca tem que ser cobrada por outro canal.
  if (params.multa && params.multa.valor > 0) {
    let multaValor = params.multa.valor;
    if (params.multa.tipo === "PERCENTUAL" && multaValor > 2) {
      console.warn(
        `[Sicredi] Multa ${multaValor}% acima do limite de 2% — capando em 2%. ` +
        `Diferenca precisa ser cobrada manualmente.`
      );
      multaValor = 2;
    }
    body.multa = {
      tipo: params.multa.tipo, // "VALOR" | "PERCENTUAL"
      valor: multaValor,
      ...(params.multa.data && { data: params.multa.data }),
    };
  }

  // Juros apos vencimento
  // Sicredi tipicamente aceita juros PERCENTUAL_MES <= 1% (= 12% ano)
  if (params.juros && params.juros.valor > 0) {
    body.juros = {
      tipo: params.juros.tipo,
      valor: params.juros.valor,
      ...(params.juros.data && { data: params.juros.data }),
    };
  }

  // Validade pos-vencimento do PIX cobv (dias que o pagamento ainda eh aceito)
  if (typeof params.validadeAposVencimento === "number" && params.validadeAposVencimento > 0) {
    body.validadeAposVencimento = params.validadeAposVencimento;
  }

  console.log(`[Sicredi] Criando boleto:`, JSON.stringify(body, null, 2));

  try {
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: commonHeaders(token),
      body: JSON.stringify(body),
    });

    const responseContentType = response.headers.get("content-type") || "";
    if (!responseContentType.includes("application/json")) {
      const text = await response.text();
      console.error(`[Sicredi] Resposta nao-JSON ao criar boleto (${response.status}):`, text.slice(0, 500));
      return {
        nossoNumero: "",
        linhaDigitavel: "",
        codigoBarras: "",
        success: false,
        error: `Sicredi indisponível (${response.status}). Tente novamente em alguns minutos.`,
      };
    }

    const data = await response.json();

    if (!response.ok) {
      console.error(
        `[Sicredi] Erro ao criar boleto ${response.status}:`,
        JSON.stringify(data, null, 2),
      );
      // Tentar extrair mensagens detalhadas que o Sicredi as vezes manda
      // em arrays: { errors: [{ field, message }] } ou { violations: [...] }
      const detalhes: string[] = [];
      const arr = (data as any)?.errors || (data as any)?.violations || [];
      if (Array.isArray(arr)) {
        for (const e of arr) {
          if (e?.field && e?.message) detalhes.push(`${e.field}: ${e.message}`);
          else if (typeof e === "string") detalhes.push(e);
        }
      }
      const errorMsg =
        (detalhes.length > 0 ? detalhes.join("; ") : null) ||
        (data as any)?.message ||
        (data as any)?.error ||
        `Erro HTTP ${response.status}`;
      return {
        nossoNumero: "",
        linhaDigitavel: "",
        codigoBarras: "",
        success: false,
        error: errorMsg,
      };
    }

    console.log("[Sicredi] Boleto criado com sucesso:", JSON.stringify(data));
    return {
      nossoNumero: data.nossoNumero || "",
      linhaDigitavel: data.linhaDigitavel || "",
      codigoBarras: data.codigoBarras || "",
      pixCopiaECola: data.qrCode || data.pixCopiaECola || data.txId || "",
      success: true,
    };
  } catch (error) {
    const errMsg =
      error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`[Sicredi] Falha ao criar boleto:`, errMsg);
    return {
      nossoNumero: "",
      linhaDigitavel: "",
      codigoBarras: "",
      success: false,
      error: errMsg,
    };
  }
}

/**
 * Consulta um boleto pelo nossoNumero
 */
export async function sicrediQueryBoleto(nossoNumero: string): Promise<any> {
  // Mock se nao configurado
  if (!isSicrediConfigured()) {
    console.log(`[Sicredi Mock] Consultando boleto ${nossoNumero}`);
    return {
      nossoNumero,
      situacao: "EM_ABERTO",
      valor: 1500.0,
      dataVencimento: "2026-04-01",
      success: true,
    };
  }

  const token = await sicrediAuth();
  const url = `${SICREDI_API_URL}${PATH_PREFIX}/cobranca/boleto/v1/boletos?codigoBeneficiario=${SICREDI_BENEFICIARIO}&nossoNumero=${nossoNumero}`;

  console.log(`[Sicredi] Consultando boleto ${nossoNumero}...`);

  try {
    const response = await fetchWithRetry(url, {
      method: "GET",
      headers: commonHeaders(token),
    });

    const queryContentType = response.headers.get("content-type") || "";
    if (!queryContentType.includes("application/json")) {
      const text = await response.text();
      console.error(`[Sicredi] Resposta nao-JSON ao consultar boleto (${response.status}):`, text.slice(0, 200));
      return {
        success: false,
        error: `Sicredi retornou resposta invalida (${response.status}). Verifique as credenciais.`,
      };
    }

    const data = await response.json();

    if (!response.ok) {
      console.error(
        `[Sicredi] Erro ao consultar boleto ${response.status}:`,
        data
      );
      return {
        success: false,
        error: data?.message || data?.error || `Erro HTTP ${response.status}`,
      };
    }

    console.log(`[Sicredi] Boleto ${nossoNumero}:`, data);
    return { ...data, success: true };
  } catch (error) {
    const errMsg =
      error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`[Sicredi] Falha ao consultar boleto:`, errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Imprime (baixa PDF) de um boleto pela linhaDigitavel
 * Retorna o PDF como Buffer
 */
export async function sicrediPrintBoleto(
  linhaDigitavel: string
): Promise<Buffer> {
  // Mock se nao configurado
  if (!isSicrediConfigured()) {
    console.log(`[Sicredi Mock] Imprimindo boleto ${linhaDigitavel}`);
    return Buffer.from("PDF_MOCK_CONTENT");
  }

  const token = await sicrediAuth();
  const encoded = encodeURIComponent(linhaDigitavel);
  const url = `${SICREDI_API_URL}${PATH_PREFIX}/cobranca/boleto/v1/boletos/pdf?linhaDigitavel=${encoded}`;

  console.log(`[Sicredi] Baixando PDF do boleto...`);

  try {
    const response = await fetchWithRetry(url, {
      method: "GET",
      headers: {
        ...commonHeaders(token),
        "Accept": "application/pdf",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[Sicredi] Erro ao baixar PDF ${response.status}:`, text);
      throw new Error(`Erro HTTP ${response.status}: ${text}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    console.log(
      `[Sicredi] PDF baixado com sucesso (${arrayBuffer.byteLength} bytes)`
    );
    return Buffer.from(arrayBuffer);
  } catch (error) {
    const errMsg =
      error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`[Sicredi] Falha ao baixar PDF:`, errMsg);
    throw new Error(`Sicredi PDF falhou: ${errMsg}`);
  }
}

/**
 * Consulta boletos liquidados em um dia especifico
 * Conforme manual Sicredi v3.9 seção 7.19
 * GET /cobranca/boleto/v1/boletos/liquidados/dia?codigoBeneficiario=...&dia=DD/MM/YYYY
 */
export async function sicrediQueryLiquidados(
  dia: string // formato DD/MM/YYYY
): Promise<{ success: boolean; items?: any[]; error?: string }> {
  if (!isSicrediConfigured()) {
    console.log(`[Sicredi Mock] Consultando liquidados dia ${dia}`);
    return { success: true, items: [] };
  }

  const token = await sicrediAuth();
  const url = `${SICREDI_API_URL}${PATH_PREFIX}/cobranca/boleto/v1/boletos/liquidados/dia?codigoBeneficiario=${SICREDI_BENEFICIARIO}&dia=${encodeURIComponent(dia)}`;

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "x-api-key": SICREDI_API_KEY!,
    "cooperativa": SICREDI_COOPERATIVA!,
    "posto": SICREDI_POSTO!,
  };

  console.log(`[Sicredi] Consultando liquidados dia ${dia}...`);

  try {
    let allItems: any[] = [];
    let pagina = 0;
    let hasNext = true;

    while (hasNext) {
      const pageUrl = pagina > 0 ? `${url}&pagina=${pagina}` : url;
      const response = await fetchWithRetry(pageUrl, { method: "GET", headers });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.error(`[Sicredi] Erro liquidados ${response.status}:`, text.slice(0, 200));
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const data = await response.json();
      const items = data.items || [];
      allItems = allItems.concat(items);
      hasNext = data.hasNext === true || data.hasNext === "true";
      pagina++;
    }

    console.log(`[Sicredi] ${allItems.length} boleto(s) liquidado(s) em ${dia}`);
    return { success: true, items: allItems };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`[Sicredi] Falha consulta liquidados:`, errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Cancela (baixa) um boleto pelo nossoNumero
 * Conforme manual Sicredi v3.9 seção 7.4
 */
export async function sicrediCancelBoleto(
  nossoNumero: string
): Promise<{ success: boolean; error?: string; data?: any }> {
  // Mock se nao configurado
  if (!isSicrediConfigured()) {
    console.log(`[Sicredi Mock] Cancelando boleto ${nossoNumero}`);
    return { success: true };
  }

  const token = await sicrediAuth();

  // Conforme manual Sicredi v3.9 seção 7.4:
  // PATCH /cobranca/boleto/v1/boletos/{nossoNumero}/baixa
  // Headers: Authorization, x-api-key, Content-Type, cooperativa, posto, codigoBeneficiario
  // Body: vazio (sem body)
  // Retorno esperado: 202 (ACCEPTED)
  const url = `${SICREDI_API_URL}${PATH_PREFIX}/cobranca/boleto/v1/boletos/${nossoNumero}/baixa`;

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "x-api-key": SICREDI_API_KEY!,
    "Content-Type": "application/json",
    "cooperativa": SICREDI_COOPERATIVA!,
    "posto": SICREDI_POSTO!,
    "codigoBeneficiario": SICREDI_BENEFICIARIO!,
  };

  console.log(`[Sicredi] Baixa: PATCH ${url}`);
  console.log(`[Sicredi] Headers: cooperativa=${SICREDI_COOPERATIVA}, posto=${SICREDI_POSTO}, codigoBeneficiario=${SICREDI_BENEFICIARIO}`);

  try {
    // Sicredi exige body JSON vazio {} conforme Postman collection
    const response = await fetchWithRetry(url, {
      method: "PATCH",
      headers,
      body: "{}",
    });

    // Capturar headers de resposta para debug
    const respHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => { respHeaders[k] = v; });
    console.log(`[Sicredi] Baixa status: ${response.status}`);
    console.log(`[Sicredi] Baixa response headers:`, JSON.stringify(respHeaders));

    // Ler body como texto primeiro para garantir que capturamos tudo
    const rawText = await response.text().catch(() => "");
    console.log(`[Sicredi] Baixa response body: "${rawText}"`);

    let data: any = {};
    if (rawText) {
      try { data = JSON.parse(rawText); } catch { data = { rawBody: rawText.slice(0, 500) }; }
    }

    // 202 = sucesso conforme manual
    if (response.status === 202 || response.ok) {
      console.log(`[Sicredi] Boleto ${nossoNumero} baixa solicitada com sucesso`);
      return { success: true, data };
    }

    const errorMsg = data?.message || data?.error || data?.rawBody || rawText || `Erro HTTP ${response.status}`;
    console.error(`[Sicredi] Erro baixa ${response.status}: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
      data: { ...data, httpStatus: response.status, responseHeaders: respHeaders },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`[Sicredi] Falha ao cancelar boleto:`, errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Atualiza descontos de um boleto pelo nossoNumero
 */
export async function sicrediUpdateDiscount(
  nossoNumero: string,
  descontos: { valor1?: number; valor2?: number; valor3?: number }
): Promise<{ success: boolean; error?: string }> {
  // Mock se nao configurado
  if (!isSicrediConfigured()) {
    console.log(
      `[Sicredi Mock] Atualizando desconto boleto ${nossoNumero}:`,
      descontos
    );
    return { success: true };
  }

  const token = await sicrediAuth();
  const url = `${SICREDI_API_URL}${PATH_PREFIX}/cobranca/boleto/v1/boletos/${nossoNumero}/desconto`;

  console.log(
    `[Sicredi] Atualizando desconto do boleto ${nossoNumero}:`,
    descontos
  );

  try {
    const response = await fetchWithRetry(url, {
      method: "PATCH",
      headers: commonHeaders(token),
      body: JSON.stringify(descontos),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      console.error(
        `[Sicredi] Erro ao atualizar desconto ${response.status}:`,
        data
      );
      return {
        success: false,
        error:
          (data as any)?.message ||
          (data as any)?.error ||
          `Erro HTTP ${response.status}`,
      };
    }

    console.log(
      `[Sicredi] Desconto do boleto ${nossoNumero} atualizado com sucesso`
    );
    return { success: true };
  } catch (error) {
    const errMsg =
      error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`[Sicredi] Falha ao atualizar desconto:`, errMsg);
    return { success: false, error: errMsg };
  }
}
