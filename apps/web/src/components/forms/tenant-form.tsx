"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Search } from "lucide-react";
import { useCepLookup } from "@/hooks/use-cep-lookup";
import { useCnpjLookup } from "@/hooks/use-cnpj-lookup";
import { formatPhone as formatPhoneShared } from "@/lib/format-phone";
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

const tenantSchema = z.object({
  name: z.string().min(1, "Nome é obrigatório"),
  cpfCnpj: z.string().min(1, "CPF/CNPJ é obrigatório"),
  personType: z.string().default("PF"),
  email: z.string().email("Email invalido").or(z.literal("")).optional(),
  phone: z.string().optional(),
  phone2: z.string().optional(),
  email2: z.string().email("Email invalido").or(z.literal("")).optional(),
  rgNumber: z.string().optional(),
  rgIssuer: z.string().optional(),
  birthDate: z.string().optional(),
  occupation: z.string().optional(),
  monthlyIncome: z.coerce.number().optional(),
  street: z.string().optional(),
  number: z.string().optional(),
  complement: z.string().optional(),
  neighborhood: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  stateRegistration: z.string().optional(),
  paymentDay: z.coerce.number().min(1).max(31).default(5),
  notes: z.string().optional(),
});

type TenantFormData = z.infer<typeof tenantSchema>;

interface TenantFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant?: any;
  onSuccess: () => void;
}

