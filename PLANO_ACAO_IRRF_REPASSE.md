# Plano de ação — IRRF e Repasse antes do pagamento

**Origem:** [ANALISE_IRRF_REPASSE.md](ANALISE_IRRF_REPASSE.md)
**Data:** 2026-05-08
**Objetivo:** corrigir o quanto antes os dois problemas reportados pelo Leo / Anderson, em ordem de impacto × risco.

---

## Estratégia em 4 fases

| Fase | Quando | Esforço | Resultado visível |
|---|---|---|---|
| 0 — Mitigação imediata | Hoje | 1h | Lista dos IRRFs aplicados errado + comunicação ao cliente |
| 1 — Aviso "Boleto não pago" | 1–2 dias | 4–6h | Tela de repasses mostra status real do boleto |
| 2 — IRRF consolidado por CPF/mês + split de repasse | 3–6 dias | 18–22h | Cálculo correto + migração + split de pagamento (caso Roberta) |
| 3 — Cleanup e proteções | Conforme | 4h | Schema com FK, testes, idempotência |

Cada fase entrega valor sozinha. Pode parar em qualquer ponto sem deixar o sistema inconsistente.

---

## FASE 0 — Mitigação imediata (HOJE)

**Meta:** parar o sangramento e dar visibilidade ao cliente sem mexer em código.

### 0.1 Rodar auditoria de IRRF aplicado errado
- **Endpoint:** `GET /api/admin/audit-irrf?dry=1`
- **Arquivo:** [apps/web/src/app/api/admin/audit-irrf/route.ts:1-315](apps/web/src/app/api/admin/audit-irrf/route.ts:1)
- **Saída esperada:** JSON com 3 categorias — `OWNER_PJ`, `TENANT_PF`, `ABAIXO_PISO`.
- **Ação:** exportar a lista, mandar para o Leo, alinhar quais Payments podem ser corrigidos.
- **Pronto quando:** lista revisada e aprovada pelo cliente.

### 0.2 Aplicar correção nos casos aprovados
- **Endpoint:** `POST /api/admin/audit-irrf?apply=1`
- **Efeito:** zera `irrfValue`, recalcula `netToOwner` nos Payments listados.
- **Pronto quando:** consulta de auditoria volta vazia para esses casos.

### 0.3 Comunicação ao cliente
Mandar o resumo executivo do [ANALISE_IRRF_REPASSE.md](ANALISE_IRRF_REPASSE.md) para o Leo + cronograma das fases 1 e 2 com data prometida.

---

## FASE 1 — Aviso "Boleto não pago" na tela de repasses (1–2 dias)

**Meta:** o admin nunca mais transfere um proprietário sem saber que o boleto está aberto. Escopo pequeno, alta percepção pelo cliente.

### 1.1 API `/api/repasses` — incluir status do Payment de origem
- **Arquivo:** [apps/web/src/app/api/repasses/route.ts:14-20](apps/web/src/app/api/repasses/route.ts:14)
- **Mudança:** depois do `findMany` de OwnerEntry, fazer um segundo `findMany` em Payment com os pares `(contractId, dueDate)` dos repasses e mapear `paymentStatus` + `paymentPaidAt` em cada entry no payload.
- Implementar como JOIN em memória — evita mexer no schema agora.
- **Pronto quando:** `GET /api/repasses` devolve cada entry com `paymentStatus: "PAGO" | "PENDENTE" | "ATRASADO" | null`.

### 1.2 UI — badge de status do boleto
- **Arquivo:** [apps/web/src/app/(dashboard)/repasses/page.tsx](apps/web/src/app/(dashboard)/repasses/page.tsx)
- **Locais:**
  - Desktop tabela expandida — linhas 1624–1687 (badge ao lado do status do entry)
  - Mobile cards — linhas 1226–1262
- **Regras:**
  - `paymentStatus === "PAGO"` → não mostra nada (status atual já basta)
  - `paymentStatus === "PENDENTE"` → badge âmbar `⏳ Boleto não pago`
  - `paymentStatus === "ATRASADO"` → badge vermelho `⚠️ Boleto vencido`
  - `paymentStatus === null` (entry sem Payment correspondente) → badge cinza `Sem boleto vinculado`
- **Pronto quando:** abrir `/repasses` e ver os badges aparecendo nos lançamentos certos.

### 1.3 Filtro/aba "Aguardando pagamento"
- Mesma página, ao redor das abas existentes (`pix`/`ted`/`pagos`).
- Nova aba que filtra entries com `paymentStatus !== "PAGO"`.
- **Pronto quando:** o admin consegue ver, em uma aba só, tudo que está travado esperando inquilino.

