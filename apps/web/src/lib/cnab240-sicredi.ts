// ==================================================
// Gerador de Arquivo CNAB 240 - Sicredi (Banco 748)
// Layout FEBRABAN para Pagamentos/Transferencias
// ==================================================

// Dados da empresa pagadora (configurados via .env)
const EMPRESA_CNPJ = process.env.CNAB_EMPRESA_CNPJ || "";
const EMPRESA_NOME = process.env.CNAB_EMPRESA_NOME || "SOMMA IMOVEIS";

// Convênio Sicredi - Pagamento a Fornecedor (Nota G002 do manual):
// Posições 033-036 = código convênio X(004) = exatamente 4 chars alfanuméricos
// Posições 037-052 = Filler X(016) = brancos obrigatórios
// Código atribuído pelo Sicredi (ex: "762F") - verificar com gerente de conta
const EMPRESA_CONVENIO = process.env.CNAB_CONVENIO_CODIGO || "76ZF";

// No Sicredi, "agência" no CNAB = cooperativa (ex: "0156"), NÃO o posto ("10")
const EMPRESA_AGENCIA = process.env.SICREDI_COOPERATIVA || process.env.CNAB_EMPRESA_AGENCIA || "";
// DV agência: usar CNAB_EMPRESA_AGENCIA_DV se definido, senão branco
const EMPRESA_AGENCIA_DV_RAW = process.env.CNAB_EMPRESA_AGENCIA_DV || " ";
const EMPRESA_AGENCIA_DV = EMPRESA_AGENCIA_DV_RAW.length > 1
  ? EMPRESA_AGENCIA_DV_RAW.slice(-1) // "02" → "2"
  : EMPRESA_AGENCIA_DV_RAW;
// Conta: usar valor direto do env (sistema Sicredi mostra C/C: 0000784-3, sem posto)
const EMPRESA_CONTA = process.env.CNAB_EMPRESA_CONTA || "";
const EMPRESA_CONTA_DV = process.env.CNAB_EMPRESA_CONTA_DV || " ";
const EMPRESA_ENDERECO = process.env.CNAB_EMPRESA_ENDERECO || "";
const EMPRESA_NUMERO = process.env.CNAB_EMPRESA_NUMERO || "";
const EMPRESA_CIDADE = process.env.CNAB_EMPRESA_CIDADE || "";
const EMPRESA_CEP = process.env.CNAB_EMPRESA_CEP || "";
const EMPRESA_UF = process.env.CNAB_EMPRESA_UF || "";

const BANCO_CODIGO = "748";
const BANCO_NOME = "SICREDI";

// ---- Tipos ----

export interface CnabFavorecido {
  nome: string;
  documento: string; // CPF ou CNPJ (somente numeros)
  banco: string; // Codigo COMPE do banco (ex: "748")
  agencia: string; // Numero da agencia
  agenciaDv: string; // DV agencia
  conta: string; // Numero da conta
  contaDv: string; // DV conta
  chavePix?: string; // Chave PIX (opcional)
  tipoChavePix?: string; // CPF, CNPJ, EMAIL, TELEFONE, ALEATORIA
  endereco?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  cep?: string;
  uf?: string;
}

export interface CnabPagamento {
  favorecido: CnabFavorecido;
  valor: number; // Em reais (ex: 1234.56)
  dataPagamento: Date;
  documentoEmpresa: string; // Numero de controle/referencia
  informacoes?: string; // Texto livre (40 chars max)
}

export interface CnabConfig {
  sequencialArquivo?: number; // Sequencial do arquivo (incrementa a cada envio)
  formaPagamento?: "PIX" | "TED" | "CC"; // Padrao: PIX
}

export interface CnabResult {
  content: string;
  filename: string;
  totalPagamentos: number;
  valorTotal: number;
}

// ---- Helpers de formatacao ----

/** Preenche numero com zeros a esquerda */
function padNum(value: string | number, length: number): string {
  return String(value).replace(/\D/g, "").padStart(length, "0").slice(-length);
}

/** Preenche texto com espacos a direita */
function padStr(value: string, length: number): string {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .toUpperCase()
    .padEnd(length, " ")
    .slice(0, length);
}

/** Formata data como DDMMAAAA */
function formatDateCnab(date: Date): string {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = String(date.getFullYear());
  return `${d}${m}${y}`;
}

