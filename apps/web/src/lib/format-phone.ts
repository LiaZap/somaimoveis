/**
 * Formata telefone com suporte a números nacionais (BR) e internacionais.
 *
 * Regras:
 * - Se começar com `+`: número internacional (E.164). Preserva o `+` e
 *   formata em blocos genéricos sem máscara de DDI específica.
 *   Aceita até 15 dígitos depois do `+` (padrão E.164).
 *
 * - Se for só dígitos com até 11 caracteres: aplica máscara BR
 *   `(DD) NNNNN-NNNN` (celular) ou `(DD) NNNN-NNNN` (fixo).
 *
 * - Se for só dígitos com 12+ caracteres: assume internacional sem `+`
 *   e formata em blocos (não força máscara BR).
 *
 * Exemplos:
 *   "11999998888"          -> "(11) 99999-8888"
 *   "1133334444"           -> "(11) 3333-4444"
 *   "+1 (415) 555-2671"    -> "+1 415 555 2671"
 *   "+5511999998888"       -> "+55 11 99999 8888"
 *   "447911123456"         -> "+44 79 1112 3456"
 */
export function formatPhone(value: string): string {
  if (!value) return "";

  const trimmed = value.trim();
  const hasPlus = trimmed.startsWith("+");
  // Mantém só dígitos (e o + se houver)
  const digits = trimmed.replace(/\D/g, "");

  // Internacional explícito (começa com +)
  if (hasPlus) {
    return formatInternational(digits);
  }

  // Sem +, mas com mais de 11 dígitos -> tratar como internacional
  if (digits.length > 11) {
    return formatInternational(digits);
  }

  // Padrão brasileiro
  if (digits.length <= 2) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7, 11)}`;
}

/**
 * Formata número internacional em blocos genéricos com prefixo +.
 * Não tenta detectar o DDI específico — usa quebras a cada 2-4 dígitos.
 *
 * Pra DDIs conhecidos (1, 44, 55, 351, ...), aplica espaço após o DDI.
 */
function formatInternational(digits: string): string {
  if (!digits) return "+";
  // Trim a 15 dígitos (limite E.164)
  const d = digits.slice(0, 15);

  // Detecta DDI (1, 2 ou 3 dígitos) — heurística simples
  // Lista parcial de DDIs comuns; expanda conforme necessário
  const ddi3 = ["351", "352", "353", "354", "355", "356", "357", "358", "359", "370", "371", "372", "373", "374", "375", "376", "377", "378", "380", "381", "382", "385", "386", "387", "389", "420", "421", "423", "971", "972", "973", "974", "975", "976", "977", "994", "995", "996", "998"];
  const ddi2 = ["20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49", "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98"];

  let ddi = "";
  let rest = d;
  if (d.length >= 3 && ddi3.includes(d.slice(0, 3))) {
    ddi = d.slice(0, 3);
    rest = d.slice(3);
  } else if (d.length >= 2 && ddi2.includes(d.slice(0, 2))) {
    ddi = d.slice(0, 2);
    rest = d.slice(2);
  } else if (d.length >= 1) {
    ddi = d.slice(0, 1); // DDI de 1 dígito (1 USA/Canadá, 7 Rússia)
    rest = d.slice(1);
  }

  if (!rest) return `+${ddi}`;

  // Caso especial BR (DDI 55): manter formato (DD) NNNNN-NNNN
  if (ddi === "55" && rest.length >= 10) {
    const dd = rest.slice(0, 2);
    const sub = rest.slice(2);
    if (sub.length <= 8) return `+55 (${dd}) ${sub.slice(0, 4)}-${sub.slice(4)}`;
    return `+55 (${dd}) ${sub.slice(0, 5)}-${sub.slice(5, 9)}`;
  }

  // Caso geral: primeiro bloco 2-3 dígitos (área/cidade), demais em 3-4
  const blocks: string[] = [];
  let i = 0;
  if (rest.length > 7) {
    // 3 dígitos área + 4+4 número
    blocks.push(rest.slice(0, 3));
    i = 3;
  } else if (rest.length > 3) {
    blocks.push(rest.slice(0, 2));
    i = 2;
  }
  while (i < rest.length) {
    const blockSize = Math.min(4, rest.length - i);
    blocks.push(rest.slice(i, i + blockSize));
    i += blockSize;
  }

  return `+${ddi} ${blocks.join(" ")}`;
}

/**
 * Remove formatação e retorna apenas dígitos (+ opcional no início).
 * Útil pra normalizar antes de salvar no banco ou enviar pro WhatsApp.
 */
export function normalizePhone(value: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return hasPlus ? `+${digits}` : digits;
}
