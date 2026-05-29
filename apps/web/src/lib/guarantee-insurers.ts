/**
 * Lista padronizada de seguradoras/empresas para garantia de aluguel.
 *
 * Padrao definido pelo Leo (cliente Somma) — Mai/2026.
 * Aplicavel quando Contract.guaranteeType for SEGURO_FIANCA ou
 * TITULO_CAPITALIZACAO.
 *
 * Cada item tem `value` (persistido no banco) e `label` (mostrado na UI).
 * "OUTRA" deixa o admin descrever em Contract.guaranteeNotes.
 */
export const GUARANTEE_INSURERS = [
  { value: "PORTO", label: "Porto" },
  { value: "TOKIO", label: "Tokio Marine" },
  { value: "TOO", label: "Too Seguros" },
  { value: "POTTENCIAL", label: "Pottencial" },
  { value: "CREDPAGO_LOFT", label: "Credpago / Loft" },
  { value: "MAGNICRED", label: "Magnicred" },
  { value: "CREDALUGA", label: "Credaluga" },
  { value: "OUTRA", label: "Outra (especificar nas observações)" },
] as const;

export type GuaranteeInsurerValue = (typeof GUARANTEE_INSURERS)[number]["value"];

export const GUARANTEE_INSURER_LABELS: Record<string, string> =
  GUARANTEE_INSURERS.reduce((acc, x) => {
    acc[x.value] = x.label;
    return acc;
  }, {} as Record<string, string>);

/**
 * Tipos de garantia que pedem informar a seguradora.
 */
export const TYPES_WITH_INSURER = ["SEGURO_FIANCA", "TITULO_CAPITALIZACAO"];

export function requiresInsurer(guaranteeType: string | null | undefined): boolean {
  return !!guaranteeType && TYPES_WITH_INSURER.includes(guaranteeType);
}