export function TenantForm({ open, onOpenChange, tenant, onSuccess }: TenantFormProps) {
  const [loading, setLoading] = useState(false);
  const isEditing = !!tenant;

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<TenantFormData>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(tenantSchema) as any,
    defaultValues: {
      name: "",
      cpfCnpj: "",
      personType: "PF",
      email: "",
      phone: "",
      phone2: "",
      email2: "",
      rgNumber: "",
      rgIssuer: "",
      birthDate: "",
      occupation: "",
      monthlyIncome: undefined,
      paymentDay: 5,
      street: "",
      number: "",
      complement: "",
      neighborhood: "",
      city: "",
      state: "",
      zipCode: "",
      notes: "",
    },
  });

  const personType = watch("personType");

  const handleCepResult = useCallback((data: { street: string; neighborhood: string; city: string; state: string }) => {
    setValue("street", data.street, { shouldValidate: true });
    setValue("neighborhood", data.neighborhood, { shouldValidate: true });
    setValue("city", data.city, { shouldValidate: true });
    setValue("state", data.state, { shouldValidate: true });
  }, [setValue]);

  const { lookup: lookupCep, loading: cepLoading, error: cepError, formatCep } = useCepLookup({ onResult: handleCepResult });

  const handleCnpjResult = useCallback((data: { name: string; email: string; phone: string; street: string; number: string; complement: string; neighborhood: string; city: string; state: string; zipCode: string }) => {
    const fields: [keyof TenantFormData, string][] = [
      ["name", data.name], ["email", data.email], ["phone", data.phone],
      ["street", data.street], ["number", data.number], ["complement", data.complement],
      ["neighborhood", data.neighborhood], ["city", data.city], ["state", data.state],
      ["zipCode", data.zipCode],
    ];
    for (const [field, value] of fields) {
      if (value) setValue(field, value, { shouldValidate: true, shouldDirty: true });
    }
    requestAnimationFrame(() => {
      for (const [field, value] of fields) {
        if (!value) continue;
        const el = document.getElementById(field) as HTMLInputElement;
        if (el) el.value = value;
      }
    });
  }, [setValue]);

  const { lookup: lookupCnpj, loading: cnpjLoading, error: cnpjError, formatCpfCnpj } = useCnpjLookup({ onResult: handleCnpjResult });

  const formatPhone = useCallback((value: string): string => formatPhoneShared(value), []);

  const DRAFT_KEY = "somma-draft-tenant";

  useEffect(() => {
    if (open) {
      if (tenant) {
        reset({
          name: tenant.name || "",
          cpfCnpj: tenant.cpfCnpj || "",
          personType: tenant.personType || "PF",
          email: tenant.email || "",
          phone: tenant.phone || "",
          phone2: tenant.phone2 || "",
          email2: tenant.email2 || "",
          rgNumber: tenant.rgNumber || "",
          rgIssuer: tenant.rgIssuer || "",
          birthDate: tenant.birthDate ? String(tenant.birthDate).slice(0, 10) : "",
          occupation: tenant.occupation || "",
          monthlyIncome: tenant.monthlyIncome ?? undefined,
          paymentDay: tenant.paymentDay ?? 5,
          street: tenant.street || "",
          number: tenant.number || "",
          complement: tenant.complement || "",
          neighborhood: tenant.neighborhood || "",
          city: tenant.city || "",
          state: tenant.state || "",
          zipCode: tenant.zipCode || "",
          stateRegistration: tenant.stateRegistration || "",
          notes: tenant.notes || "",
        });
      } else {
        try {
          const draft = localStorage.getItem(DRAFT_KEY);
          if (draft) {
            reset(JSON.parse(draft));
          } else {
            reset({
              name: "", cpfCnpj: "", personType: "PF", email: "", phone: "", phone2: "", email2: "",
              rgNumber: "", rgIssuer: "", birthDate: "", occupation: "", monthlyIncome: undefined, paymentDay: 5,
              street: "", number: "", complement: "", neighborhood: "",
              city: "", state: "", zipCode: "", stateRegistration: "", notes: "",
            });
          }
        } catch {
          reset({
            name: "", cpfCnpj: "", personType: "PF", email: "", phone: "",
            rgNumber: "", rgIssuer: "", birthDate: "", occupation: "", monthlyIncome: undefined, paymentDay: 5,
            street: "", number: "", complement: "", neighborhood: "",
            city: "", state: "", zipCode: "", stateRegistration: "", notes: "",
          });
        }
      }
    }
  }, [open, tenant, reset]);

  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!newOpen && !isEditing) {
      const current = watch();
      const hasData = Object.values(current).some(v => v && v !== "PF");
      if (hasData) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(current));
      }
    }
    onOpenChange(newOpen);
  }, [isEditing, watch, onOpenChange]);

  async function onSubmit(data: TenantFormData) {
    setLoading(true);
    try {
      const url = isEditing ? `/api/tenants/${tenant.id}` : "/api/tenants";
      const method = isEditing ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Erro ao salvar locatario");
      }

      localStorage.removeItem(DRAFT_KEY);
      onOpenChange(false);
      onSuccess();
    } catch (error: any) {
      toast.error(error.message || "Erro ao salvar locatario");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[680px] sm:max-h-[90vh]" preventOutsideClose>
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Editar Locatário" : "Novo Locatário"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Atualize as informacoes do locatario abaixo."
              : "Preencha as informacoes do novo locatario."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {/* Dados Pessoais */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Dados Pessoais
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Nome *</Label>
                <Input
                  id="name"
                  placeholder="Nome completo ou razao social"
                  {...register("name")}
                />
                {errors.name && (
                  <p className="text-xs text-destructive">{errors.name.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="personType">Tipo de Pessoa</Label>
                <Select
                  value={personType}
                  onValueChange={(value) => setValue("personType", value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PF">Pessoa Física</SelectItem>
                    <SelectItem value="PJ">Pessoa Jurídica</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="cpfCnpj">{personType === "PJ" ? "CNPJ" : "CPF"} *</Label>
                <div className="flex gap-2">
                  <Input
                    id="cpfCnpj"
                    placeholder={personType === "PJ" ? "00.000.000/0000-00" : "000.000.000-00"}
                    maxLength={personType === "PJ" ? 18 : 14}
                    {...register("cpfCnpj", {
                      onChange: (e) => {
                        const formatted = formatCpfCnpj(e.target.value);
                        setValue("cpfCnpj", formatted);
                        const clean = formatted.replace(/\D/g, "");
                        if (clean.length > 11) setValue("personType", "PJ");
                        if (clean.length === 14) lookupCnpj(formatted);
                      },
                    })}
                  />
                  {personType === "PJ" && (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      disabled={cnpjLoading}
                      onClick={() => lookupCnpj(watch("cpfCnpj") || "")}
                      title="Buscar CNPJ"
                    >
                      {cnpjLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    </Button>
                  )}
                </div>
                {errors.cpfCnpj && (
                  <p className="text-xs text-destructive">{errors.cpfCnpj.message}</p>
                )}
                {cnpjError && (
                  <p className="text-xs text-destructive">{cnpjError}</p>
                )}
              </div>

              {personType === "PJ" && (
                <div className="space-y-2">
                  <Label htmlFor="stateRegistration">Inscrição Estadual</Label>
                  <Input
                    id="stateRegistration"
                    placeholder="Inscrição estadual"
                    {...register("stateRegistration")}
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="email@exemplo.com"
                  {...register("email")}
                />
                {errors.email && (
                  <p className="text-xs text-destructive">{errors.email.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">Telefone</Label>
                <Input
                  id="phone"
                  placeholder="(00) 00000-0000 ou +55 11 99999 8888"
                  maxLength={22}
                  {...register("phone", {
                    onChange: (e) => {
                      setValue("phone", formatPhone(e.target.value));
                    },
                  })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email2">Email 2</Label>
                <Input
                  id="email2"
                  type="email"
                  placeholder="email2@exemplo.com"
                  {...register("email2")}
                />
                {errors.email2 && (
                  <p className="text-xs text-destructive">{errors.email2.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone2">Telefone 2</Label>
                <Input
                  id="phone2"
                  placeholder="(00) 00000-0000 ou +55 11 99999 8888"
                  maxLength={22}
                  {...register("phone2", {
                    onChange: (e) => {
                      setValue("phone2", formatPhone(e.target.value));
                    },
                  })}
                />
              </div>

              <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="rgNumber">RG</Label>
                  <Input
                    id="rgNumber"
                    placeholder="00.000.000-0"
                    {...register("rgNumber")}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rgIssuer">Órgão Expedidor</Label>
                  <Input
                    id="rgIssuer"
                    placeholder="SSP/SP"
                    {...register("rgIssuer")}
                  />
                </div>
              </div>

              {personType === "PF" && (
                <div className="space-y-2">
                  <Label htmlFor="birthDate">Data de Nascimento</Label>
                  <Input
                    id="birthDate"
                    type="date"
                    {...register("birthDate")}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Profissional */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Profissional
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="occupation">Profissao</Label>
                <Input
                  id="occupation"
                  placeholder="Ex: Engenheiro, Advogado"
                  {...register("occupation")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="monthlyIncome">Renda Mensal (R$)</Label>
                <Input
                  id="monthlyIncome"
                  type="number"
                  step="0.01"
                  placeholder="0,00"
                  {...register("monthlyIncome")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="paymentDay">Dia Pagamento Locatário</Label>
                <Input
                  id="paymentDay"
                  type="number"
                  min={1}
                  max={31}
                  placeholder="5"
                  {...register("paymentDay")}
                />
              </div>

            </div>
          </div>

          {/* Endereço */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Endereço
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="street">Rua</Label>
                <Input
                  id="street"
                  placeholder="Nome da rua"
                  {...register("street")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="number">Número</Label>
                <Input
                  id="number"
                  placeholder="123"
                  {...register("number")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="complement">Complemento</Label>
                <Input
                  id="complement"
                  placeholder="Apto, bloco, etc."
                  {...register("complement")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="neighborhood">Bairro</Label>
                <Input
                  id="neighborhood"
                  placeholder="Nome do bairro"
                  {...register("neighborhood")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="city">Cidade</Label>
                <Input
                  id="city"
                  placeholder="Nome da cidade"
                  {...register("city")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="state">Estado</Label>
                <Input
                  id="state"
                  placeholder="UF"
                  {...register("state")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="zipCode">CEP</Label>
                <div className="flex gap-2">
                  <Input
                    id="zipCode"
                    placeholder="00000-000"
                    maxLength={9}
                    {...register("zipCode", {
                      onChange: (e) => {
                        const formatted = formatCep(e.target.value);
                        setValue("zipCode", formatted);
                        if (formatted.length === 9) lookupCep(formatted);
                      },
                    })}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={cepLoading}
                    onClick={() => lookupCep(watch("zipCode") || "")}
                    title="Buscar CEP"
                  >
                    {cepLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  </Button>
                </div>
                {cepError && (
                  <p className="text-xs text-destructive">{cepError}</p>
                )}
              </div>
            </div>
          </div>

          {/* Observações */}
          <div className="space-y-2">
            <Label htmlFor="notes">Observações</Label>
            <Input
              id="notes"
              placeholder="Observações adicionais"
              {...register("notes")}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
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