### 1.4 Desabilitar botão "Marcar como repassado" quando boleto não pago
- Mesmo arquivo, no botão de ação de cada entry.
- `disabled={entry.paymentStatus !== "PAGO"}` + tooltip "Aguardando pagamento do inquilino".
- **Pronto quando:** botão fica desativado nos repasses pendentes de boleto.

### 1.5 Verificação manual
- Caso A: boleto PAGO → badge não aparece, botão habilitado.
- Caso B: boleto PENDENTE → badge âmbar, botão desabilitado.
- Caso C: boleto ATRASADO → badge vermelho.
- Caso D: rodar `/api/repasses/sync` e revalidar.

**Critério de release Fase 1:** os 4 casos manuais ok em staging, deploy em prod, Leo confirma que enxerga.

---

## FASE 2 — IRRF consolidado por CPF/mês (3–5 dias)

**Meta:** corrigir definitivamente o cálculo do IRRF para somar por CPF do proprietário antes de aplicar a tabela.

### 2.1 Refatorar `/api/billing/generate` — não calcular IRRF na geração
- **Arquivo:** [apps/web/src/app/api/billing/generate/route.ts:364-381](apps/web/src/app/api/billing/generate/route.ts:364)
- **Mudança:** continuar gravando `grossToOwner`, mas deixar `irrfValue=null`, `irrfRate=null`, `netToOwner=grossToOwner`. O OwnerEntry.notes correspondente também sai sem IRRF.
- **Pronto quando:** novos boletos gerados saem com IRRF zerado e marcados como "pendente de consolidação" (pode ser um campo `irrfStatus: "PENDING"` no Payment, ou inferir por `irrfValue IS NULL`).

### 2.2 Novo helper `consolidateIRRFByOwnerMonth`
- **Arquivo novo:** `apps/web/src/lib/fiscal-consolidate.ts`
- **Assinatura:**
  ```ts
  consolidateIRRFByOwnerMonth(input: {
    refMonth: Date;       // primeiro dia do mês de competência
    ownerCpfCnpj?: string; // opcional: rodar para um CPF só
    dryRun?: boolean;
  }): Promise<ConsolidationReport>
  ```
- **Lógica:**
  1. `Payment.findMany` no mês onde `owner.personType === "PF"` e `tenant.personType === "PJ"`.
  2. Agrupar por `owner.cpfCnpj`.
  3. Para cada grupo: `soma = sum(grossToOwner)`. Aplicar `calculateIRRF(soma, refMonth)` → `irrfTotal`.
  4. Distribuir `irrfTotal` proporcionalmente sobre `grossToOwner` de cada Payment do grupo (round half-even no centavo, ajustar última diferença no Payment de maior valor para evitar drift).
  5. Atualizar `Payment.irrfValue`, `Payment.irrfRate`, `Payment.netToOwner` e o `OwnerEntry.notes` correspondente.
  6. Idempotente: rodar duas vezes dá o mesmo resultado.
- **Pronto quando:** testes unitários cobrem os 5 casos abaixo.

### 2.3 Testes unitários
- **Arquivo novo:** `apps/web/src/lib/fiscal-consolidate.test.ts`
- Casos obrigatórios:
  1. 1 imóvel R$ 2.166,66, tenant PJ, owner PF → IRRF = 0 (abaixo do piso 2025).
  2. 2 imóveis mesmo CPF, R$ 2.000 cada, soma R$ 4.000 → aplica tabela na soma; IRRF distribuído 50/50.
  3. 3 imóveis mesmo CPF, valores diferentes, soma > piso → distribuição proporcional, soma das partes = IRRF total (sem drift).
  4. 1 imóvel inquilino PF → IRRF = 0 (não entra no grupo).
  5. 1 imóvel inquilino PJ + 1 imóvel inquilino PF mesmo CPF de owner → só o do PJ entra no grupo; o PF fica zerado.
  6. Tabela de transição 2026 (piso R$ 5.000, faixa R$ 5.000,01–R$ 7.350 com redução parcial — linhas 71–74 de fiscal.ts).

### 2.4 Endpoint `POST /api/billing/consolidate-irrf`
- **Arquivo novo:** `apps/web/src/app/api/billing/consolidate-irrf/route.ts`
- **Body:** `{ refMonth: "2026-05", dryRun?: boolean, ownerCpfCnpj?: string }`
- **Auth:** apenas ADMIN.
- **Resposta:** relatório com grupos, soma por CPF, IRRF aplicado, distribuição.
- **Pronto quando:** rodar contra mês teste em staging com dados reais devolve relatório consistente; com `dryRun=false` os Payments do mês ficam atualizados.

