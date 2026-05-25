// ==================================================
// Servico de envio de mensagens WhatsApp via Uazapi
// https://docs.uazapi.com
// ==================================================

const UAZAPI_URL = process.env.UAZAPI_URL;
const UAZAPI_TOKEN = process.env.UAZAPI_TOKEN;

// Delay entre mensagens (ms) para evitar rate limit e banimento
const MESSAGE_DELAY_MS = 3000;

// Rate limit: maximo de mensagens por hora para evitar bloqueio do numero
const MAX_MESSAGES_PER_HOUR = 30;
const messageTimestamps: number[] = [];

function checkHourlyLimit(): boolean {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  // Remove timestamps antigos
  while (messageTimestamps.length > 0 && messageTimestamps[0] < oneHourAgo) {
    messageTimestamps.shift();
  }
  return messageTimestamps.length < MAX_MESSAGES_PER_HOUR;
}

function recordMessage(): void {
  messageTimestamps.push(Date.now());
}

// Fila simples para envio sequencial com delay
let sendQueue: Promise<void> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    sendQueue = sendQueue.then(async () => {
      // Verificar rate limit por hora
      if (!checkHourlyLimit()) {
        reject(new Error(`Rate limit: máximo de ${MAX_MESSAGES_PER_HOUR} mensagens por hora atingido. Tente novamente mais tarde.`));
        return;
      }
      try {
        const result = await fn();
        recordMessage();
        resolve(result);
      } catch (err) {
        reject(err);
      }
      // Delay entre mensagens
      await new Promise((r) => setTimeout(r, MESSAGE_DELAY_MS));
    });
  });
}

