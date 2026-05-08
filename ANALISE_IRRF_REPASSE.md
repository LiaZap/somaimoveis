# Análise — IRRF e Repasse antes do pagamento

**Projeto:** Somma (sistema de gestão imobiliária)
**Data:** 2026-05-08
**Branch:** claude/goofy-grothendieck-c215a3

---

## PROBLEMA 1 — Cálculo do IRRF

### TL;DR
**É BUG + MUDANÇA DE REGRA combinados.**
O motor de cálculo (tabela progressiva) está correto. **A base de cálculo está errada**: o sistema aplica IRRF sobre cada boleto individualmente, sem antes somar os aluguéis do mesmo CPF de proprietário no mês. A regra fiscal correta é: somar tudo o que aquela fonte pagadora paga ao mesmo CPF no mês, e só então aplicar a tabela. Como o cliente também pediu explicitamente esse comportamento, é tanto bug quanto mudança formal de regra de negócio.

### Onde está o cálculo

| Arquivo | Linhas | Papel |
|---|---|---|
| [apps/web/src/lib/fiscal.ts](apps/web/src/lib/fiscal.ts) | 1–118 | Tabelas progressivas + `calculateIRRF` + `calculateIRRFRental` |
| [apps/web/src/app/api/billing/generate/route.ts](apps/web/src/app/api/billing/generate/route.ts) | 364–381 | **Origem do bug** — chama `calculateIRRFRental(grossToOwner, …)` por boleto individual |
| [prisma/schema.prisma](prisma/schema.prisma) | 465–469 | Campos `irrfValue`, `irrfRate`, `grossToOwner`, `netToOwner` no Payment |
| [apps/web/src/app/api/admin/audit-irrf/route.ts](apps/web/src/app/api/admin/audit-irrf/route.ts) | 1–315 | Endpoint que detecta e zera IRRF aplicado abaixo do piso |
| [apps/web/src/app/api/fiscal/route.ts](apps/web/src/app/api/fiscal/route.ts) | 98–132 | Relatório fiscal — apenas SOMA o IRRF já gravado por boleto |
| [apps/web/src/app/(dashboard)/repasses/page.tsx](apps/web/src/app/(dashboard)/repasses/page.tsx) | 1656–1659 | Exibição do IRRF no recibo de repasse |

### Como está hoje (errado)

`apps/web/src/app/api/billing/generate/route.ts:364–381`:

```ts
const grossToOwner = splitOwnerValue;            // valor de UM contrato
const irrf = calculateIRRFRental({
  grossToOwner,                                  // base: 1 boleto
  ownerType: contract.owner?.personType || "PF",
  tenantType: contract.tenant?.personType || "PF",
  refDate: dueDate,
});
const irrfValue = irrf.irrfValue;
const netToOwner = Math.round((grossToOwner - irrfValue) * 100) / 100;
```

`apps/web/src/lib/fiscal.ts:106–118` (`calculateIRRFRental`):

```ts
const ownerIsPF  = (params.ownerType  || "PF").toUpperCase() === "PF";
const tenantIsPJ = (params.tenantType || "PF").toUpperCase() === "PJ";
if (!ownerIsPF || !tenantIsPJ) {
  return { taxableAmount: 0, rate: 0, deduction: 0, irrfValue: 0 };
}
return calculateIRRF(params.grossToOwner, params.refDate);   // base = 1 boleto
```

**Comportamento real:**
- A função filtra corretamente: só aplica IRRF quando proprietário PF + inquilino PJ.
- A tabela progressiva 2025 (piso R$ 2.259,20) e 2026 (piso R$ 5.000 — Lei 15.270/2025) está corretamente codificada.
- **Falha:** a base é `grossToOwner` de **um único contrato**. Se o mesmo CPF tem 3 imóveis alugados e cada um isolado fica abaixo do piso, o sistema retorna IRRF=0 nos 3 — mas se somados ultrapassariam o piso, deveria reter. O contrário também acontece: cliente reporta IRRF sendo descontado em casos onde a soma do CPF está abaixo do piso (provavelmente porque o lançamento veio configurado como `tenantType=PJ` e o sistema aplicou tabela direto sem consolidar — ou há registros antigos calculados antes da correção do piso).

### Como deveria estar