### 2.5 Integração com fluxo de geração de boletos
- Ao final do `POST /api/billing/generate`, chamar automaticamente `consolidateIRRFByOwnerMonth({ refMonth })` para o mês recém-gerado.
- **Pronto quando:** clicar "Gerar boletos" deixa o IRRF já consolidado.

### 2.6 UI — botão manual de consolidação
- Tela `/financeiro` (provavelmente em [apps/web/src/app/(dashboard)/financeiro/page.tsx](apps/web/src/app/(dashboard)/financeiro/page.tsx) — admin only).
- Botão "Reconsolidar IRRF do mês".
- Mostra preview (dryRun=true) → confirma → aplica.
- **Pronto quando:** admin consegue rodar manualmente e ver o relatório.

### 2.7 Migração de dados existentes
- Rodar `consolidateIRRFByOwnerMonth` para cada mês com Payments já gerados (script ou várias chamadas via UI).
- Antes: snapshot do banco (export Prisma ou backup do .db).
- Reusar / estender [apps/web/src/app/api/admin/audit-irrf/route.ts](apps/web/src/app/api/admin/audit-irrf/route.ts) para não rodar duas vezes em registros já zerados.
- **Pronto quando:** auditoria devolve zero "ABAIXO_PISO" e zero "soma do CPF abaixo do piso" no histórico.

### 2.8 UI — exibição do IRRF consolidado no recibo
- Tela `/repasses`, card de detalhe do proprietário no mês.
- Mostrar: "Aluguéis do mês: R$ X (Y imóveis) — IRRF retido: R$ Z (taxa W%)".
- Tooltip: "IRRF calculado sobre o total recebido pelo CPF no mês, conforme legislação".
- **Pronto quando:** Leo abre o repasse e enxerga o cálculo agregado.

### 2.9 Split de repasse por beneficiários (caso Roberta)

**Conceito** — destinos secundários de pagamento sem efeito fiscal. O Owner segue sendo o único contribuinte (IRRF, contrato, DIRF, recibo, tudo no CPF dele). Os beneficiários só dividem o líquido na hora do PIX.

**Decisões fechadas com o cliente:**
- Cadastro no nível do **Owner** (vale pra todos os imóveis dele).
- Até **3 beneficiários extras** por Owner.
- Percentuais **fixos no cadastro** (não muda mês a mês; se mudar, admin edita).
- O Owner é destino implícito: recebe `100% − soma dos beneficiários`.
- Sem beneficiários cadastrados → comportamento atual (100% pro PIX do Owner).

**Schema (prisma)** — [prisma/schema.prisma](prisma/schema.prisma):
```prisma
model OwnerPayoutBeneficiary {
  id           String   @id @default(cuid())
  ownerId      String
  owner        Owner    @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  name         String
  pixKey       String
  pixKeyType   String   // CPF, CNPJ, EMAIL, PHONE, RANDOM
  percentage   Float    // 0 < x <= 100
  order        Int      @default(0)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([ownerId])
}

model Owner {
  // ... campos existentes
  payoutBeneficiaries OwnerPayoutBeneficiary[]
}
```

**Regras de validação** (no endpoint de criação/edição do Owner):
- Máximo 3 registros por Owner.
- Cada percentual: `0 < p <= 100`.
- Soma dos percentuais entre registros do mesmo Owner: `0 < soma <= 100` (o restante vai pro Owner).

**Lógica no repasse** — após `consolidateIRRFByOwnerMonth` (Fase 2.2), antes de gerar o pagamento PIX:
1. Pega `netToOwner` final do Owner no mês.
2. Para cada beneficiário: `valor_b = round(netToOwner × percentage / 100, 2)` com banker's rounding.
3. Owner recebe: `valor_owner = netToOwner − soma(valor_b)` (absorve drift de centavos).
4. Cria/atualiza `OwnerEntry` REPASSE com `notes.payoutSplit` contendo a divisão:
   ```json
   {
     "splits": [
       { "name": "Roberta",  "pixKey": "...", "percentage": 70, "value": 1400.00 },
       { "name": "Irmã M.", "pixKey": "...", "percentage": 30, "value":  600.00 }
     ]
   }
   ```

**UI** — formulário de Owner ([apps/web/src/app/(dashboard)/proprietarios/](apps/web/src/app/(dashboard)/proprietarios/)):
- Nova seção "Divisão do repasse" com botão "+ Adicionar beneficiário" (até 3).
- Cada linha: Nome | Tipo de chave PIX | Chave PIX | Percentual (%).
- Texto dinâmico abaixo: "Restante para [nome do owner]: X%" recalculado em tempo real.
- Validação inline antes do submit.

