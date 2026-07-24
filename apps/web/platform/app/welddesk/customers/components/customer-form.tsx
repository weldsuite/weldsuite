
import { useState, useTransition } from "react";
import { useRouter } from '@/lib/router';
import { toast } from "sonner";
import { FormInput } from "@weldsuite/ui/components/form-field";
import { Label } from "@weldsuite/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@weldsuite/ui/components/select";
import { Badge } from "@weldsuite/ui/components/badge";
import { User, Building, MapPin } from "lucide-react";
import { EntityFormLayout, type FormSection, type SummaryField } from "@/components/entity-overview";
import { useCreateHelpdeskCustomer } from "@/hooks/queries/use-helpdesk-queries";
import { useI18n } from "@/lib/i18n/provider";
import { useTranslations } from "@weldsuite/i18n/client";

export function CustomerForm() {
  const router = useRouter();
  const { t } = useI18n();
  const st = useTranslations();
  const tc = t.helpdesk.customers;
  const [isPending] = useTransition();
  const createCustomerMutation = useCreateHelpdeskCustomer();

  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    company: "",
    status: "active" as "active" | "inactive",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.firstName || !formData.lastName || !formData.email) {
      toast.error(tc.validationError, {
        description: tc.fillRequiredFields,
      });
      return;
    }

    createCustomerMutation.mutate(
      {
        firstName: formData.firstName,
        lastName: formData.lastName,
        email: formData.email,
        phone: formData.phone || undefined,
        company: formData.company || undefined,
        accountStatus: formData.status,
      },
      {
        onSuccess: (result) => {
          if (result.success) {
            toast.success(tc.customerCreatedSuccess);
            router.push("/welddesk/contacts");
          } else {
            toast.error(tc.failedToCreateCustomer, {
              description: result.error || tc.unexpectedError,
            });
          }
        },
        onError: (error: Error) => {
          toast.error(tc.failedToCreateCustomer, {
            description: error.message || tc.unexpectedError,
          });
        },
      }
    );
  };

  const fullName =
    formData.firstName && formData.lastName
      ? `${formData.firstName} ${formData.lastName}`
      : formData.firstName || formData.lastName || tc.newCustomer;

  const sections: FormSection[] = [
    {
      title: tc.basicInformation,
      icon: User,
      description: "",
      content: (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormInput
              id="firstName"
              label={tc.firstName}
              required
              value={formData.firstName}
              onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
              placeholder={tc.enterFirstName}
              className="shadow-none"
            />
            <FormInput
              id="lastName"
              label={tc.lastName}
              required
              value={formData.lastName}
              onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
              placeholder={tc.enterLastName}
              className="shadow-none"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormInput
              id="email"
              label={tc.email}
              type="email"
              required
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              placeholder={st('sweep.welddesk.customerForm.emailPlaceholder')}
              className="shadow-none"
            />
            <FormInput
              id="phone"
              label={tc.phone}
              type="tel"
              value={formData.phone}
              onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              placeholder={st('sweep.welddesk.customerForm.phonePlaceholder')}
              className="shadow-none"
            />
          </div>
        </>
      ),
    },
    {
      title: tc.company,
      icon: Building,
      description: "",
      content: (
        <FormInput
          id="company"
          label={tc.companyName}
          value={formData.company}
          onChange={(e) => setFormData({ ...formData, company: e.target.value })}
          placeholder={tc.enterCompanyOptional}
          className="shadow-none"
        />
      ),
    },
    {
      title: tc.status,
      icon: MapPin,
      content: (
        <div className="space-y-2 max-w-xs">
          <Label htmlFor="status">{tc.accountStatus}</Label>
          <Select
            value={formData.status}
            onValueChange={(value: "active" | "inactive") =>
              setFormData({ ...formData, status: value })
            }
          >
            <SelectTrigger className="shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">{tc.active}</SelectItem>
              <SelectItem value="inactive">{tc.inactive}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ),
    },
  ];

  const summaryFields: SummaryField[] = [
    { label: tc.name, value: fullName },
    { label: tc.email, value: formData.email || "—" },
    { label: tc.phone, value: formData.phone || "—", hideIfEmpty: !formData.phone },
    { label: tc.company, value: formData.company || "—", hideIfEmpty: !formData.company },
    {
      label: tc.status,
      value: (
        <Badge variant={formData.status === "active" ? "default" : "secondary"} className="capitalize">
          {formData.status === "active" ? tc.active : tc.inactive}
        </Badge>
      ),
      bordered: true,
    },
  ];

  return (
    <EntityFormLayout
      title={tc.addContact}
      subtitle={tc.createContactSubtitle}
      sections={sections}
      summaryTitle={tc.contactSummary}
      summaryIcon={User}
      summaryFields={summaryFields}
      onSubmit={handleSubmit}
      isPending={isPending}
      submitText={tc.createContact}
      cancelLink="/welddesk/contacts"
      showBackButton={true}
      backLink="/welddesk/contacts"
      backButtonText={tc.backToContactsButton}
    />
  );
}