export interface WhatsAppMessage {
  to: string; // Numero de telefone do destinatario
  message: string;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Formata numero de telefone para o padrao Uazapi (DDI + numero, sem +).
 * - Se o numero original comeca com "+": preserva os digitos como estao
 *   (DDI ja explicito, NAO adiciona 55). Caso internacional.
 * - Senao, se ja comeca com "55" e tem 12-13 digitos: ok.
 * - Senao, se tem 10-11 digitos: assume BR e adiciona 55.
 * - Senao: retorna so digitos (API valida).
 */
function formatPhone(phone: string): string {
  const trimmed = (phone || "").trim();
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  // Caso internacional explicito: preserva DDI digitado, nao adiciona 55
  if (hadPlus) {
    return digits;
  }

  // Ja comeca com 55 e tem 12-13 digitos (DDI BR + DDD + numero)
  if (digits.startsWith("55") && digits.length >= 12) {
    return digits;
  }

  // 10-11 digitos: assume BR (DDD + numero) e adiciona DDI 55
  if (digits.length >= 10 && digits.length <= 11) {
    return `55${digits}`;
  }

  // 12+ digitos sem + e sem comecar com 55: provavel internacional sem +
  // (caso usuario digitou "447911123456" UK sem o +) - preserva como esta
  return digits;
}

/**
 * Verifica se a integracao Uazapi esta configurada
 */
export function isUazapiConfigured(): boolean {
  return !!(UAZAPI_URL && UAZAPI_TOKEN);
}

/**
 * Envio direto (sem fila) - usado internamente
 */
async function doSendText(msg: WhatsAppMessage): Promise<SendResult> {
  // Valida numero
  const cleanPhone = msg.to.replace(/\D/g, "");
  if (cleanPhone.length < 10) {
    return {
      success: false,
      error: `Número de telefone inválido: ${msg.to}`,
    };
  }

  // Fallback mock se Uazapi nao estiver configurado
  if (!UAZAPI_URL || !UAZAPI_TOKEN) {
    console.log(
      `[WhatsApp Mock] Enviando para ${msg.to}: ${msg.message.substring(0, 80)}...`
    );
    const messageId = `mock-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    console.log(`[WhatsApp Mock] ID: ${messageId}`);
    return { success: true, messageId };
  }

  // Envio real via Uazapi (Uazapi exige sufixo @s.whatsapp.net)
  const number = formatPhone(msg.to) + "@s.whatsapp.net";
  try {
    const response = await fetch(`${UAZAPI_URL}/send/text`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "token": UAZAPI_TOKEN,
      },
      body: JSON.stringify({
        number,
        text: msg.message,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`[Uazapi] Erro ${response.status}:`, data);
      return {
        success: false,
        error: data?.message || data?.error || `Erro HTTP ${response.status}`,
      };
    }

    console.log(`[Uazapi] Mensagem enviada para ${number}. Response:`, data);
    return {
      success: true,
      messageId: data?.key?.id || data?.messageId || data?.id || `uazapi-${Date.now()}`,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`[Uazapi] Falha ao enviar para ${number}:`, errMsg);
    return {
      success: false,
      error: errMsg,
    };
  }
}

/**
 * Envia uma mensagem de texto via WhatsApp usando Uazapi.
 * Enfileira automaticamente com delay entre mensagens para evitar rate limit.
 */
export function sendWhatsAppMessage(msg: WhatsAppMessage): Promise<SendResult> {
  return enqueue(() => doSendText(msg));
}

/**
 * Envio direto de documento (sem fila)
 */
async function doSendDocument(params: {
  to: string;
  fileUrl: string;
  fileName: string;
  caption?: string;
}): Promise<SendResult> {
  const cleanPhone = params.to.replace(/\D/g, "");
  if (cleanPhone.length < 10) {
    return {
      success: false,
      error: `Número de telefone inválido: ${params.to}`,
    };
  }

  if (!UAZAPI_URL || !UAZAPI_TOKEN) {
    console.log(
      `[WhatsApp Mock] Enviando documento "${params.fileName}" para ${params.to}`
    );
    return {
      success: true,
      messageId: `mock-doc-${Date.now()}`,
    };
  }

  const number = formatPhone(params.to) + "@s.whatsapp.net";
  try {
    const response = await fetch(`${UAZAPI_URL}/send/media`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "token": UAZAPI_TOKEN,
      },
      body: JSON.stringify({
        number,
        type: "document",
        file: params.fileUrl,
        docName: params.fileName,
        text: params.caption || "",
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`[Uazapi] Erro envio documento ${response.status}:`, data);
      return {
        success: false,
        error: data?.message || data?.error || `Erro HTTP ${response.status}`,
      };
    }

    console.log(`[Uazapi] Documento enviado para ${number}. Response:`, data);
    return {
      success: true,
      messageId: data?.key?.id || data?.messageId || data?.id || `uazapi-doc-${Date.now()}`,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Erro desconhecido";
    console.error(`[Uazapi] Falha ao enviar documento para ${number}:`, errMsg);
    return {
      success: false,
      error: errMsg,
    };
  }
}

/**
 * Envia um documento (PDF, imagem, etc) via WhatsApp usando Uazapi.
 * Enfileira automaticamente com delay entre mensagens.
 */
export function sendWhatsAppDocument(params: {
  to: string;
  fileUrl: string;
  fileName: string;
  caption?: string;
}): Promise<SendResult> {
  return enqueue(() => doSendDocument(params));
}

/**
 * Envia um documento via WhatsApp usando base64 (para PDFs gerados em memória).
 */
export function sendWhatsAppDocumentBase64(params: {
  to: string;
  fileBase64: string;
  fileName: string;
  caption?: string;
}): Promise<SendResult> {
  return enqueue(async () => {
    const cleanPhone = params.to.replace(/\D/g, "");
    if (cleanPhone.length < 10) {
      return { success: false, error: `Número de telefone inválido: ${params.to}` };
    }

    if (!UAZAPI_URL || !UAZAPI_TOKEN) {
      console.log(`[WhatsApp Mock] Enviando documento base64 "${params.fileName}" para ${params.to}`);
      return { success: true, messageId: `mock-doc64-${Date.now()}` };
    }

    const number = formatPhone(params.to) + "@s.whatsapp.net";
    try {
      const response = await fetch(`${UAZAPI_URL}/send/media`, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "token": UAZAPI_TOKEN,
        },
        body: JSON.stringify({
          number,
          type: "document",
          file: `data:application/pdf;base64,${params.fileBase64}`,
          docName: params.fileName,
          text: params.caption || "",
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error(`[Uazapi] Erro envio doc base64 ${response.status}:`, data);
        return { success: false, error: data?.message || data?.error || `Erro HTTP ${response.status}` };
      }

      console.log(`[Uazapi] Documento base64 enviado para ${number}`);
      return { success: true, messageId: data?.key?.id || data?.messageId || data?.id || `uazapi-doc64-${Date.now()}` };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Erro desconhecido";
      console.error(`[Uazapi] Falha doc base64 para ${number}:`, errMsg);
      return { success: false, error: errMsg };
    }
  });
}

/**
 * Envia uma mensagem via Email usando SMTP.
 * Suporta anexos opcionais (ex: PDF de boleto).
 */
export async function sendEmailMessage(msg: {
  to: string;
  subject: string;
  message: string;
  attachments?: { filename: string; content: Buffer }[];
}): Promise<SendResult> {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || "465");
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || smtpUser;

  if (!smtpHost || !smtpUser || !smtpPass) {
    console.log(`[Email Mock] SMTP não configurado. Para: ${msg.to} - ${msg.subject}`);
    return { success: true, messageId: `email-mock-${Date.now()}` };
  }

  try {
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });

    const info = await transporter.sendMail({
      from: `"Somma Imóveis" <${smtpFrom}>`,
      to: msg.to,
      subject: msg.subject,
      html: msg.message.replace(/\n/g, "<br>"),
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
      })),
    });

    console.log(`[Email] Enviado para ${msg.to}: ${msg.subject} (${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (error: any) {
    console.error(`[Email] Erro ao enviar para ${msg.to}:`, error.message, error.code || "", error.responseCode || "");
    return { success: false, error: `${error.message}${error.code ? ` (${error.code})` : ""}` };
  }
}

/**
 * Envia uma mensagem via SMS.
 * MOCK - apenas loga no console.
 */
export async function sendSmsMessage(msg: {
  to: string;
  message: string;
}): Promise<SendResult> {
  console.log(
    `[SMS Mock] Enviando para ${msg.to}: ${msg.message.substring(0, 50)}...`
  );
  await new Promise((r) => setTimeout(r, 150));
  return {
    success: true,
    messageId: `sms-mock-${Date.now()}`,
  };
}
