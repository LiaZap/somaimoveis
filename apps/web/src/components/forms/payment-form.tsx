"use client";

import { useEffect, useState, useRef } from "react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Trash2, Plus, ChevronsUpDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

const paymentSchema = z.object({
  code: z.string().default("AUTO"),
  contractId: z.string().min(1, "Contrato é obrigatório"),
  tenantId: z.string().min(1, "Locatário é obrigatório"),
  ownerId: z.string().min(1, "Proprietário é obrigatório"),
  value: z.coerce.number().min(0.01, "Valor é obrigatório"),
  paidValue: z.coerce.number().optional(),
  fineValue: z.coerce.number().optional(),
  interestValue: z.coerce.number().optional(),
  discountValue: z.coerce.number().optional(),
  intermediationFee: z.coerce.number().optional(),
  dueDate: z.string().min(1, "Data de vencimento é obrigatória"),
  paidAt: z.string().optional(),
  status: z.string().default("PENDENTE"),
  paymentMethod: z.string().optional(),
  description: z.string().optional(),
  splitOwnerValue: z.coerce.number().optional(),
  splitAdminValue: z.coerce.number().optional(),
  notes: z.string().optional(),
});

type PaymentFormData = z.infer<typeof paymentSchema>;

interface PaymentFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment?: any;
  onSuccess: () => void;
}

interface ContractOption {
  id: string;
  code: string;
  rentalValue: number;
  adminFeePercent: number;
  tenantId: string;
  ownerId: string;
  startDate: string;
  endDate?: string;
  bankFee?: number;
  insuranceFee?: number;
  paymentDay?: number;
  property: { id: string; title: string; condoFee?: number; iptuValue?: number };
  tenant: { id: string; name: string };
  owner: { id: string; name: string };
}

interface PersonOption {
  id: string;
  name: string;
}

interface TenantEntry {
  id: string;
  type: "CREDITO" | "DEBITO";
  category: string;
  description: string;
  value: number;
  status: string;
  dueDate?: string;
}