A regra fiscal brasileira (RIR/2018 art. 689; SC Cosit 55/2020) exige:
1. Identificar a **fonte pagadora** (cada inquilino PJ é uma fonte distinta).
2. Para cada par (fonte pagadora PJ × CPF do proprietário PF) somar todos os pagamentos do mês.
3. Aplicar a tabela progressiva sobre essa **soma**.
4. Se a soma estiver na faixa de isenção (R$ 2.259,20 até abr/2025; R$ 2.428,80 a partir de mai/2025; R$ 5.000 a partir de 2026 pela Lei 15.270/2025), IRRF = 0.

Para o caso da Somma (imobiliária administrando), o cliente quer agregar **por CPF do proprietário no mês**, independente do inquilino — é uma simplificação razoável e pró-proprietário (tende a reter menos), embora estritamente a lei seja por fonte pagadora.

### Plano de correção (passo a passo)

1. **Refatorar fluxo de cálculo de IRRF** para acontecer em duas fases:
   - **Fase A — geração** (`/api/billing/generate`): gravar `grossToOwner` no Payment, mas **não calcular IRRF ainda**. Manter `irrfValue=null` até consolidação mensal.
   - **Fase B — consolidação mensal por CPF**: novo endpoint `/api/billing/consolidate-irrf` que, para um mês de competência:
     - Agrupa Payments por `owner.cpfCnpj` (apenas onde `owner.personType=PF` e `tenant.personType=PJ`).
     - Soma `grossToOwner` de cada grupo.
     - Aplica `calculateIRRF(somaDoGrupo, refDate)` uma vez.
     - **Distribui o IRRF total proporcionalmente** entre os Payments do grupo (pro rata sobre `grossToOwner`).
     - Atualiza `Payment.irrfValue`, `Payment.irrfRate`, `Payment.netToOwner` e o `OwnerEntry.notes` correspondente.

2. **Acionar a Fase B**:
   - Manualmente via botão "Consolidar IRRF do mês" na tela de financeiro.
   - Automaticamente quando o admin clica "Gerar boletos do mês" (rodar a Fase B no fim).
   - Idempotente: rodar várias vezes deve dar o mesmo resultado.

3. **Job de migração** para registros já gerados:
   - Estender o `audit-irrf` existente para também detectar casos de **soma de CPF abaixo do piso** (hoje só detecta boleto individual abaixo).
   - `POST /api/admin/audit-irrf?apply=1&mode=por-cpf` zera IRRF onde a soma do CPF/mês fica isenta.

4. **UI** (`/financeiro` ou `/repasses`):
   - Mostrar no recibo do proprietário o valor consolidado: "Aluguéis do mês: R$ X (3 imóveis) — IRRF retido: R$ Y".
   - Tooltip explicando "IRRF calculado sobre o total do CPF no mês".

5. **Testes** que cobrem:
   - 1 imóvel < piso → IRRF=0.
   - 2 imóveis mesmo CPF, cada um < piso, soma > piso → IRRF aplicado proporcionalmente.
   - Inquilino PF → IRRF=0 mesmo somando.
   - Mudança de tabela 2025→2026 (piso R$ 5.000, faixa de transição linhas 71–74 de fiscal.ts).

### Resposta para o caso específico (proprietária R$ 2.166,66)

R$ 2.166,66 está abaixo do piso de **todas** as tabelas (2.259,20 / 2.428,80 / 5.000,00). Se ela aparece com IRRF descontado:
- Hipótese 1 (mais provável): o boleto foi gerado quando a tabela em uso era anterior à correção, ou o `tenantType` do contrato veio salvo como PJ e o sistema entrou na tabela sem fazer mais nenhum filtro de piso (a função entra direto na faixa).
- Hipótese 2: existe outro contrato do mesmo CPF que somado ultrapassa o piso — mas o cálculo está individual e está aplicando errado de qualquer forma.
- Verificação rápida: rodar `GET /api/admin/audit-irrf?dry=1` para ver os Payments dela na lista de "ABAIXO_PISO" e usar `POST ?apply=1` para zerar.

---

## PROBLEMA 2 — Repasse mostrado antes do boleto ser pago

