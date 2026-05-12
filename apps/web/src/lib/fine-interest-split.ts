/**
 * Regras de divisao de juros e multa por atraso entre imobiliaria e proprietario.
 *
 * Fonte: regra de negocio do Leo (audio em 2026-05-06):
 *
 *   "99% das vezes funciona assim: se o cliente pagar ate o dia 10, juros e
 *    multa eh para nos (a imobiliaria). Se ele pagar depois, juros e multa eh
 *    para o proprietario. A nao ser que a gente garantiu o aluguel — ai
 *    juros/multa eh para a imobiliaria sempre."
 *
 * Logica:
 *   - aluguelGarantido = true  → SEMPRE retido pela imobiliaria
 *   - aluguelGarantido = false → depende de paidAt:
 *      - paidAt.dia <= diaCorte → retido pela imobiliaria
 *      - paidAt.dia >  diaCorte → repassado ao proprietario
 *
 * O `diaCorte` vem do BillingSettings (default 10), configuravel.
 */

export interface FineInterestSplitInput {
  /** Multa em R$ (ja calculada pelo banco/sistema) */
  fineValue: number | null | undefined;
  /** Juros em R$ (ja calculado pelo banco/sistema) */
  interestValue: number | null | undefined;
  /** Data efetiva do pagamento. Se null, considera pagamento futuro/em-aberto. */
  paidAt: Date | null | undefined;
  /** Flag do contrato — true = imobiliaria garante o repasse */
  aluguelGarantido: boolean | null | undefined;
  /** Dia limite (config global, default 10) */
  diaCorte: number;
}

export interface FineInterestSplitResult {
  /** Quanto da multa fica com a imobiliaria */
  fineToImob: number;
  /** Quanto da multa vai pro proprietario */
  fineToOwner: number;
  /** Quanto dos juros fica com a imobiliaria */
  interestToImob: number;
  /** Quanto dos juros vai pro proprietario */
  interestToOwner: number;
  /** Flag: multa ficou retida pela imobiliaria? (auditoria no Payment) */
  fineRetidaImobiliaria: boolean;
  /** Flag: juros ficou retido pela imobiliaria? (auditoria no Payment) */
  interestRetidaImobiliaria: boolean;
  /** Motivo legivel pra mostrar no demonstrativo/UI */
  motivo: "ALUGUEL_GARANTIDO" | "DENTRO_PRAZO" | "FORA_PRAZO" | "SEM_ATRASO";
  motivoLabel: string;
}

export function applyFineInterestSplit(
  input: FineInterestSplitInput,
): FineInterestSplitResult {
  const fine = Math.max(0, input.fineValue ?? 0);
  const interest = Math.max(0, input.interestValue ?? 0);

  // Sem juros nem multa — nao tem nada pra dividir
  if (fine === 0 && interest === 0) {
    return {
      fineToImob: 0,
      fineToOwner: 0,
      interestToImob: 0,
      interestToOwner: 0,
      fineRetidaImobiliaria: false,
      interestRetidaImobiliaria: false,
      motivo: "SEM_ATRASO",
      motivoLabel: "Pagamento dentro do vencimento — sem juros/multa",
    };
  }

  // Aluguel garantido — sempre retido pela imobiliaria
  if (input.aluguelGarantido) {
    return {
      fineToImob: fine,
      fineToOwner: 0,
      interestToImob: interest,
      interestToOwner: 0,
      fineRetidaImobiliaria: true,
      interestRetidaImobiliaria: true,
      motivo: "ALUGUEL_GARANTIDO",
      motivoLabel:
        "Aluguel garantido pela imobiliaria — juros/multa retido pela imobiliaria",
    };
  }

  // Sem paidAt: nao da pra decidir, assume retido (sera ajustado quando pagar)
  if (!input.paidAt) {
    return {
      fineToImob: fine,
      fineToOwner: 0,
      interestToImob: interest,
      interestToOwner: 0,
      fineRetidaImobiliaria: true,
      interestRetidaImobiliaria: true,
      motivo: "DENTRO_PRAZO",
      motivoLabel: "Pagamento ainda em aberto",
    };
  }

  // Fix Bug 29: usar timezone São Paulo pra extrair o dia.
  // Antes, `new Date(paidAt).getDate()` usava timezone local do servidor.
  // Boleto pago 10/05 às 23:30 BRT vira 11/05 02:30 UTC — em servidor UTC,
  // getDate() retornava 11 e juros/multa passavam indevidamente do imob
  // para o owner.
  const diaStr = new Date(input.paidAt).toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
  });
  const dia = parseInt(diaStr.slice(0, 2), 10);
  const dentroDoPrazo = dia <= input.diaCorte;

  if (dentroDoPrazo) {
    return {
      fineToImob: fine,
      fineToOwner: 0,
      interestToImob: interest,
      interestToOwner: 0,
      fineRetidaImobiliaria: true,
      interestRetidaImobiliaria: true,
      motivo: "DENTRO_PRAZO",
      motivoLabel: `Pago dia ${dia} (ate dia ${input.diaCorte}) — juros/multa retido pela imobiliaria`,
    };
  }

  // Pagamento apos o dia de corte → vai pro proprietario
  return {
    fineToImob: 0,
    fineToOwner: fine,
    interestToImob: 0,
    interestToOwner: interest,
    fineRetidaImobiliaria: false,
    interestRetidaImobiliaria: false,
    motivo: "FORA_PRAZO",
    motivoLabel: `Pago dia ${dia} (apos dia ${input.diaCorte}) — juros/multa repassado ao proprietario`,
  };
}