function formatBRL(v: number): string {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function PaymentForm({ open, onOpenChange, payment, onSuccess }: PaymentFormProps) {
  const [loading, setLoading] = useState(false);
  const [contracts, setContracts] = useState<ContractOption[]>([]);
  const [owners, setOwners] = useState<PersonOption[]>([]);
  const [tenants, setTenants] = useState<PersonOption[]>([]);
  const [entries, setEntries] = useState<TenantEntry[]>([]);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const [prorataDias, setProrataDias] = useState(30);
  const [manualProrata, setManualProrata] = useState(false);
  const [contractSearchOpen, setContractSearchOpen] = useState(false);
  const [contractSearch, setContractSearch] = useState("");
  const isEditing = !!payment;

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<PaymentFormData>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(paymentSchema) as any,
    defaultValues: {
      code: "",
      contractId: "",
      tenantId: "",
      ownerId: "",
      value: undefined,
      paidValue: undefined,
      fineValue: undefined,
      interestValue: undefined,
      discountValue: undefined,
      intermediationFee: undefined,
      dueDate: "",
      paidAt: "",
      status: "PENDENTE",
      paymentMethod: "",
      description: "",
      splitOwnerValue: undefined,
      splitAdminValue: undefined,
      notes: "",
    },
  });

  const selectedContractId = watch("contractId");
  const selectedTenantId = watch("tenantId");
  const selectedOwnerId = watch("ownerId");
  const selectedStatus = watch("status");
  const selectedPaymentMethod = watch("paymentMethod");
  const watchValue = watch("value");

  // Fetch related data on dialog open
  useEffect(() => {
    async function fetchData() {
      try {
        const [contractsRes, ownersRes, tenantsRes] = await Promise.all([
          fetch("/api/contracts"),
          fetch("/api/owners?includeInactive=true"),
          fetch("/api/tenants?includeInactive=true"),
        ]);

        if (contractsRes.ok) {
          const data = await contractsRes.json();
          setContracts(data);
        }
        if (ownersRes.ok) {
          const data = await ownersRes.json();
          setOwners(data.map((o: any) => ({ id: o.id, name: o.name })));
        }
        if (tenantsRes.ok) {
          const data = await tenantsRes.json();
          setTenants(data.map((t: any) => ({ id: t.id, name: t.name })));
        }
      } catch (error) {
        console.error("Erro ao carregar dados:", error);
      }
    }

    if (open) {
      fetchData();
      setEntries([]);
      setSelectedEntryIds(new Set());
      setProrataDias(30);
      setManualProrata(false);
      setContractSearch("");
    }
  }, [open]);

  // Fetch tenant entries when contract/tenant changes
  useEffect(() => {
    async function fetchEntries() {
      if (!selectedTenantId || isEditing) return;
      try {
        const res = await fetch(`/api/tenant-entries?tenantId=${selectedTenantId}&status=PENDENTE`);
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data) ? data : data.data || [];
          setEntries(list);
          // Select all by default
          setSelectedEntryIds(new Set(list.map((e: TenantEntry) => e.id)));
        }
      } catch {
        setEntries([]);
      }
    }
    fetchEntries();
  }, [selectedTenantId, isEditing]);

  // Code is auto-generated by the API, set placeholder
  useEffect(() => {
    if (open && !isEditing) {
      setValue("code", "AUTO");
    }
  }, [open, isEditing, setValue]);

  const watchDueDate = watch("dueDate");

  // Auto-fill tenant, owner, and recalculate value when contract is selected
  useEffect(() => {
    if (!selectedContractId || isEditing) return;

    const contract = contracts.find((c) => c.id === selectedContractId);
    if (contract) {
      setValue("tenantId", contract.tenantId);
      setValue("ownerId", contract.ownerId);
      recalculateValue(contract, selectedEntryIds);

      // Auto-preencher data de vencimento com paymentDay do contrato
      const currentDueDate = watch("dueDate");
      if (!currentDueDate && contract.paymentDay) {
        const now = new Date();
        let targetMonth = now.getMonth();
        let targetYear = now.getFullYear();
        // Se já passou do dia de vencimento, usar próximo mês
        if (now.getDate() > contract.paymentDay) {
          targetMonth++;
          if (targetMonth > 11) { targetMonth = 0; targetYear++; }
        }
        const day = String(Math.min(contract.paymentDay, new Date(targetYear, targetMonth + 1, 0).getDate())).padStart(2, "0");
        const month = String(targetMonth + 1).padStart(2, "0");
        setValue("dueDate", `${targetYear}-${month}-${day}`);
      }
    }
  }, [selectedContractId, contracts, isEditing, setValue]);

  // Auto-detect pro-rata days when contract or dueDate changes (only if user hasn't manually set)
  useEffect(() => {
    if (!selectedContractId || isEditing || !watchDueDate || manualProrata) return;
    const contract = contracts.find((c) => c.id === selectedContractId);
    if (!contract) return;

    const dueDate = new Date(watchDueDate + "T12:00:00");
    const targetYear = dueDate.getFullYear();
    const targetMonth = dueDate.getMonth();
    const daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate();

    const contractStart = new Date(contract.startDate);
    const csYear = contractStart.getUTCFullYear();
    const csMonth = contractStart.getUTCMonth();
    const csDay = contractStart.getUTCDate();

    let days = 30;

    // Primeiro mês do contrato: início no meio do mês
    if (csYear === targetYear && csMonth === targetMonth && csDay > 1) {
      days = daysInMonth - csDay + 1;
    }

    // Último mês do contrato
    if (contract.endDate) {
      const contractEnd = new Date(contract.endDate);
      const ceYear = contractEnd.getUTCFullYear();
      const ceMonth = contractEnd.getUTCMonth();
      const ceDay = contractEnd.getUTCDate();
      if (ceYear === targetYear && ceMonth === targetMonth && ceDay < daysInMonth) {
        if (days < 30) {
          days = ceDay - csDay + 1;
        } else {
          days = ceDay;
        }
      }
    }

    setProrataDias(days);
  }, [selectedContractId, contracts, watchDueDate, isEditing, manualProrata]);

  // Recalculate when entries, selection, or prorataDias changes
  // IMPORTANTE: NAO recalcula em modo edicao — recalculateValue
  // sobrescreve as notes (com lancamentos), e em edicao
  // selectedEntryIds comeca vazio (nao reidrata das notes), entao
  // qualquer mudanca de outro campo (dueDate, paidAt, etc) ia
  // apagar a lista de lancamentos do breakdown.
  useEffect(() => {
    if (isEditing) return;
    if (!selectedContractId) return;
    const contract = contracts.find((c) => c.id === selectedContractId);
    if (contract) {
      recalculateValue(contract, selectedEntryIds);
    }
  }, [selectedEntryIds, prorataDias, entries, contracts, selectedContractId, isEditing]);

  function recalculateValue(contract: ContractOption, entryIds: Set<string>) {
    const condoFee = contract.property?.condoFee || 0;
    const iptuMonthly = contract.property?.iptuValue
      ? Math.round((contract.property.iptuValue / 12) * 100) / 100
      : 0;
    const bankFee = contract.bankFee || 0;
    const insuranceFee = contract.insuranceFee || 0;

    const isProrata = prorataDias < 30;
    const dailyRate = contract.rentalValue / 30;
    const rentalValue = isProrata
      ? Math.round(dailyRate * prorataDias * 100) / 100
      : contract.rentalValue;

    const selectedEntries = entries.filter(e => entryIds.has(e.id));
    const totalDebits = selectedEntries.filter(e => e.type === "DEBITO").reduce((s, e) => s + e.value, 0);
    const totalCredits = selectedEntries.filter(e => e.type === "CREDITO").reduce((s, e) => s + e.value, 0);

    const total = Math.max(0, Math.round((rentalValue + condoFee + iptuMonthly + bankFee + insuranceFee + totalDebits - totalCredits) * 100) / 100);
    setValue("value", total);

    const adminPercent = contract.adminFeePercent || 10;
    const adminValue = Math.round(rentalValue * (adminPercent / 100) * 100) / 100;
    const ownerValue = Math.round((rentalValue - adminValue) * 100) / 100;
    setValue("splitAdminValue", adminValue);
    setValue("splitOwnerValue", ownerValue);

    if (totalCredits > 0) {
      setValue("discountValue", totalCredits);
    }

    // Build breakdown for notes
    const breakdown: Record<string, unknown> = {
      aluguel: rentalValue,
      aluguelOriginal: isProrata ? contract.rentalValue : undefined,
      isProrata,
      prorataDias: isProrata ? prorataDias : undefined,
      creditos: totalCredits,
      debitos: totalDebits,
      condominio: condoFee,
      iptu: iptuMonthly,
      seguroFianca: insuranceFee,
      taxaBancaria: bankFee,
      total,
    };
    if (selectedEntries.length > 0) {
      breakdown.lancamentos = selectedEntries.map(e => ({
        id: e.id,
        tipo: e.type,
        categoria: e.category,
        descricao: e.description,
        valor: e.value,
      }));
    }
    setValue("notes", JSON.stringify(breakdown));

    // Update description
    if (isProrata) {
      setValue("description", `Aluguel pro-rata (${prorataDias} dias): R$ ${formatBRL(rentalValue)}`);
    }
  }

  // Update notes breakdown when value changes during editing
  const watchNotes = watch("notes");
  useEffect(() => {
    if (!isEditing || !watchValue) return;
    try {
      const current = watchNotes ? JSON.parse(watchNotes) : {};
      if (current.total !== watchValue) {
        current.total = watchValue;
        current.aluguel = watchValue - (current.condominio || 0) - (current.iptu || 0) - (current.seguroFianca || 0) - (current.taxaBancaria || 0) - (current.debitos || 0) + (current.creditos || 0);
        setValue("notes", JSON.stringify(current));
      }
    } catch { /* not JSON notes */ }
  }, [watchValue, isEditing]);

  function toggleEntry(id: string) {
    setSelectedEntryIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAllEntries() {
    if (selectedEntryIds.size === entries.length) {
      setSelectedEntryIds(new Set());
    } else {
      setSelectedEntryIds(new Set(entries.map(e => e.id)));
    }
  }

  // Reset form when opening
  useEffect(() => {
    if (open) {
      if (payment) {
        reset({
          code: payment.code || "",
          contractId: payment.contractId || "",
          tenantId: payment.tenantId || "",
          ownerId: payment.ownerId || "",
          value: payment.value ?? undefined,
          paidValue: payment.paidValue ?? undefined,
          fineValue: payment.fineValue ?? undefined,
          interestValue: payment.interestValue ?? undefined,
          discountValue: payment.discountValue ?? undefined,
          intermediationFee: payment.intermediationFee ?? undefined,
          dueDate: payment.dueDate
            ? new Date(payment.dueDate).toISOString().split("T")[0]
            : "",
          paidAt: payment.paidAt
            ? new Date(payment.paidAt).toISOString().split("T")[0]
            : "",
          status: payment.status || "PENDENTE",
          paymentMethod: payment.paymentMethod || "",
          description: payment.description || "",
          splitOwnerValue: payment.splitOwnerValue ?? undefined,
          splitAdminValue: payment.splitAdminValue ?? undefined,
          notes: payment.notes || "",
        });
        // Load prorataDias from existing breakdown
        if (payment.notes) {
          try {
            const b = JSON.parse(payment.notes);
            if (b.prorataDias) setProrataDias(b.prorataDias);
          } catch {}
        }
      } else {
        reset({
          code: "",
          contractId: "",
          tenantId: "",
          ownerId: "",
          value: undefined,
          paidValue: undefined,
          fineValue: undefined,
          interestValue: undefined,
          discountValue: undefined,
          intermediationFee: undefined,
          dueDate: "",
          paidAt: "",
          status: "PENDENTE",
          paymentMethod: "",
          description: "",
          splitOwnerValue: undefined,
          splitAdminValue: undefined,
          notes: "",
        });
      }
    }
  }, [open, payment, reset]);

  async function onSubmit(data: PaymentFormData) {
    setLoading(true);
    try {
      // Validar data
      const dueDateObj = new Date(data.dueDate + "T12:00:00");
      if (isNaN(dueDateObj.getTime()) || dueDateObj.getFullYear() < 2020 || dueDateObj.getFullYear() > 2100) {
        toast.error("Data de vencimento inválida. Verifique o ano.");
        setLoading(false);
        return;
      }

      const url = isEditing ? `/api/payments/${payment.id}` : "/api/payments";
      const method = isEditing ? "PUT" : "POST";

      const payload = {
        ...data,
        dueDate: data.dueDate + "T12:00:00",
        paidAt: data.paidAt ? data.paidAt + "T12:00:00" : null,
        paidValue: data.paidValue || null,
        fineValue: data.fineValue || null,
        interestValue: data.interestValue || null,
        discountValue: data.discountValue || null,
        intermediationFee: data.intermediationFee || null,
        paymentMethod: data.paymentMethod || null,
        description: data.description || null,
        splitOwnerValue: data.splitOwnerValue || null,
        splitAdminValue: data.splitAdminValue || null,
        notes: data.notes || null,
      };

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Erro ao salvar pagamento");
      }

      onOpenChange(false);
      onSuccess();
    } catch (error: any) {
      toast.error(error.message || "Erro ao salvar pagamento");
    } finally {
      setLoading(false);
    }
  }

  const debitEntries = entries.filter(e => e.type === "DEBITO");
  const creditEntries = entries.filter(e => e.type === "CREDITO");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl sm:max-h-[90vh] overflow-y-auto" preventOutsideClose>
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Editar Cobranca" : "Nova Cobranca"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Atualize as informacoes da cobranca abaixo."
              : "Preencha as informacoes da nova cobranca."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {/* Vinculo */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Vinculo
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="contractId">Contrato *</Label>
                <Popover open={contractSearchOpen} onOpenChange={setContractSearchOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={contractSearchOpen}
                      className="w-full justify-between font-normal"
                    >
                      {selectedContractId
                        ? (() => {
                            const c = contracts.find((c) => c.id === selectedContractId);
                            return c ? `${c.code} - ${c.property?.title} (${c.tenant?.name})` : "Selecione o contrato";
                          })()
                        : "Selecione o contrato"}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command>
                      <CommandInput
                        placeholder="Buscar contrato, imóvel ou inquilino..."
                        value={contractSearch}
                        onValueChange={setContractSearch}
                      />
                      <CommandList>
                        <CommandEmpty>Nenhum contrato encontrado.</CommandEmpty>
                        <CommandGroup>
                          {contracts.map((contract) => (
                            <CommandItem
                              key={contract.id}
                              value={`${contract.code} ${contract.property?.title} ${contract.tenant?.name}`}
                              onSelect={() => {
                                setValue("contractId", contract.id);
                                setContractSearchOpen(false);
                                setContractSearch("");
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  selectedContractId === contract.id ? "opacity-100" : "opacity-0"
                                )}
                              />
                              <div className="flex flex-col">
                                <span>{contract.code} - {contract.property?.title}</span>
                                <span className="text-xs text-muted-foreground">{contract.tenant?.name} | R$ {formatBRL(contract.rentalValue)}</span>
                              </div>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                {errors.contractId && (
                  <p className="text-xs text-destructive">{errors.contractId.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="tenantId">Locatário *</Label>
                <Select
                  value={selectedTenantId}
                  onValueChange={(value) => setValue("tenantId", value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione o locatario" />
                  </SelectTrigger>
                  <SelectContent>
                    {tenants.map((tenant) => (
                      <SelectItem key={tenant.id} value={tenant.id}>
                        {tenant.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.tenantId && (
                  <p className="text-xs text-destructive">{errors.tenantId.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="ownerId">Proprietário *</Label>
                <Select
                  value={selectedOwnerId}
                  onValueChange={(value) => setValue("ownerId", value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione o proprietario" />
                  </SelectTrigger>
                  <SelectContent>
                    {owners.map((owner) => (
                      <SelectItem key={owner.id} value={owner.id}>
                        {owner.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.ownerId && (
                  <p className="text-xs text-destructive">{errors.ownerId.message}</p>
                )}
              </div>
            </div>
          </div>

          {/* Lançamentos do Locatário */}
          {!isEditing && entries.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-foreground border-b pb-2 flex items-center justify-between">
                <span>Lançamentos Pendentes ({entries.length})</span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={toggleAllEntries}
                >
                  {selectedEntryIds.size === entries.length ? "Desmarcar todos" : "Selecionar todos"}
                </button>
              </h3>

              <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
                {debitEntries.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-red-600">Débitos (+)</p>
                    {debitEntries.map(entry => (
                      <label
                        key={entry.id}
                        className="flex items-center gap-2 p-2 rounded-md border cursor-pointer hover:bg-muted/50 text-xs"
                      >
                        <Checkbox
                          checked={selectedEntryIds.has(entry.id)}
                          onCheckedChange={() => toggleEntry(entry.id)}
                        />
                        <span className="flex-1">{entry.description}</span>
                        <span className="font-medium text-red-600">+ R$ {formatBRL(entry.value)}</span>
                      </label>
                    ))}
                  </div>
                )}

                {creditEntries.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-green-600">Créditos (-)</p>
                    {creditEntries.map(entry => (
                      <label
                        key={entry.id}
                        className="flex items-center gap-2 p-2 rounded-md border cursor-pointer hover:bg-muted/50 text-xs"
                      >
                        <Checkbox
                          checked={selectedEntryIds.has(entry.id)}
                          onCheckedChange={() => toggleEntry(entry.id)}
                        />
                        <span className="flex-1">{entry.description}</span>
                        <span className="font-medium text-green-600">- R$ {formatBRL(entry.value)}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Dias de aluguel (pro-rata) */}
          {selectedContractId && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-foreground border-b pb-2">
                Dias de Aluguel
              </h3>
              <div className="flex items-center gap-4">
                <div className="space-y-2 w-32">
                  <Label htmlFor="prorataDias">Dias</Label>
                  <Input
                    id="prorataDias"
                    type="number"
                    min={1}
                    max={30}
                    value={prorataDias}
                    onChange={(e) => {
                      setManualProrata(true);
                      setProrataDias(Math.max(1, Math.min(30, parseInt(e.target.value) || 30)));
                    }}
                  />
                </div>
                <div className="text-xs text-muted-foreground pt-5">
                  {prorataDias < 30 ? (
                    <span className="text-orange-600 font-medium">
                      Pro-rata: {prorataDias}/30 dias = R$ {formatBRL(
                        Math.round((contracts.find(c => c.id === selectedContractId)?.rentalValue || 0) / 30 * prorataDias * 100) / 100
                      )} (original: R$ {formatBRL(contracts.find(c => c.id === selectedContractId)?.rentalValue || 0)})
                    </span>
                  ) : (
                    <span>Mês completo (30 dias)</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Valores */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Valores
            </h3>

            {/* Aviso quando o usuario esta marcando como PAGO um boleto
                que venceu antes da data de pagamento sem juros/multa */}
            {selectedStatus === "PAGO" && (() => {
              const due = watch("dueDate");
              const paidAtVal = watch("paidAt");
              const fine = parseFloat(String(watch("fineValue") ?? 0)) || 0;
              const interest = parseFloat(String(watch("interestValue") ?? 0)) || 0;
              if (!due || !paidAtVal) return null;
              const dueDate = new Date(due + "T12:00:00");
              const paidDate = new Date(paidAtVal + "T12:00:00");
              const daysLate = Math.floor((paidDate.getTime() - dueDate.getTime()) / 86400000);
              if (daysLate > 0 && fine === 0 && interest === 0) {
                return (
                  <div className="p-3 rounded-md border border-amber-300 bg-amber-50 text-xs space-y-1">
                    <div className="font-semibold text-amber-900">
                      ⚠️ Atenção: pagamento atrasado sem juros/multa
                    </div>
                    <div className="text-amber-800 leading-relaxed">
                      Este boleto venceu em{" "}
                      <strong>{dueDate.toLocaleDateString("pt-BR")}</strong> e foi
                      pago em{" "}
                      <strong>{paidDate.toLocaleDateString("pt-BR")}</strong>{" "}
                      ({daysLate} dia{daysLate > 1 ? "s" : ""} de atraso).
                      Se o cliente pagou <strong>sem</strong> juros/multa
                      (ex: dinheiro com isenção combinada), deixe os campos
                      Multa e Juros com 0,00. Caso contrário, preencha com
                      o valor que ele efetivamente pagou.
                    </div>
                  </div>
                );
              }
              return null;
            })()}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="value">Valor (R$) *</Label>
                <Input
                  id="value"
                  type="number"
                  step="0.01"
                  placeholder="0,00"
                  {...register("value")}
                />
                {errors.value && (
                  <p className="text-xs text-destructive">{errors.value.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="paidValue">Valor Pago (R$)</Label>
                <Input
                  id="paidValue"
                  type="number"
                  step="0.01"
                  placeholder="0,00"
                  {...register("paidValue")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="fineValue">Multa (R$)</Label>
                <Input
                  id="fineValue"
                  type="number"
                  step="0.01"
                  placeholder="0,00"
                  {...register("fineValue")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="interestValue">Juros (R$)</Label>
                <Input
                  id="interestValue"
                  type="number"
                  step="0.01"
                  placeholder="0,00"
                  {...register("interestValue")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="discountValue">Desconto (R$)</Label>
                <Input
                  id="discountValue"
                  type="number"
                  step="0.01"
                  placeholder="0,00"
                  {...register("discountValue")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="intermediationFee">Valor Intermediação (R$)</Label>
                <Input
                  id="intermediationFee"
                  type="number"
                  step="0.01"
                  placeholder="0,00"
                  {...register("intermediationFee")}
                />
              </div>
            </div>
          </div>

          {/* Detalhes */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Detalhes
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="dueDate">Data de Vencimento *</Label>
                <Input
                  id="dueDate"
                  type="date"
                  {...register("dueDate")}
                />
                {errors.dueDate && (
                  <p className="text-xs text-destructive">{errors.dueDate.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="paidAt">Data de Pagamento</Label>
                <Input
                  id="paidAt"
                  type="date"
                  {...register("paidAt")}
                />
                <p className="text-[11px] text-muted-foreground leading-snug">
                  ⚠️ Use a data <strong>REAL</strong> do pagamento (não a data
                  de hoje). Essa data decide se juros/multa fica com a
                  imobiliária ou vai pro proprietário.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="status">Status</Label>
                <Select
                  value={selectedStatus}
                  onValueChange={(value) => setValue("status", value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione o status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PENDENTE">Pendente</SelectItem>
                    <SelectItem value="PAGO">Pago</SelectItem>
                    <SelectItem value="ATRASADO">Atrasado</SelectItem>
                    <SelectItem value="CANCELADO">Cancelado</SelectItem>
                    <SelectItem value="PARCIAL">Parcial</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="paymentMethod">Forma de Pagamento</Label>
                <Select
                  value={selectedPaymentMethod || ""}
                  onValueChange={(value) => setValue("paymentMethod", value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BOLETO">Boleto</SelectItem>
                    <SelectItem value="PIX">PIX</SelectItem>
                    <SelectItem value="CARTAO">Cartao</SelectItem>
                    <SelectItem value="TRANSFERENCIA">Transferencia</SelectItem>
                    <SelectItem value="DINHEIRO">Dinheiro</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Split */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Split (Repasse)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="splitOwnerValue">Repasse Proprietário (R$)</Label>
                <Input
                  id="splitOwnerValue"
                  type="number"
                  step="0.01"
                  placeholder="0,00"
                  {...register("splitOwnerValue")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="splitAdminValue">Taxa Administração (R$)</Label>
                <Input
                  id="splitAdminValue"
                  type="number"
                  step="0.01"
                  placeholder="0,00"
                  {...register("splitAdminValue")}
                />
              </div>
            </div>
          </div>

          {/* Observações */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Observações
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="description">Descricao</Label>
                <Input
                  id="description"
                  placeholder="Descricao do pagamento"
                  {...register("description")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">Notas</Label>
                <Input
                  id="notes"
                  placeholder="Observações adicionais"
                  {...register("notes")}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {isEditing ? "Salvar Alteracoes" : "Cadastrar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