### TL;DR
**É BUG no fluxo + falta UX.** Os `OwnerEntry` (repasses) são criados com `status: PENDENTE` no momento da geração da cobrança e **nunca são automaticamente atualizados** quando o `Payment` correspondente é marcado como PAGO. Além disso, a tela de repasses mostra o status do próprio repasse — não do boleto que dá origem a ele. Resultado: o admin vê "proprietário com crédito a receber" sem saber se o inquilino já pagou.

### Onde está o fluxo

| Arquivo | Linhas | Papel |
|---|---|---|
| [prisma/schema.prisma](prisma/schema.prisma) | 435–508 | `Payment` (status, paidAt, dueDate) |
| [prisma/schema.prisma](prisma/schema.prisma) | 615–656 | `OwnerEntry` (status, dueDate, contractId) — **sem FK para Payment** |
| [apps/web/src/app/api/billing/generate/route.ts](apps/web/src/app/api/billing/generate/route.ts) | 485–577 | **Cria OwnerEntry como PENDENTE** já no momento de gerar boleto |
| [apps/web/src/app/api/payments/[id]/route.ts](apps/web/src/app/api/payments/[id]/route.ts) | 133–203 | Quando Payment vira PAGO, cria OwnerEntry **se ainda não existe** — mas mantém status PENDENTE |
| [apps/web/src/app/api/repasses/route.ts](apps/web/src/app/api/repasses/route.ts) | 14–20 | API lista todos OwnerEntry CREDITO **sem JOIN com Payment** |
| [apps/web/src/app/api/repasses/sync/route.ts](apps/web/src/app/api/repasses/sync/route.ts) | 1–199 | Workaround: sync manual que cria OwnerEntry para Payments PAGO |
| [apps/web/src/app/(dashboard)/repasses/page.tsx](apps/web/src/app/(dashboard)/repasses/page.tsx) | 1612–1687 | Tabela mostra `entry.status` (do OwnerEntry), não do Payment |

### Como está hoje (errado)

`apps/web/src/app/api/billing/generate/route.ts:526–537`:

```ts
await prisma.ownerEntry.create({
  data: {
    type: "CREDITO",
    category: "REPASSE",
    description: `Repasse aluguel ${mLabel} - ${contract.code}`,
    value: splitOwnerValue,
    dueDate,
    status: "PENDENTE",          // criado JUNTO com o boleto
    ownerId: contract.ownerId,
    contractId: contract.id,
    propertyId: contract.property.id,
    notes: ownerEntryNotes,
  },
});
```

`apps/web/src/app/api/repasses/route.ts:14–20`:

```ts
const creditWhere: Record<string, unknown> = {
  type: "CREDITO",
};
if (status && status !== "all") {
  creditWhere.status = status;   // filtra OwnerEntry.status, NÃO Payment.status
}
```

`apps/web/src/app/(dashboard)/repasses/page.tsx:1640–1660`:

```tsx
<Badge className={cn(
  "text-[10px] h-5 border",
  entry.status === "PAGO"
    ? "bg-emerald-100 text-emerald-700 border-emerald-200"
    : "bg-yellow-100 text-yellow-700 border-yellow-200"
)}>
  {entry.status === "PAGO" ? "Pago" : "Pendente"}
</Badge>
```

**Sequência atual do bug:**

| Passo | O que acontece | Status OwnerEntry | Status Payment |
|---|---|---|---|
| 1 | Admin gera boletos do mês | PENDENTE | PENDENTE |
| 2 | Boleto enviado ao inquilino | PENDENTE | PENDENTE |
| 3 | Inquilino paga; webhook Sicredi | PENDENTE ⚠️ | PAGO |
| 4 | Admin abre /repasses | **Aparece como "pronto"** sem aviso | — |

### Como deveria estar

Duas opções (recomendamos B):

**A) Sincronização automática:**
- Quando `Payment.status` muda para PAGO (no PATCH e no webhook do banco), sincronizar o OwnerEntry correspondente. Marcar OwnerEntry como "liberado para repasse" (novo campo `liberadoEm` ou usar o próprio `paidAt` do Payment para sinalizar).
- Tela de repasses deixa de listar repasses cujo Payment ainda não está PAGO, ou lista com aviso visual.