**UI no recibo de repasse** — [apps/web/src/app/(dashboard)/repasses/page.tsx](apps/web/src/app/(dashboard)/repasses/page.tsx):
- Quando `notes.payoutSplit` existir, mostrar seção "Divisão do pagamento" com cada destino, PIX (mascarado) e valor.

**Testes**
- Owner sem beneficiários → 100% pro PIX do Owner (comportamento atual).
- Owner + 1 beneficiário 30% → Owner 70%, beneficiário 30%.
- Owner + 3 beneficiários (30/20/10) → Owner 40%.
- Soma > 100 → 400 do endpoint.
- Drift de centavos: 3 beneficiários × 33% sobre R$ 1.000,01 → soma das partes = R$ 1.000,01.
- IRRF do Owner não muda em função do split (split é pós-IRRF).

**Esforço estimado:** +6h sobre a Fase 2.

**Critério de release Fase 2:** todos os testes passam, migração rodada, Leo valida 3 proprietários reais (incluindo a Roberta com split funcionando).

---

## FASE 3 — Cleanup e proteções (conforme tempo)

### 3.1 FK OwnerEntry → Payment
- **Arquivo:** [prisma/schema.prisma:615-656](prisma/schema.prisma:615)
- Adicionar `sourcePaymentId String?` + relação opcional.
- Migration: popular `sourcePaymentId` em registros antigos via match `(contractId, dueDate)`.
- Substituir o JOIN em memória da Fase 1.1 por `include: { sourcePayment: true }`.

### 3.2 Webhook Sicredi → garantia de consistência
- Localizar/auditar handler do webhook (provavelmente [apps/web/src/app/api/payments/](apps/web/src/app/api/payments/)).
- Garantir que ao marcar Payment como PAGO, dispara a UI sem precisar do sync manual.
- Não precisa mais alterar OwnerEntry.status — o JOIN da Fase 1 cuida da exibição.

### 3.3 Deprecar `/api/repasses/sync` manual
- Após Fase 1+2 estáveis, marcar como deprecated; manter botão escondido para fallback.

### 3.4 Testes E2E
- Cypress/Playwright: gerar boletos → simular webhook PAGO → verificar UI de repasses.

---

## Cronograma sugerido

| Dia | Atividade |
|---|---|
| Hoje (D0) | Fase 0 completa — comunicação ao cliente |
| D+1 | Fase 1.1 + 1.2 (API + badge) |
| D+2 | Fase 1.3 + 1.4 + verificação + deploy Fase 1 |
| D+3 | Fase 2.1 + 2.2 (refactor + helper) |
| D+4 | Fase 2.3 (testes) + 2.4 (endpoint) |
| D+5 | Fase 2.5 + 2.6 (integração + UI) |
| D+6 | Fase 2.7 (migração) + 2.8 (UI recibo) |
| D+7 | Fase 2.9 (split de repasse — caso Roberta) + deploy Fase 2 |
| D+8+ | Fase 3 conforme prioridade do cliente |

---

## Riscos e como mitigar

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Migração da Fase 2.7 corromper IRRF correto | Média | `dryRun=true` obrigatório antes de aplicar; rodar mês a mês; backup antes |
| Drift de centavos na distribuição proporcional | Alta | Round half-even + ajuste no Payment de maior valor; teste 2.3.3 cobre |
| Mudança de tabela 2026 (Lei 15.270/2025) com faixa de transição | Já tratada | [fiscal.ts:71-74](apps/web/src/lib/fiscal.ts:71) já implementa; teste 2.3.6 |
| Webhook do banco sobrescrever IRRF consolidado | Baixa | Webhook só mexe em `Payment.status`/`paidAt`, não em `irrfValue` |
| Dois admins rodando consolidação ao mesmo tempo | Baixa | Lock por `(refMonth, ownerCpfCnpj)`; idempotência absorve |

---

## O que NÃO está neste plano (decisão consciente)

- Reescrita do schema do `OwnerEntry` (deixei para Fase 3 — não é bloqueante).
- Cálculo por **fonte pagadora** (inquilino) em vez de por CPF do proprietário — o cliente pediu por CPF; é simplificação razoável e pró-proprietário.
- Tela de configuração de tabela IRRF — as tabelas estão no código, mudar requer deploy. Aceitável dado o ritmo de mudança da legislação.
- Geração de informe de rendimentos anual no formato DIRF/DIRPF — fora do escopo dos dois problemas reportados.
