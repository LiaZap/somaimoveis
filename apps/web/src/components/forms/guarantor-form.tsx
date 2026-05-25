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

const guarantorSchema = z.object({
  name: z.string().min(1, "Nome é obrigatório"),
  personType: z.string().default("PF"),
  cpfCnpj: z.string().min(1, "CPF/CNPJ é obrigatório"),
  stateRegistration: z.string().optional(),
  maritalStatus: z.string().optional(),
  profession: z.string().optional(),
  rgNumber: z.string().optional(),
  rgIssuer: z.string().optional(),
  phone: z.string().optional(),
  phone2: z.string().optional(),
  email: z.string().email("Email invalido").or(z.literal("")).optional(),
  email2: z.string().email("Email invalido").or(z.literal("")).optional(),
  street: z.string().optional(),
  number: z.string().optional(),
  complement: z.string().optional(),
  neighborhood: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  propertyRegistration: z.string().optional(),
  notes: z.string().optional(),
});

type GuarantorFormData = z.infer<typeof guarantorSchema>;

interface GuarantorFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  guarantor?: any;
  onSuccess: (guarantor?: any) => void;
}

export function GuarantorForm({ open, onOpenChange, guarantor, onSuccess }: GuarantorFormProps) {
  const [loading, setLoading] = useState(false);
  const isEditing = !!guarantor;

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<GuarantorFormData>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(guarantorSchema) as any,
    defaultValues: {
      name: "",
      personType: "PF",
      cpfCnpj: "",
      stateRegistration: "",
      maritalStatus: "",
      profession: "",
      rgNumber: "",
      rgIssuer: "",
      phone: "",
      phone2: "",
      email: "",
      email2: "",
      street: "",
      number: "",
      complement: "",
      neighborhood: "",
      city: "",
      state: "",
      zipCode: "",
      propertyRegistration: "",
      notes: "",
    },
  });

  const selectedMaritalStatus = watch("maritalStatus");

  const handleCepResult = useCallback((data: { street: string; neighborhood: string; city: string; state: string }) => {
    setValue("street", data.street, { shouldValidate: true });
    setValue("neighborhood", data.neighborhood, { shouldValidate: true });
    setValue("city", data.city, { shouldValidate: true });
    setValue("state", data.state, { shouldValidate: true });
  }, [setValue]);

  const { lookup: lookupCep, loading: cepLoading, error: cepError, formatCep } = useCepLookup({ onResult: handleCepResult });

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const handleCnpjResult = useCallback(() => {}, []);
  const { formatCpfCnpj } = useCnpjLookup({ onResult: handleCnpjResult });

  const formatPhone = useCallback((value: string): string => formatPhoneShared(value), []);

  useEffect(() => {
    if (open) {
      if (guarantor) {
        reset({
          name: guarantor.name || "",
          cpfCnpj: guarantor.cpfCnpj || "",
          maritalStatus: guarantor.maritalStatus || "",
          profession: guarantor.profession || "",
          rgNumber: guarantor.rgNumber || "",
          rgIssuer: guarantor.rgIssuer || "",
          phone: guarantor.phone || "",
          phone2: guarantor.phone2 || "",
          email: guarantor.email || "",
          email2: guarantor.email2 || "",
          street: guarantor.street || "",
          number: guarantor.number || "",
          complement: guarantor.complement || "",
          neighborhood: guarantor.neighborhood || "",
          city: guarantor.city || "",
          state: guarantor.state || "",
          zipCode: guarantor.zipCode || "",
          propertyRegistration: guarantor.propertyRegistration || "",
          notes: guarantor.notes || "",
        });
      } else {
        reset({
          name: "", cpfCnpj: "", maritalStatus: "", profession: "",
          rgNumber: "", rgIssuer: "", phone: "", phone2: "", email: "", email2: "",
          street: "", number: "", complement: "", neighborhood: "",
          city: "", state: "", zipCode: "", propertyRegistration: "", notes: "",
        });
      }
    }
  }, [open, guarantor, reset]);

  async function onSubmit(data: GuarantorFormData) {
    setLoading(true);
    try {
      const url = isEditing ? `/api/guarantors/${guarantor.id}` : "/api/guarantors";
      const method = isEditing ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Erro ao salvar fiador");
      }

      const result = await response.json();
      onOpenChange(false);
      onSuccess(result);
    } catch (error: any) {
      toast.error(error.message || "Erro ao salvar fiador");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px] sm:max-h-[90vh]" preventOutsideClose>
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Editar Fiador" : "Novo Fiador"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Atualize as informacoes do fiador abaixo."
              : "Preencha as informacoes do novo fiador."}
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
                <Label htmlFor="g-name">Nome *</Label>
                <Input
                  id="g-name"
                  placeholder="Nome completo ou razão social"
                  {...register("name")}
                />
                {errors.name && (
                  <p className="text-xs text-destructive">{errors.name.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label>Tipo de Pessoa</Label>
                <Select
                  value={watch("personType") || "PF"}
                  onValueChange={(value) => setValue("personType", value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PF">Pessoa Física</SelectItem>
                    <SelectItem value="PJ">Pessoa Jurídica</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="g-cpfCnpj">{watch("personType") === "PJ" ? "CNPJ *" : "CPF *"}</Label>
                <Input
                  id="g-cpfCnpj"
                  placeholder={watch("personType") === "PJ" ? "00.000.000/0000-00" : "000.000.000-00"}
                  maxLength={watch("personType") === "PJ" ? 18 : 14}
                  {...register("cpfCnpj", {
                    onChange: (e) => {
                      const formatted = formatCpfCnpj(e.target.value);
                      setValue("cpfCnpj", formatted);
                    },
                  })}
                />
                {errors.cpfCnpj && (
                  <p className="text-xs text-destructive">{errors.cpfCnpj.message}</p>
                )}
              </div>

              {watch("personType") === "PJ" && (
                <div className="space-y-2">
                  <Label htmlFor="g-stateRegistration">Inscrição Estadual</Label>
                  <Input
                    id="g-stateRegistration"
                    placeholder="Inscrição estadual"
                    {...register("stateRegistration")}
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="g-maritalStatus">Estado Civil</Label>
                <Select
                  value={selectedMaritalStatus || ""}
                  onValueChange={(value) => setValue("maritalStatus", value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecione" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SOLTEIRO">Solteiro(a)</SelectItem>
                    <SelectItem value="CASADO">Casado(a)</SelectItem>
                    <SelectItem value="DIVORCIADO">Divorciado(a)</SelectItem>
                    <SelectItem value="VIUVO">Viuvo(a)</SelectItem>
                    <SelectItem value="UNIAO_ESTAVEL">Uniao Estavel</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="g-profession">Profissao</Label>
                <Input
                  id="g-profession"
                  placeholder="Ex: Engenheiro, Advogado"
                  {...register("profession")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="g-rgNumber">RG</Label>
                <Input
                  id="g-rgNumber"
                  placeholder="Número do RG"
                  {...register("rgNumber")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="g-rgIssuer">Órgão Expedidor</Label>
                <Input
                  id="g-rgIssuer"
                  placeholder="SSP, DETRAN, etc."
                  {...register("rgIssuer")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="g-phone">Telefone</Label>
                <Input
                  id="g-phone"
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
                <Label htmlFor="g-email">Email</Label>
                <Input
                  id="g-email"
                  type="email"
                  placeholder="email@exemplo.com"
                  {...register("email")}
                />
                {errors.email && (
                  <p className="text-xs text-destructive">{errors.email.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="g-phone2">Telefone 2</Label>
                <Input
                  id="g-phone2"
                  placeholder="(00) 00000-0000 ou +55 11 99999 8888"
                  maxLength={22}
                  {...register("phone2", {
                    onChange: (e) => {
                      setValue("phone2", formatPhone(e.target.value));
                    },
                  })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="g-email2">Email 2</Label>
                <Input
                  id="g-email2"
                  type="email"
                  placeholder="email2@exemplo.com"
                  {...register("email2")}
                />
                {errors.email2 && (
                  <p className="text-xs text-destructive">{errors.email2.message}</p>
                )}
              </div>
            </div>
          </div>

          {/* Endereço */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Endereço
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="g-zipCode">CEP</Label>
                <div className="flex gap-2">
                  <Input
                    id="g-zipCode"
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

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="g-street">Rua</Label>
                <Input
                  id="g-street"
                  placeholder="Nome da rua"
                  {...register("street")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="g-number">Número</Label>
                <Input
                  id="g-number"
                  placeholder="123"
                  {...register("number")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="g-complement">Complemento</Label>
                <Input
                  id="g-complement"
                  placeholder="Apto, bloco, etc."
                  {...register("complement")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="g-neighborhood">Bairro</Label>
                <Input
                  id="g-neighborhood"
                  placeholder="Nome do bairro"
                  {...register("neighborhood")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="g-city">Cidade</Label>
                <Input
                  id="g-city"
                  placeholder="Nome da cidade"
                  {...register("city")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="g-state">Estado</Label>
                <Input
                  id="g-state"
                  placeholder="UF"
                  maxLength={2}
                  {...register("state")}
                />
              </div>
            </div>
          </div>

          {/* Imóvel */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b pb-2">
              Imóvel do Fiador
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="g-propertyRegistration">Número da Matrícula do Imóvel</Label>
                <Input
                  id="g-propertyRegistration"
                  placeholder="Número de matrícula no cartório"
                  {...register("propertyRegistration")}
                />
              </div>
            </div>
          </div>

          {/* Observações */}
          <div className="space-y-2">
            <Label htmlFor="g-notes">Observações</Label>
            <Input
              id="g-notes"
              placeholder="Observações adicionais"
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
    </Dialog>
  );
}