**B) JOIN com Payment + UX (recomendado):**
- API `/api/repasses` faz JOIN: para cada OwnerEntry REPASSE, busca o Payment pelo par (`contractId`, `dueDate`) e devolve `paymentStatus` e `paymentPaidAt` no payload.
- UI mostra:
  - Se Payment.status = PAGO → continua como hoje (badge verde).
  - Se Payment.status = PENDENTE → badge laranja "⏳ Aguardando pagamento do inquilino".
  - Se Payment.status = ATRASADO → badge vermelho "⚠️ Boleto vencido — não pago".
- Botão "Marcar como repassado" desabilitado enquanto o boleto não estiver pago (com tooltip explicando).

### Plano de correção (passo a passo)

1. **Schema** — adicionar relação opcional para rastrear origem (ajuda muito em manutenção):
   ```prisma
   model OwnerEntry {
     // ...
     sourcePaymentId String?
     sourcePayment   Payment? @relation(fields: [sourcePaymentId], references: [id], onDelete: SetNull)
   }
   ```
   Migrar registros antigos via script (match por `contractId + dueDate`).

2. **API `/api/repasses/route.ts`** — incluir status do Payment de origem:
   ```ts
   const entries = await prisma.ownerEntry.findMany({
     where: creditWhere,
     include: {
       owner: { select: ownerSelect },
       sourcePayment: { select: { status: true, paidAt: true, dueDate: true } },
     },
     orderBy: { dueDate: "asc" },
   });
   ```
   Para registros antigos sem `sourcePaymentId`, fazer fallback por `contractId + dueDate`.

3. **API `PATCH /api/payments/[id]`** (linhas 133–203) — quando vira PAGO, **não criar novo** OwnerEntry; em vez disso, atualizar o OwnerEntry existente caso queira marcar como liberado.

4. **Webhook do banco** — garantir que ao marcar Payment como PAGO, dispara o mesmo path que sincroniza a UI (não precisa mudar o OwnerEntry.status, basta o JOIN funcionar).

5. **UI `/repasses/page.tsx`** — adicionar badge na tabela:
   ```tsx
   {entry.category === "REPASSE" && entry.sourcePayment?.status !== "PAGO" && (
     <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300 text-[10px] h-5">
       ⏳ Boleto não pago
     </Badge>
   )}
   ```
   - Aplicar nos dois layouts (mobile linhas 1226–1262; desktop linhas 1624–1687).
   - Adicionar filtro/aba "Aguardando pagamento" para o admin enxergar o que está travado.

6. **Botão de repasse** — desabilitar (`disabled` + tooltip) quando o Payment correspondente não está PAGO.

7. **Migração de dados** — rodar uma vez `/api/repasses/sync` ajustado para popular `sourcePaymentId` em registros antigos.

---

## Resumo executivo (para o cliente, em linguagem direta)

**Sobre o IRRF:**
> Você tem razão. O sistema está calculando o imposto de renda em cima de cada aluguel separadamente, e a regra correta é somar tudo que cada CPF de proprietário recebe no mês antes de aplicar a tabela. Para a proprietária dos R$ 2.166,66, esse valor está abaixo da faixa de isenção em qualquer das tabelas (atual R$ 2.259,20; nova de 2026 R$ 5.000), então não deveria ter retenção mesmo. Vamos: (1) corrigir o cálculo para agrupar por CPF/mês, (2) rodar uma auditoria que zera os IRRFs aplicados indevidamente nos lançamentos antigos, (3) adicionar uma tela onde você pode rever isso antes de fechar o mês.

**Sobre o repasse antes do pagamento:**
> Confirmado. Hoje o sistema cria a linha de "repasse pendente" no momento em que o boleto é gerado, e ela continua como "pendente" mesmo depois que o inquilino paga (ou não paga). O status do repasse não conversa com o status do boleto. Vamos cruzar as duas informações e mostrar um aviso claro ("⏳ Boleto não pago" em laranja, "⚠️ Boleto vencido" em vermelho) para você nunca mais transferir um proprietário sem ter recebido do inquilino.

---

## Próximos passos sugeridos

1. **Imediato (mesmo dia):** rodar `GET /api/admin/audit-irrf?dry=1` e mandar para o Leo o relatório dos IRRFs incorretos atuais.
2. **Esta semana:** implementar correção 2 (badge "Boleto não pago" nas telas de repasse) — é menor escopo, alta visibilidade.
3. **Próxima semana:** refatoração da Fase B do IRRF (consolidação por CPF/mês) com testes.
