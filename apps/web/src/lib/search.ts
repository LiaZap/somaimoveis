/**
 * Helper para busca tokenizada com AND entre palavras e OR entre campos.
 *
 * Problema que resolve:
 * - Usuario digita "Maria Silva". Antes a busca procurava a string EXATA
 *   "Maria Silva" em cada campo, e nao achava se o nome estava como
 *   "MARIA APARECIDA SILVA" (porque tem palavra no meio).
 * - Agora cada palavra eh procurada separadamente, e TODAS precisam aparecer
 *   (em qualquer um dos campos especificados).
 *
 * Bonus:
 * - Se a entrada eh predominantemente numerica, faz busca normalizada para
 *   CPF/CNPJ/telefone (ignora pontuacao).
 * - Faz lowercase nas palavras (SQLite LIKE eh case-insensitive em ASCII,
 *   mas em outros DBs ajuda).
 *
 * Limitacoes:
 * - Nao trata acentos automaticamente. Para "joao" achar "João" precisamos
 *   de uma coluna normalizada (migration). Por enquanto eh melhor o usuario
 *   buscar com acento OU sem acento — e os dados precisam estar consistentes.
 *
 * Uso:
 *   const where: any = {};
 *   const searchClause = buildSearchWhere(searchTerm, [
 *     "code",
 *     "tenant.name",
 *     "owner.name",
 *     "description",
 *     "contract.code",
 *     "contract.property.title",
 *   ]);
 *   if (searchClause) where.AND = searchClause;
 */

export type SearchField = string; // "tenant.name" => relation tenant, field name

/**
 * Normaliza string para busca case-insensitive e accent-insensitive.
 *  - Lowercase
 *  - Remove acentos (NFD + remove combining marks)
 *  - Remove espacos extras nas pontas
 *
 * Ex: "João da Silva" → "joao da silva"
 *     "MARIA" → "maria"
 *     "Café"  → "cafe"
 */
export function normalizeForSearch(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove diacriticos
    .toLowerCase()
    .trim();
}

/**
 * Mapeia paths de field "regulares" para suas versoes normalizadas no banco.
 * Ex: "tenant.name" → "tenant.nameNormalized"
 *     "owner.name"  → "owner.nameNormalized"
 *     "property.title" → "property.titleNormalized"
 *     "title" (em /api/properties) → "titleNormalized"
 *     "name" (em /api/owners ou /api/tenants) → "nameNormalized"
 */
function mapToNormalizedField(field: string): string | null {
  // Path direto: name → nameNormalized, title → titleNormalized
  const parts = field.split(".");
  const last = parts[parts.length - 1];
  let normalizedLast: string | null = null;
  if (last === "name") normalizedLast = "nameNormalized";
  else if (last === "title") normalizedLast = "titleNormalized";
  if (!normalizedLast) return null;
  parts[parts.length - 1] = normalizedLast;
  return parts.join(".");
}

/**
 * Constroi uma clausula AND para o where do Prisma. Cada palavra do termo
 * de busca vira uma sub-clausula OR procurando a palavra em qualquer um
 * dos campos. Todas as palavras precisam casar (AND entre palavras).
 *
 * Retorna null se o termo for vazio.
 */
export function buildSearchWhere(
  term: string | null | undefined,
  fields: SearchField[],
  options: { numericFields?: SearchField[] } = {},
): Array<Record<string, unknown>> | null {
  if (!term) return null;
  const trimmed = term.trim();
  if (!trimmed) return null;

  // Tokeniza por espacos. Filtra tokens muito curtos (ex: "a", "o").
  const tokens = trimmed
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 || /^\d+$/.test(t));
  if (tokens.length === 0) return null;

  // Detecta se a busca eh numerica (CPF/CNPJ/telefone)
  const digitsOnly = trimmed.replace(/\D/g, "");
  const isNumericSearch = digitsOnly.length >= 3 && digitsOnly.length === trimmed.replace(/[\s.\-/()]/g, "").length;

  // Para cada token, gera um OR procurando em todos os fields.
  // Para campos *.name e *.title, usa a versao Normalized (lowercase + sem
  // acentos), comparada ao token tambem normalizado. Isso da busca
  // case-insensitive e accent-insensitive em SQLite.
  //
  // Para campos sem versao Normalized (ex: code, description, email),
  // gera 3 variantes do token: original, UPPERCASE e lowercase. Isso
  // cobre case-sensitivity em PostgreSQL (SQLite ja eh case-insensitive
  // em ASCII por default — variantes redundantes mas inofensivas).
  const andClauses: Array<Record<string, unknown>> = tokens.map((token) => {
    const tokenNormalized = normalizeForSearch(token);
    const tokenUpper = token.toUpperCase();
    const tokenLower = token.toLowerCase();
    const orClauses: Array<Record<string, unknown>> = [];
    for (const field of fields) {
      const normalizedField = mapToNormalizedField(field);
      if (normalizedField) {
        // Campo tem versao Normalized: usa ela com token normalizado
        orClauses.push(buildContainsClause(normalizedField, tokenNormalized));
      }
      // Busca no campo original com 3 variantes (case-insensitive defensiva)
      orClauses.push(buildContainsClause(field, token));
      if (tokenUpper !== token) orClauses.push(buildContainsClause(field, tokenUpper));
      if (tokenLower !== token) orClauses.push(buildContainsClause(field, tokenLower));
    }
    // Se o token tem digitos, busca tambem por digitos puros nos campos numericos
    const tokenDigits = token.replace(/\D/g, "");
    if (tokenDigits.length >= 3 && options.numericFields?.length) {
      for (const numField of options.numericFields) {
        orClauses.push(buildContainsClause(numField, tokenDigits));
      }
    }
    return { OR: orClauses };
  });

  // Se a busca inteira eh numerica e tem campos numericos, adiciona a busca
  // pelos digitos puros (ex: "519731-9990" → procura "5197319990")
  if (isNumericSearch && options.numericFields?.length) {
    const numericClauses: Array<Record<string, unknown>> = options.numericFields.map(
      (field) => buildContainsClause(field, digitsOnly),
    );
    andClauses.push({ OR: numericClauses });
  }

  return andClauses;
}

/**
 * Converte um path "tenant.name" em um filtro Prisma aninhado:
 *   { tenant: { name: { contains: "..." } } }
 *
 * Nota: SQLite LIKE eh case-insensitive em ASCII por default. Para
 * PostgreSQL o ideal seria adicionar mode: "insensitive", mas mantemos
 * sem mode aqui pra compatibilidade com SQLite (Prisma lanca erro em
 * runtime se mode for usado com provider sqlite).
 */
function buildContainsClause(
  field: string,
  value: string,
): Record<string, unknown> {
  const parts = field.split(".");
  let current: Record<string, unknown> = { contains: value };
  // Constroi de tras pra frente: para "contract.property.title" gera
  // { contract: { property: { title: { contains: ... } } } }
  for (let i = parts.length - 1; i >= 0; i--) {
    current = { [parts[i]]: current };
  }
  return current;
}
