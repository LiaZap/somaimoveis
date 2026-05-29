"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Upload, X, FileText, Plus, Trash2, Eye } from "lucide-react";
import { GUARANTEE_INSURERS, requiresInsurer } from "@/lib/guarantee-insurers";
import { GuarantorForm } from "@/components/forms/guarantor-form";
import { OwnerForm } from "@/components/forms/owner-form";
import { TenantForm } from "@/components/forms/tenant-form";
import { PropertyForm } from "@/components/forms/property-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

const contractSchema = z.object({
  code: z.string().min(1, "Código é obrigatório"),
  type: z.string().min(1),
  status: z.string().min(1),
  propertyId: z.string().optional(),
  ownerId: z.string().min(1, "Proprietário é obrigatório"),
  tenantId: z.string().optional(),
  tenant2Id: z.string().optional(),
  rentalValue: z.coerce.number().min(0).optional(),
  adminFeePercent: z.coerce.number().min(0),
  bankFee: z.coerce.number().min(0).default(3.90),
  insuranceFee: z.coerce.number().min(0).optional(),
  intermediationFee: z.coerce.number().min(0).optional(),
  intermediationInstallments: z.coerce.number().int().min(1).default(1),
  paymentDay: z.coerce.number().int().min(1).max(31),
  startDate: z.string().min(1, "Data de início é obrigatória"),
  endDate: z.string().min(1, "Data de término é obrigatória"),
  guaranteeType: z.string().optional(),
  guaranteeValue: z.coerce.number().optional(),
  guaranteeNotes: z.string().optional(),
  guaranteeInsurer: z.string().optional(),
  aluguelGarantido: z.boolean().optional(),
  adjustmentIndex: z.string().optional(),
  adjustmentMonth: z.coerce.number().int().min(1).max(12).optional(),
  lastAdjustmentPercent: z.coerce.number().optional(),
  renewalMonths: z.coerce.number().int().min(1).default(12),
  penaltyPercent: z.coerce.number().min(0).default(3),
  notes: z.string().optional(),
});

type ContractFormData = {
  code: string;
  type: string;
  status: string;
  propertyId: string;
  ownerId: string;
  tenantId: string;
  tenant2Id?: string;
  rentalValue: number;
  adminFeePercent: number;
  bankFee: number;
  insuranceFee?: number;
  intermediationFee?: number;
  intermediationInstallments: number;
  paymentDay: number;
  startDate: string;
  endDate: string;
  guaranteeType?: string;
  guaranteeValue?: number;
  guaranteeNotes?: string;
  guaranteeInsurer?: string;
  aluguelGarantido?: boolean;
  adjustmentIndex?: string;
  adjustmentMonth?: number;
  lastAdjustmentPercent?: number;
  renewalMonths: number;
  penaltyPercent: number;
  notes?: string;
};

interface ContractFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract?: any;
  onSuccess: () => void;
}

interface SelectOption {
  id: string;
  name?: string;
  title?: string;
  cpfCnpj?: string;
}