/** Formata hora como HHMMSS */
function formatTimeCnab(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}${m}${s}`;
}

/** Converte valor em reais para centavos como string com N digitos */
function valorCentavos(valor: number, length: number): string {
  const centavos = Math.round(valor * 100);
  return padNum(centavos, length);
}

/** Tipo inscricao: 1=CPF, 2=CNPJ */
function tipoInscricao(documento: string): string {
  const doc = documento.replace(/\D/g, "");
  return doc.length <= 11 ? "1" : "2";
}

/** Codigo camara centralizadora baseado na forma de pagamento */
function codigoCamara(forma: "PIX" | "TED" | "CC"): string {
  switch (forma) {
    case "PIX":
      return "009";
    case "TED":
      return "018";
    case "CC":
      return "000";
  }
}

/** Forma de lancamento baseado na forma de pagamento */
function formaLancamento(forma: "PIX" | "TED" | "CC"): string {
  switch (forma) {
    case "PIX":
      return "45";
    case "TED":
      return "41";
    case "CC":
      return "01";
  }
}

/** Tipo de chave PIX para CNAB Sicredi (2 posições: 015-016) */
function tipoChavePixCnab(tipo: string | undefined): string {
  switch (tipo?.toUpperCase()) {
    case "TELEFONE":
      return "01";
    case "EMAIL":
      return "02";
    case "CPF":
    case "CNPJ":
      return "03";
    case "ALEATORIA":
      return "04";
    default:
      return "05"; // Dados bancarios (sem chave)
  }
}

/**
 * Normaliza a chave PIX conforme o tipo. Sicredi rejeita chaves mal-formatadas:
 *  - TELEFONE: precisa estar em E.164 (+5551999999999)
 *  - CPF/CNPJ: somente digitos (sem . / -)
 *  - EMAIL: lowercase, trim
 *  - ALEATORIA: trim (UUID-like, deixa como esta)
 */
export function normalizePixKey(chave: string | undefined, tipo: string | undefined): string {
  if (!chave) return "";
  const t = tipo?.toUpperCase();
  const raw = chave.trim();

  if (t === "TELEFONE") {
    // Mantem apenas digitos
    let digits = raw.replace(/\D/g, "");
    // Remove zero inicial (formato antigo de DDD: "051...")
    if (digits.startsWith("0") && digits.length >= 11) digits = digits.slice(1);
    // Se nao tem 55 na frente e parece BR (10 ou 11 digitos), adiciona
    if (!digits.startsWith("55") && (digits.length === 10 || digits.length === 11)) {
      digits = "55" + digits;
    }
    // Resultado final: + na frente
    return digits ? "+" + digits : "";
  }

  if (t === "CPF" || t === "CNPJ") {
    return raw.replace(/\D/g, "");
  }

  if (t === "EMAIL") {
    return raw.toLowerCase();
  }

  // ALEATORIA / outros
  return raw;
}

// ---- Registros CNAB 240 ----

function headerArquivo(config: CnabConfig): string {
  const now = new Date();
  const seq = config.sequencialArquivo || 1;

  let registro = "";
  registro += BANCO_CODIGO; // 001-003: codigo banco
  registro += "0000"; // 004-007: lote servico
  registro += "0"; // 008: tipo registro
  registro += padStr("", 9); // 009-017: brancos
  registro += tipoInscricao(EMPRESA_CNPJ); // 018: tipo inscricao
  registro += padNum(EMPRESA_CNPJ, 14); // 019-032: CNPJ
  registro += padStr(EMPRESA_CONVENIO, 4); // 033-036: codigo convenio (4 chars)
  registro += padStr("", 16); // 037-052: filler brancos
  registro += padNum(EMPRESA_AGENCIA, 5); // 053-057: agencia
  registro += padStr(EMPRESA_AGENCIA_DV, 1); // 058: DV agencia
  registro += padNum(EMPRESA_CONTA, 12); // 059-070: conta
  registro += padStr(EMPRESA_CONTA_DV, 1); // 071: DV conta
  registro += padStr("", 1); // 072: DV agencia/conta
  registro += padStr(EMPRESA_NOME, 30); // 073-102: nome empresa
  registro += padStr(BANCO_NOME, 30); // 103-132: nome banco
  registro += padStr("", 10); // 133-142: brancos
  registro += "1"; // 143: remessa
  registro += formatDateCnab(now); // 144-151: data geracao
  registro += formatTimeCnab(now); // 152-157: hora geracao
  registro += padNum(seq, 6); // 158-163: sequencial arquivo
  registro += "091"; // 164-166: versao layout
  registro += padNum(0, 5); // 167-171: densidade
  registro += padStr("", 20); // 172-191: reservado banco
  registro += padStr("", 20); // 192-211: reservado empresa
  registro += padStr("", 29); // 212-240: brancos

  return registro;
}

function headerLote(loteNum: number, forma: "PIX" | "TED" | "CC"): string {
  let registro = "";
  registro += BANCO_CODIGO; // 001-003
  registro += padNum(loteNum, 4); // 004-007: lote
  registro += "1"; // 008: tipo registro
  registro += "C"; // 009: tipo operacao (credito)
  registro += "20"; // 010-011: tipo servico (20 = Pagamento Fornecedor)
  registro += formaLancamento(forma); // 012-013: forma lancamento
  registro += "045"; // 014-016: versao layout lote
  registro += " "; // 017: branco
  registro += tipoInscricao(EMPRESA_CNPJ); // 018: tipo inscricao
  registro += padNum(EMPRESA_CNPJ, 14); // 019-032: CNPJ
  registro += padStr(EMPRESA_CONVENIO, 4); // 033-036: codigo convenio (4 chars)
  registro += padStr("", 16); // 037-052: filler brancos
  registro += padNum(EMPRESA_AGENCIA, 5); // 053-057: agencia
  registro += padStr(EMPRESA_AGENCIA_DV, 1); // 058: DV
  registro += padNum(EMPRESA_CONTA, 12); // 059-070: conta
  registro += padStr(EMPRESA_CONTA_DV, 1); // 071: DV
  registro += padStr("", 1); // 072: DV ag/conta
  registro += padStr(EMPRESA_NOME, 30); // 073-102: nome
  registro += padStr("", 40); // 103-142: mensagem
  registro += padStr(EMPRESA_ENDERECO, 30); // 143-172: logradouro
  registro += padNum(EMPRESA_NUMERO, 5); // 173-177: numero
  registro += padStr("", 15); // 178-192: complemento
  registro += padStr(EMPRESA_CIDADE, 20); // 193-212: cidade
  registro += padNum(EMPRESA_CEP.replace("-", "").slice(0, 5), 5); // 213-217: CEP
  registro += padStr(EMPRESA_CEP.replace("-", "").slice(5, 8), 3); // 218-220: complemento CEP
  registro += padStr(EMPRESA_UF, 2); // 221-222: UF
  registro += padNum(0, 2); // 223-224: indicativo forma pgto
  registro += padStr("", 6); // 225-230: brancos
  registro += padStr("", 10); // 231-240: ocorrencias

  return registro;
}

function segmentoA(
  loteNum: number,
  seqReg: number,
  pagamento: CnabPagamento,
  forma: "PIX" | "TED" | "CC"
): string {
  const fav = pagamento.favorecido;

  let registro = "";
  registro += BANCO_CODIGO; // 001-003
  registro += padNum(loteNum, 4); // 004-007
  registro += "3"; // 008: tipo registro
  registro += padNum(seqReg, 5); // 009-013: sequencial
  registro += "A"; // 014: segmento
  registro += "0"; // 015: tipo movimento (inclusao)
  registro += "00"; // 016-017: codigo instrucao
  registro += codigoCamara(forma); // 018-020: camara
  registro += padNum(fav.banco || BANCO_CODIGO, 3); // 021-023: banco favorecido
  registro += padNum(fav.agencia, 5); // 024-028: agencia
  registro += padStr(fav.agenciaDv || " ", 1); // 029: DV agencia
  registro += padNum(fav.conta, 12); // 030-041: conta
  registro += padStr(fav.contaDv || " ", 1); // 042: DV conta
  registro += padStr("", 1); // 043: DV ag/conta
  registro += padStr(fav.nome, 30); // 044-073: nome favorecido
  registro += padStr(pagamento.documentoEmpresa, 20); // 074-093: doc empresa
  registro += formatDateCnab(pagamento.dataPagamento); // 094-101: data pagamento
  registro += "BRL"; // 102-104: tipo moeda
  registro += padNum(0, 15); // 105-119: quantidade moeda
  registro += valorCentavos(pagamento.valor, 15); // 120-134: valor
  registro += padStr("", 20); // 135-154: doc banco
  registro += padNum(0, 8); // 155-162: data efetivacao
  registro += padNum(0, 15); // 163-177: valor efetivacao
  registro += padStr(pagamento.informacoes || "", 40); // 178-217: informacoes
  registro += padStr("", 2); // 218-219: complemento servico
  // 220-224: finalidade TED
  if (forma === "TED") {
    registro += "00007"; // Pagamento de alugueis
  } else {
    registro += padStr("", 5);
  }
  registro += padStr("", 2); // 225-226: complemento finalidade
  registro += padStr("", 3); // 227-229: brancos
  registro += "0"; // 230: aviso favorecido (nao avisa)
  registro += padStr("", 10); // 231-240: ocorrencias

  return registro;
}

function segmentoB(
  loteNum: number,
  seqReg: number,
  pagamento: CnabPagamento,
  forma: "PIX" | "TED" | "CC"
): string {
  const fav = pagamento.favorecido;
  const isPix = forma === "PIX";

  let registro = "";
  registro += BANCO_CODIGO; // 001-003
  registro += padNum(loteNum, 4); // 004-007
  registro += "3"; // 008: tipo registro
  registro += padNum(seqReg, 5); // 009-013: sequencial
  registro += "B"; // 014: segmento

  if (isPix) {
    // Segmento B PIX (layout Sicredi pag. 11)
    registro += tipoChavePixCnab(fav.tipoChavePix); // 015-016: tipo chave PIX (2 pos)
    registro += " "; // 017: filler branco

    const tipoChave = fav.tipoChavePix?.toUpperCase();
    const isCpfCnpjKey = tipoChave === "CPF" || tipoChave === "CNPJ";
    const isDadosBancarios = !fav.chavePix || tipoChave === "DADOS_BANCARIOS";

    registro += tipoInscricao(fav.documento); // 018: tipo inscricao
    registro += padNum(fav.documento, 14); // 019-032: CPF/CNPJ
    registro += padStr("", 30); // 033-062: informacao 10

    if (isDadosBancarios) {
      // PIX Dados Bancários: pos 063-067 livre, 068-091 chave, 092-232 brancos
      registro += padStr("", 5); // 063-067: informacao 11
      // Chave = CPF/CNPJ(14) + ISPB banco(8) + tipo conta(2) = 24 chars
      const ispb = ""; // ISPB do banco favorecido - precisa mapear
      const tipoConta = "01"; // 01=CC, 02=Poupança
      const chaveDadosBanc = padNum(fav.documento, 14) + padStr(ispb, 8) + tipoConta;
      registro += padStr(chaveDadosBanc, 24); // 068-091: chave PIX dados bancários
      registro += padStr("", 141); // 092-232: brancos
    } else if (isCpfCnpjKey) {
      // PIX CPF/CNPJ: chave vai no campo 019-032, pos 063-232 livres
      registro += padStr("", 65); // 063-127: informacao 11
      registro += padStr("", 99); // 128-226: chave PIX (vazio para CPF/CNPJ)
      registro += padStr("", 6); // 227-232: brancos
    } else {
      // PIX Telefone/Email/Aleatória: chave em pos 128-226
      // Normaliza pra formato aceito pelo Sicredi (E.164 pra telefone, etc)
      const chaveNorm = normalizePixKey(fav.chavePix, fav.tipoChavePix);
      registro += padStr("", 65); // 063-127: informacao 11
      registro += padStr(chaveNorm, 99); // 128-226: chave PIX (99 pos)
      registro += padStr("", 6); // 227-232: brancos
    }
  } else {
    // Segmento B TED/CC (layout Sicredi pag. 10)
    registro += padStr("", 3); // 015-017: brancos
    registro += tipoInscricao(fav.documento); // 018: tipo inscricao
    registro += padNum(fav.documento, 14); // 019-032: CPF/CNPJ
    registro += padStr(fav.endereco || "", 30); // 033-062: logradouro
    registro += padNum(fav.numero || "0", 5); // 063-067: numero
    registro += padStr(fav.complemento || "", 15); // 068-082: complemento
    registro += padStr(fav.bairro || "", 15); // 083-097: bairro
    registro += padStr(fav.cidade || "", 20); // 098-117: cidade
    registro += padNum((fav.cep || "").replace("-", ""), 8); // 118-125: CEP (8 pos)
    registro += padStr(fav.uf || "", 2); // 126-127: UF
    registro += padNum(0, 8); // 128-135: data vencimento
    registro += padNum(0, 15); // 136-150: valor documento
    registro += padNum(0, 15); // 151-165: abatimento
    registro += padNum(0, 15); // 166-180: desconto
    registro += padNum(0, 15); // 181-195: mora
    registro += padNum(0, 15); // 196-210: multa
    registro += padStr("", 15); // 211-225: codigo documento favorecido
    registro += "0"; // 226: aviso favorecido
    registro += padStr("", 6); // 227-232: exclusivo SIAPE
    registro += padStr("", 8); // 233-240: brancos
  }

  // Preencher ate 240 caracteres
  const remaining = 240 - registro.length;
  if (remaining > 0) {
    registro += padStr("", remaining);
  }

  return registro.slice(0, 240);
}

function trailerLote(
  loteNum: number,
  qtdRegistros: number,
  valorTotal: number
): string {
  let registro = "";
  registro += BANCO_CODIGO; // 001-003
  registro += padNum(loteNum, 4); // 004-007
  registro += "5"; // 008: tipo registro
  registro += padStr("", 9); // 009-017: brancos
  registro += padNum(qtdRegistros, 6); // 018-023: qtd registros no lote
  registro += valorCentavos(valorTotal, 18); // 024-041: somatoria valores
  registro += padNum(0, 18); // 042-059: somatoria moedas
  registro += padNum(0, 6); // 060-065: numero aviso debito
  registro += padStr("", 165); // 066-230: brancos
  registro += padStr("", 10); // 231-240: ocorrencias

  return registro;
}

function trailerArquivo(qtdLotes: number, qtdRegistros: number): string {
  let registro = "";
  registro += BANCO_CODIGO; // 001-003
  registro += "9999"; // 004-007: lote servico
  registro += "9"; // 008: tipo registro
  registro += padStr("", 9); // 009-017: brancos
  registro += padNum(qtdLotes, 6); // 018-023: qtd lotes
  registro += padNum(qtdRegistros, 6); // 024-029: qtd registros
  registro += padNum(0, 6); // 030-035: contas conciliacao
  registro += padStr("", 205); // 036-240: brancos

  return registro;
}

// ---- Funcao Principal ----

/**
 * Verifica se a geracao de CNAB 240 esta configurada
 */
export function isCnab240Configured(): boolean {
  return !!(
    EMPRESA_CNPJ &&
    EMPRESA_CONVENIO &&
    EMPRESA_AGENCIA &&
    EMPRESA_CONTA
  );
}

/**
 * Gera um arquivo CNAB 240 para pagamentos no Sicredi
 */
export function generateCnab240(
  pagamentos: CnabPagamento[],
  config: CnabConfig = {}
): CnabResult {
  if (pagamentos.length === 0) {
    throw new Error("Nenhum pagamento para gerar");
  }

  const forma = config.formaPagamento || "PIX";
  const linhas: string[] = [];

  // 1. Header de arquivo
  linhas.push(headerArquivo(config));

  // 2. Header de lote
  const loteNum = 1;
  linhas.push(headerLote(loteNum, forma));

  // 3. Segmentos A + B para cada pagamento
  let seqReg = 0;
  let valorTotal = 0;

  for (const pgto of pagamentos) {
    seqReg++;
    linhas.push(segmentoA(loteNum, seqReg, pgto, forma));
    seqReg++;
    linhas.push(segmentoB(loteNum, seqReg, pgto, forma));
    valorTotal += pgto.valor;
  }

  // 4. Trailer de lote
  // qtd registros no lote = header lote + segmentos + trailer lote
  const qtdRegistrosLote = 1 + pagamentos.length * 2 + 1;
  linhas.push(trailerLote(loteNum, qtdRegistrosLote, valorTotal));

  // 5. Trailer de arquivo
  // qtd total = header arquivo + registros do lote + trailer arquivo
  const qtdTotalRegistros = 1 + qtdRegistrosLote + 1;
  linhas.push(trailerArquivo(1, qtdTotalRegistros));

  // Validar que cada linha tem exatamente 240 caracteres
  for (let i = 0; i < linhas.length; i++) {
    if (linhas[i].length !== 240) {
      console.error(
        `[CNAB240] Linha ${i + 1} tem ${linhas[i].length} caracteres (esperado: 240)`
      );
      // Ajustar para garantir 240 chars
      if (linhas[i].length < 240) {
        linhas[i] = linhas[i].padEnd(240, " ");
      } else {
        linhas[i] = linhas[i].slice(0, 240);
      }
    }
  }

  const content = linhas.join("\r\n") + "\r\n"; // finalizador hexadecimal 0D0A obrigatório

  // Nome do arquivo: CCCCDDSS.REM (convênio 4 digs + dia + sequencial)
  // Ex: convênio=0405, dia=10, seq=22 → "04051022.REM"
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const seqFile = String(config.sequencialArquivo || 1).padStart(2, "0").slice(-2);
  const filename = `${EMPRESA_CONVENIO}${dd}${seqFile}.REM`;

  return {
    content,
    filename,
    totalPagamentos: pagamentos.length,
    valorTotal: Math.round(valorTotal * 100) / 100,
  };
}