export function ContractForm({ open, onOpenChange, contract, onSuccess }: ContractFormProps) {
  const [loading, setLoading] = useState(false);
  const [owners, setOwners] = useState<SelectOption[]>([]);
  const [tenants, setTenants] = useState<SelectOption[]>([]);
  const [properties, setProperties] = useState<SelectOption[]>([]);
  const [guarantorsList, setGuarantorsList] = useState<SelectOption[]>([]);
  const [selectedGuarantorIds, setSelectedGuarantorIds] = useState<string[]>([]);
  const [guarantorFormOpen, setGuarantorFormOpen] = useState(false);
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [pdfPreviewIndex, setPdfPreviewIndex] = useState<number | null>(null);
  const [showNewProperty, setShowNewProperty] = useState(false);
  const [showNewOwner, setShowNewOwner] = useState(false);
  const [showNewTenant, setShowNewTenant] = useState(false);
  const [coOwners, setCoOwners] = useState<{ownerId: string; percentage: number}[]>([]);
  const isEditing = !!contract;

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ContractFormData>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(contractSchema) as any,
    defaultValues: {
      code: "",
      type: "LOCACAO",
      status: "ATIVO",
      propertyId: "",
      ownerId: "",
      tenantId: "",
      tenant2Id: "",
      rentalValue: undefined,
      adminFeePercent: 10,
      bankFee: 3.90,
      insuranceFee: undefined,
      intermediationFee: undefined,
      intermediationInstallments: 1,
      paymentDay: 5,
      startDate: "",
      endDate: "",
      guaranteeType: "",
      guaranteeValue: undefined,
      guaranteeNotes: "",
      guaranteeInsurer: "",
      aluguelGarantido: false,
      adjustmentIndex: "IGPM",
      adjustmentMonth: undefined,
      lastAdjustmentPercent: undefined,
      renewalMonths: 12,
      penaltyPercent: 3,
      notes: "",
    },
  });

  const selectedType = watch("type");
  const selectedStatus = watch("status");
  const selectedPropertyId = watch("propertyId");
  const selectedOwnerId = watch("ownerId");
  const selectedTenantId = watch("tenantId");
  const selectedTenant2Id = watch("tenant2Id");
  const selectedGuaranteeType = watch("guaranteeType");
  const selectedGuaranteeInsurer = watch("guaranteeInsurer");
  const selectedAdjustmentIndex = watch("adjustmentIndex");

  // Fetch related data on dialog open
  useEffect(() => {
    async function fetchData() {
      try {
        // Selects de associacao devem mostrar TODOS, inclusive inativos
        // (caso contrario um registro temporariamente desativado some do form
        // ao tentar reeditar contrato existente).
        const [ownersRes, tenantsRes, propertiesRes, guarantorsRes] = await Promise.all([
          fetch("/api/owners?includeInactive=true"),
          fetch("/api/tenants?includeInactive=true"),
          fetch("/api/properties?includeInactive=true"),
          fetch("/api/guarantors"),
        ]);

        if (ownersRes.ok) {
          const data = await ownersRes.json();
          setOwners(data.map((o: any) => ({ id: o.id, name: o.name })));
        }
        if (tenantsRes.ok) {
          const data = await tenantsRes.json();
          setTenants(data.map((t: any) => ({ id: t.id, name: t.name })));
        }
        if (propertiesRes.ok) {
          const data = await propertiesRes.json();
          setProperties(data.map((p: any) => ({ id: p.id, title: p.title })));
        }
        if (guarantorsRes.ok) {
          const data = await guarantorsRes.json();
          setGuarantorsList(data.map((g: any) => ({ id: g.id, name: g.name, cpfCnpj: g.cpfCnpj })));
        }
      } catch (error) {
        console.error("Erro ao carregar dados:", error);
      }
    }

    if (open) {
      fetchData();
    }
  }, [open]);

  // Auto-generate code for new contracts
  useEffect(() => {
    async function generateCode() {
      try {
        const response = await fetch("/api/contracts");
        if (response.ok) {
          const contracts = await response.json();
          const nextNumber = contracts.length + 1;
          const code = `CTR-${String(nextNumber).padStart(3, "0")}`;
          setValue("code", code);
        }
      } catch (error) {
        setValue("code", "CTR-001");
      }
    }

    if (open && !isEditing) {
      generateCode();
    }
  }, [open, isEditing, setValue]);

  // Reset form when opening
  useEffect(() => {
    if (open) {
      if (contract) {
        reset({
          code: contract.code || "",
          type: contract.type || "LOCACAO",
          status: contract.status || "ATIVO",
          propertyId: contract.propertyId || "",
          ownerId: contract.ownerId || "",
          tenantId: contract.tenantId || "",
          tenant2Id: contract.tenant2Id || "",
          rentalValue: contract.rentalValue ?? undefined,
          adminFeePercent: contract.adminFeePercent ?? 10,
          bankFee: contract.bankFee ?? 3.90,
          insuranceFee: contract.insuranceFee ?? undefined,
          intermediationFee: contract.intermediationFee ?? undefined,
          intermediationInstallments: contract.intermediationInstallments ?? 1,
          paymentDay: contract.paymentDay ?? 5,
          startDate: contract.startDate
            ? new Date(contract.startDate).toISOString().split("T")[0]
            : "",
          endDate: contract.endDate
            ? new Date(contract.endDate).toISOString().split("T")[0]
            : "",
          guaranteeType: contract.guaranteeType || "",
          guaranteeValue: contract.guaranteeValue ?? undefined,
          guaranteeNotes: contract.guaranteeNotes || "",
          guaranteeInsurer: (contract as any).guaranteeInsurer || "",
          aluguelGarantido: (contract as any).aluguelGarantido ?? false,
          adjustmentIndex: contract.adjustmentIndex || "IGPM",
          adjustmentMonth: contract.adjustmentMonth ?? undefined,
          lastAdjustmentPercent: contract.lastAdjustmentPercent ?? undefined,
          renewalMonths: contract.renewalMonths ?? 12,
          penaltyPercent: contract.penaltyPercent ?? 3,
          notes: contract.notes || "",
        });
        // Load co-owners if property exists
        if (contract.propertyId) {
          fetch(`/api/properties/${contract.propertyId}/owners`).then(r => r.json()).then(data => {
            const ownersList = data.owners || [];
            setCoOwners(ownersList.filter((o: any) => o.ownerId !== contract.ownerId).map((o: any) => ({ ownerId: o.ownerId, percentage: o.percentage })));
          }).catch(() => setCoOwners([]));
        } else {
          setCoOwners([]);
        }
        // Set selected guarantors from contract data
        if (contract.guarantors && Array.isArray(contract.guarantors)) {
          setSelectedGuarantorIds(
            contract.guarantors.map((g: any) => g.guarantor?.id || g.guarantorId).filter(Boolean)
          );
        } else {
          setSelectedGuarantorIds([]);
        }
      } else {
        // Auto-generate next contract code
        fetch("/api/contracts?page=1&limit=1").then(r => r.json()).then(data => {
          const contracts = data.data || [];
          const lastCode = contracts.length > 0 ? contracts[0].code : "CTR-0";
          const lastNum = parseInt(lastCode.replace(/\D/g, "") || "0");
          setValue("code", `CTR-${lastNum + 1}`);
        }).catch(() => {});
        reset({
          code: "",
          type: "LOCACAO",
          status: "ATIVO",
          propertyId: "",
          ownerId: "",
          tenantId: "",
          tenant2Id: "",
          rentalValue: undefined,
          adminFeePercent: 10,
          bankFee: 3.90,
          intermediationFee: undefined,
          intermediationInstallments: 1,
          paymentDay: 5,
          startDate: "",
          endDate: "",
          guaranteeType: "",
          guaranteeValue: undefined,
          guaranteeNotes: "",
          guaranteeInsurer: "",
          adjustmentIndex: "IGPM",
          adjustmentMonth: undefined,
          lastAdjustmentPercent: undefined,
          renewalMonths: 12,
          penaltyPercent: 3,
          notes: "",
        });
        setSelectedGuarantorIds([]);
      }
    }
  }, [open, contract, reset]);

  async function onSubmit(data: ContractFormData) {
    setLoading(true);
    try {
      const url = isEditing ? `/api/contracts/${contract.id}` : "/api/contracts";
      const method = isEditing ? "PUT" : "POST";

      const payload = {
        ...data,
        tenant2Id: data.tenant2Id || null,
        startDate: data.startDate,
        endDate: data.endDate,
        intermediationFee: data.intermediationFee || null,
        intermediationInstallments: data.intermediationInstallments || 1,
        lastAdjustmentPercent: data.lastAdjustmentPercent ?? null,
        renewalMonths: data.renewalMonths || 12,
        penaltyPercent: data.penaltyPercent ?? 3,
        guaranteeType: data.guaranteeType || null,
        guaranteeValue: data.guaranteeValue || null,
        guaranteeNotes: data.guaranteeNotes || null,
        guaranteeInsurer: data.guaranteeInsurer || null,
        aluguelGarantido: data.aluguelGarantido ?? false,
        guarantorIds: data.guaranteeType === "FIADOR" ? selectedGuarantorIds : [],
        adjustmentIndex: data.adjustmentIndex || null,
        adjustmentMonth: data.adjustmentMonth || null,
        notes: data.notes || null,
      };

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Erro ao salvar contrato");
      }

      // Upload PDFs if any
      if (pdfFiles.length > 0) {
        const contractId = result.id || contract?.id;
        if (contractId) {
          for (const file of pdfFiles) {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("contractId", contractId);
            formData.append("entityType", "CONTRACT");
            formData.append("entityId", contractId);
            const uploadRes = await fetch("/api/upload", { method: "POST", body: formData });
            if (!uploadRes.ok) {
              const err = await uploadRes.json().catch(() => ({}));
              console.error("[Upload PDF]", err);
            }
          }
        }
        setPdfFiles([]);
      }

      // Save co-owners if any
      if (coOwners.length > 0 && result.propertyId) {
        for (const co of coOwners) {
          if (co.ownerId && co.percentage > 0) {
            await fetch(`/api/properties/${result.propertyId}/owners`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ownerId: co.ownerId, percentage: co.percentage }),
            }).catch(() => {});
          }
        }
      }

      onOpenChange(false);
      onSuccess();
    } catch (error: any) {
      toast.error(error.message || "Erro ao salvar contrato");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl sm:max-h-[90vh]" preventOutsideClose>
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Editar Contrato" : "Novo Contrato"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Atualize as informacoes do contrato abaixo."
              : "Preencha as informacoes do novo contrato."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {/* Informações */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Informações
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="code">Código *</Label>
                <Input
                  id="code"
                  placeholder="CTR-001"
                  {...register("code")}
                />
                {errors.code && (
                  <p className="text-xs text-destructive">{errors.code.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="type">Tipo</Label>
                <Select
                  value={selectedType}
                  onValueChange={(value) => setValue("type", value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione o tipo" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="LOCACAO">Locação</SelectItem>
                  </SelectContent>
                </Select>
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
                    <SelectItem value="ATIVO">Ativo</SelectItem>
                    <SelectItem value="ENCERRADO">Encerrado</SelectItem>
                    <SelectItem value="PENDENTE_RENOVACAO">Pendente Renovação</SelectItem>
                    <SelectItem value="CANCELADO">Cancelado</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Partes */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Partes
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ownerId">Proprietário *</Label>
                <div className="flex gap-2">
                  <Select
                    value={selectedOwnerId}
                    onValueChange={(value) => setValue("ownerId", value)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Selecione o proprietário" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px]">
                      {owners.map((owner) => (
                        <SelectItem key={owner.id} value={owner.id}>
                          {owner.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" size="icon" variant="outline" onClick={() => setShowNewOwner(true)} title="Cadastrar proprietário">
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {errors.ownerId && (
                  <p className="text-xs text-destructive">{errors.ownerId.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="propertyId">Imóvel *</Label>
                <div className="flex gap-2">
                  <Select
                    value={selectedPropertyId}
                    onValueChange={(value) => {
                      setValue("propertyId", value);
                      if (value) {
                        fetch(`/api/properties/${value}/owners`).then(r => r.json()).then(data => {
                          const ownersList = data.owners || [];
                          if (ownersList.length > 0) {
                            const primaryId = data.primaryOwnerId;
                            if (primaryId && !selectedOwnerId) setValue("ownerId", primaryId);
                            setCoOwners(ownersList.filter((o: any) => o.ownerId !== primaryId).map((o: any) => ({ ownerId: o.ownerId, percentage: o.percentage })));
                          }
                        }).catch(() => {});
                      }
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Selecione o imóvel" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px]">
                      {properties.map((property) => (
                        <SelectItem key={property.id} value={property.id}>
                          {property.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" size="icon" variant="outline" onClick={() => setShowNewProperty(true)} title="Cadastrar imóvel">
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {errors.propertyId && (
                  <p className="text-xs text-destructive">{errors.propertyId.message}</p>
                )}
              </div>

              {/* Co-proprietários */}
              <div className="space-y-2 sm:col-span-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">Co-proprietários (divisão do repasse)</Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => setCoOwners(prev => [...prev, { ownerId: "", percentage: 0 }])}
                  >
                    <Plus className="h-3 w-3 mr-1" /> Co-proprietário
                  </Button>
                </div>
                {coOwners.map((co, idx) => (
                  <div key={idx} className="flex gap-2 items-center">
                    <Select
                      value={co.ownerId}
                      onValueChange={(val) => setCoOwners(prev => prev.map((c, i) => i === idx ? { ...c, ownerId: val } : c))}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Selecione" />
                      </SelectTrigger>
                      <SelectContent>
                        {owners.filter(o => o.id !== selectedOwnerId && !coOwners.some((c, ci) => ci !== idx && c.ownerId === o.id)).map((o) => (
                          <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={0.01}
                      max={100}
                      step={0.01}
                      className="w-20"
                      placeholder="%"
                      value={co.percentage || ""}
                      onChange={(e) => setCoOwners(prev => prev.map((c, i) => i === idx ? { ...c, percentage: Number(e.target.value) } : c))}
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive"
                      onClick={() => setCoOwners(prev => prev.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                {coOwners.length > 0 && (() => {
                  const totalCo = coOwners.reduce((s, c) => s + (c.percentage || 0), 0);
                  const total = Math.round(totalCo * 100) / 100;
                  const primaryPercent = Math.round((100 - total) * 100) / 100;
                  const isValid = total < 100 && primaryPercent > 0;
                  return (
                    <div className="space-y-1">
                      <p className={`text-xs font-medium ${isValid ? "text-emerald-600" : "text-red-600"}`}>
                        Co-proprietários: {total.toFixed(2).replace(/\.?0+$/, "")}%
                        {" · "}Proprietário principal: {primaryPercent.toFixed(2).replace(/\.?0+$/, "")}%
                        {isValid ? " ✓" : " (co-proprietários devem somar menos de 100%)"}
                      </p>
                    </div>
                  );
                })()}
              </div>

              <div className="space-y-2">
                <Label htmlFor="tenantId">Locatário *</Label>
                <div className="flex gap-2">
                  <Select
                    value={selectedTenantId}
                    onValueChange={(value) => setValue("tenantId", value)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Selecione o locatario" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px]">
                      {tenants.map((tenant) => (
                        <SelectItem key={tenant.id} value={tenant.id}>
                          {tenant.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" size="icon" variant="outline" onClick={() => setShowNewTenant(true)} title="Cadastrar locatario">
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {errors.tenantId && (
                  <p className="text-xs text-destructive">{errors.tenantId.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="tenant2Id">Locatário 2 (opcional)</Label>
                <Select
                  value={selectedTenant2Id || ""}
                  onValueChange={(value) => setValue("tenant2Id", value === "__none__" ? "" : value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione (opcional)" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[300px]">
                    <SelectItem value="__none__">Nenhum</SelectItem>
                    {tenants.filter((t) => t.id !== selectedTenantId).map((tenant) => (
                      <SelectItem key={tenant.id} value={tenant.id}>
                        {tenant.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Valores */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Valores
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="rentalValue">Valor Aluguel (R$) *</Label>
                <Input
                  id="rentalValue"
                  type="number"
                  step="0.01"
                  placeholder="0,00"
                  {...register("rentalValue")}
                />
                {errors.rentalValue && (
                  <p className="text-xs text-destructive">{errors.rentalValue.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="adminFeePercent">Taxa Adm. (%)</Label>
                <Input
                  id="adminFeePercent"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  placeholder="10"
                  {...register("adminFeePercent")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="bankFee">Taxa Bancaria (R$)</Label>
                <Input
                  id="bankFee"
                  type="number"
                  step="0.01"
                  placeholder="3.90"
                  {...register("bankFee")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="insuranceFee">Seguro Fiança (R$)</Label>
                <Input
                  id="insuranceFee"
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  {...register("insuranceFee")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="intermediationFee">Taxa de Intermediação (%)</Label>
                <Input
                  id="intermediationFee"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  placeholder="0"
                  {...register("intermediationFee")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="intermediationInstallments">Parcelas Intermediação</Label>
                <Input
                  id="intermediationInstallments"
                  type="number"
                  min="1"
                  placeholder="1"
                  {...register("intermediationInstallments")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="paymentDay">Dia Pagamento Locatário</Label>
                <Input
                  id="paymentDay"
                  type="number"
                  min="1"
                  max="31"
                  placeholder="10"
                  {...register("paymentDay")}
                />
              </div>
            </div>
          </div>

          {/* Período */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Período
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Data Inicio *</Label>
                <Input
                  id="startDate"
                  type="date"
                  {...register("startDate")}
                />
                {errors.startDate && (
                  <p className="text-xs text-destructive">{errors.startDate.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="endDate">Data Termino *</Label>
                <Input
                  id="endDate"
                  type="date"
                  {...register("endDate")}
                />
                {errors.endDate && (
                  <p className="text-xs text-destructive">{errors.endDate.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="renewalMonths">Prazo Renovação (meses)</Label>
                <Input
                  id="renewalMonths"
                  type="number"
                  min={1}
                  {...register("renewalMonths")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="penaltyPercent">Multa Rescisao (meses)</Label>
                <Input
                  id="penaltyPercent"
                  type="number"
                  step="0.5"
                  min={0}
                  {...register("penaltyPercent")}
                />
              </div>
            </div>
          </div>

          {/* Garantia */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Garantia
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="guaranteeType">Tipo de Garantia</Label>
                <Select
                  value={selectedGuaranteeType || ""}
                  onValueChange={(value) => {
                    setValue("guaranteeType", value);
                    // Limpa insurer quando o tipo nao requer seguradora
                    if (!requiresInsurer(value)) {
                      setValue("guaranteeInsurer", "");
                    }
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FIADOR">Fiador</SelectItem>
                    <SelectItem value="CAUCAO">Caucao</SelectItem>
                    <SelectItem value="SEGURO_FIANCA">Seguro Fianca</SelectItem>
                    <SelectItem value="TITULO_CAPITALIZACAO">Titulo de Capitalizacao</SelectItem>
                    <SelectItem value="SEM_GARANTIA">Sem Garantia</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="guaranteeValue">Valor da Garantia (R$)</Label>
                <Input
                  id="guaranteeValue"
                  type="number"
                  step="0.01"
                  placeholder="0,00"
                  {...register("guaranteeValue")}
                />
              </div>

              {/* Seguradora — condicional ao tipo SEGURO_FIANCA / TITULO_CAPITALIZACAO */}
              {requiresInsurer(selectedGuaranteeType) && (
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="guaranteeInsurer">Seguradora / Empresa</Label>
                  <Select
                    value={selectedGuaranteeInsurer || ""}
                    onValueChange={(value) => setValue("guaranteeInsurer", value)}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Selecione a seguradora" />
                    </SelectTrigger>
                    <SelectContent>
                      {GUARANTEE_INSURERS.map((ins) => (
                        <SelectItem key={ins.value} value={ins.value}>
                          {ins.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="guaranteeNotes">Observações da Garantia</Label>
                <Input
                  id="guaranteeNotes"
                  placeholder="Detalhes sobre a garantia"
                  {...register("guaranteeNotes")}
                />
              </div>

              {/* Aluguel garantido pela imobiliaria — afeta o destino de juros/multa */}
              <div className="space-y-1 sm:col-span-2 p-3 rounded-md border border-amber-200 bg-amber-50/50">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    {...register("aluguelGarantido")}
                    className="mt-1 h-4 w-4 rounded border-input"
                  />
                  <div className="space-y-1">
                    <div className="text-sm font-medium">
                      Aluguel garantido pela imobiliária
                    </div>
                    <div className="text-xs text-muted-foreground leading-relaxed">
                      Quando marcado, a imobiliária adianta o repasse ao
                      proprietário mesmo se o inquilino atrasar.
                      Consequência: <strong>juros e multa por atraso ficam
                      sempre com a imobiliária</strong> (não são repassados
                      ao proprietário).
                    </div>
                  </div>
                </label>
              </div>

              {selectedGuaranteeType === "FIADOR" && (
                <div className="space-y-3 sm:col-span-2">
                  <Label>Fiadores</Label>
                  <div className="flex gap-2 items-center flex-wrap">
                    <Select
                      onValueChange={(value) => {
                        if (value && !selectedGuarantorIds.includes(value)) {
                          setSelectedGuarantorIds(prev => [...prev, value]);
                        }
                      }}
                      value=""
                    >
                      <SelectTrigger className="w-full sm:w-[280px]">
                        <SelectValue placeholder="Selecionar fiador existente" />
                      </SelectTrigger>
                      <SelectContent>
                        {guarantorsList
                          .filter(g => !selectedGuarantorIds.includes(g.id))
                          .map(g => (
                            <SelectItem key={g.id} value={g.id}>
                              {g.name} {g.cpfCnpj ? `- ${g.cpfCnpj}` : ""}
                            </SelectItem>
                          ))}
                        {guarantorsList.filter(g => !selectedGuarantorIds.includes(g.id)).length === 0 && (
                          <div className="px-2 py-1.5 text-sm text-muted-foreground">
                            Nenhum fiador disponível
                          </div>
                        )}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setGuarantorFormOpen(true)}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Novo Fiador
                    </Button>
                  </div>

                  {selectedGuarantorIds.length > 0 && (
                    <div className="space-y-1.5">
                      {selectedGuarantorIds.map((gId) => {
                        const g = guarantorsList.find(x => x.id === gId);
                        return (
                          <div key={gId} className="flex items-center gap-2 bg-muted/50 rounded px-3 py-1.5 text-sm">
                            <span className="flex-1 truncate">
                              {g?.name || "Fiador"} {g?.cpfCnpj ? `- ${g.cpfCnpj}` : ""}
                            </span>
                            <button
                              type="button"
                              onClick={() => setSelectedGuarantorIds(prev => prev.filter(id => id !== gId))}
                              className="text-muted-foreground hover:text-destructive shrink-0"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {selectedGuarantorIds.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Nenhum fiador selecionado. Selecione um existente ou cadastre um novo.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Reajuste */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Reajuste
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="adjustmentIndex">Indice de Reajuste</Label>
                <Select
                  value={selectedAdjustmentIndex || ""}
                  onValueChange={(value) => setValue("adjustmentIndex", value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IGPM">IGP-M</SelectItem>
                    <SelectItem value="IPCA">IPCA</SelectItem>
                    <SelectItem value="INPC">INPC</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="adjustmentMonth">Mes de Reajuste</Label>
                <Input
                  id="adjustmentMonth"
                  type="number"
                  min="1"
                  max="12"
                  placeholder="Ex: 1 (Janeiro)"
                  {...register("adjustmentMonth")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="lastAdjustmentPercent">Ultimo Reajuste (%)</Label>
                <Input
                  id="lastAdjustmentPercent"
                  type="number"
                  step="0.01"
                  placeholder="Ex: 5.5"
                  {...register("lastAdjustmentPercent")}
                />
              </div>
            </div>
          </div>

          {/* Upload PDFs */}
          <div className="space-y-3">
            <Label className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Documentos PDF
            </Label>
            <div
              className="border-2 border-dashed rounded-lg p-4 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => document.getElementById("contract-pdf-input")?.click()}
            >
              <Upload className="h-5 w-5 mx-auto text-muted-foreground mb-1" />
              <p className="text-sm text-muted-foreground">Clique para anexar PDFs (locação, vistoria, procuração, etc.)</p>
              <input
                id="contract-pdf-input"
                type="file"
                accept=".pdf"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  setPdfFiles(prev => [...prev, ...files]);
                  e.target.value = "";
                }}
              />
            </div>
            {pdfFiles.length > 0 && (
              <div className="space-y-1">
                {pdfFiles.map((file, i) => (
                  <div key={i}>
                    <div className="flex items-center gap-2 text-sm bg-muted/50 rounded px-3 py-1.5">
                      <FileText className="h-4 w-4 text-red-500 shrink-0" />
                      <span className="truncate flex-1">{file.name}</span>
                      <span className="text-muted-foreground text-xs">{(file.size / 1024 / 1024).toFixed(1)}MB</span>
                      <button
                        type="button"
                        onClick={() => setPdfPreviewIndex(pdfPreviewIndex === i ? null : i)}
                        className="text-primary hover:text-primary/80"
                        title="Visualizar"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (pdfPreviewIndex === i) setPdfPreviewIndex(null);
                          setPdfFiles(prev => prev.filter((_, idx) => idx !== i));
                        }}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {pdfPreviewIndex === i && (
                      <iframe
                        src={URL.createObjectURL(file)}
                        className="w-full border rounded-lg mt-1"
                        style={{ height: "400px" }}
                        title={file.name}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Observações */}
          <div className="space-y-2">
            <Label htmlFor="notes">Observações</Label>
            <textarea
              id="notes"
              placeholder="Observações adicionais sobre o contrato"
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              {...register("notes")}
            />
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

      <GuarantorForm
        open={guarantorFormOpen}
        onOpenChange={setGuarantorFormOpen}
        onSuccess={(newGuarantor) => {
          if (newGuarantor?.id) {
            setGuarantorsList((prev) =>
              prev.some((g) => g.id === newGuarantor.id)
                ? prev
                : [...prev, { id: newGuarantor.id, name: newGuarantor.name, cpfCnpj: newGuarantor.cpfCnpj }]
            );
            setSelectedGuarantorIds((prev) =>
              prev.includes(newGuarantor.id) ? prev : [...prev, newGuarantor.id]
            );
          }
        }}
      />
      {showNewProperty && (
        <PropertyForm
          open={showNewProperty}
          onOpenChange={setShowNewProperty}
          onSuccess={() => {
            setShowNewProperty(false);
            const prevIds = new Set(properties.map(p => p.id));
            fetch("/api/properties?includeInactive=true").then(r => r.json()).then(data => {
              const list = Array.isArray(data) ? data : data.data || [];
              setProperties(list);
              const newItem = list.find((p: any) => !prevIds.has(p.id));
              if (newItem) setValue("propertyId", newItem.id);
            });
          }}
        />
      )}
      {showNewOwner && (
        <OwnerForm
          open={showNewOwner}
          onOpenChange={setShowNewOwner}
          onSuccess={() => {
            setShowNewOwner(false);
            const prevIds = new Set(owners.map(o => o.id));
            fetch("/api/owners?includeInactive=true").then(r => r.json()).then(data => {
              const list = Array.isArray(data) ? data : data.data || [];
              setOwners(list);
              const newItem = list.find((o: any) => !prevIds.has(o.id));
              if (newItem) setValue("ownerId", newItem.id);
            });
          }}
        />
      )}
      {showNewTenant && (
        <TenantForm
          open={showNewTenant}
          onOpenChange={setShowNewTenant}
          onSuccess={() => {
            setShowNewTenant(false);
            const prevIds = new Set(tenants.map(t => t.id));
            fetch("/api/tenants?includeInactive=true").then(r => r.json()).then(data => {
              const list = Array.isArray(data) ? data : data.data || [];
              setTenants(list);
              const newItem = list.find((t: any) => !prevIds.has(t.id));
              if (newItem) setValue("tenantId", newItem.id);
            });
          }}
        />
      )}
    </Dialog>
  );
}
