/**
 * Hook for department form management
 * Handles form state, validation, and submission logic
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from '@/lib/router';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateDepartment, useUpdateDepartment } from '@/hooks/queries/use-helpdesk-queries';

// Day hours schema for business hours
const dayHoursSchema = z.object({
  isOpen: z.boolean(),
  openTime: z.string().optional(),
  closeTime: z.string().optional(),
});

// Form validation schema
export const departmentFormSchema = z.object({
  name: z.string().min(1, 'Department name is required'),
  description: z.string().optional(),
  email: z.string().email('Invalid email address').optional().or(z.literal('')),
  autoAssignment: z.boolean(),
  roundRobinAssignment: z.boolean(),
  defaultPriority: z.enum(['low', 'medium', 'high', 'urgent', 'critical']),
  isActive: z.boolean(),
  replyTime: z.enum(['few_minutes', 'few_hours', 'a_day']).optional(),
  businessHours: z.object({
    timezone: z.string(),
    monday: dayHoursSchema,
    tuesday: dayHoursSchema,
    wednesday: dayHoursSchema,
    thursday: dayHoursSchema,
    friday: dayHoursSchema,
    saturday: dayHoursSchema,
    sunday: dayHoursSchema,
  }).optional(),
});

export type DepartmentFormValues = z.infer<typeof departmentFormSchema>;

export interface DayHours {
  isOpen: boolean;
  openTime?: string;
  closeTime?: string;
}

export interface BusinessHours {
  timezone: string;
  monday?: DayHours;
  tuesday?: DayHours;
  wednesday?: DayHours;
  thursday?: DayHours;
  friday?: DayHours;
  saturday?: DayHours;
  sunday?: DayHours;
}

export interface Department {
  id: string;
  name: string;
  description?: string;
  email?: string;
  autoAssignment?: boolean;
  roundRobinAssignment?: boolean;
  defaultPriority?: 'low' | 'medium' | 'high' | 'urgent' | 'critical';
  isActive: boolean;
  replyTime?: 'few_minutes' | 'few_hours' | 'a_day';
  businessHours?: BusinessHours;
}

interface UseDepartmentFormProps {
  /** Existing department for edit mode */
  department?: Department;
  /** Form mode: 'add' or 'edit' */
  mode: 'add' | 'edit';
}

interface UseDepartmentFormReturn {
  /** React Hook Form instance */
  form: ReturnType<typeof useForm<DepartmentFormValues>>;
  /** Form submission handler */
  onSubmit: (data: DepartmentFormValues) => Promise<void>;
  /** Whether form submission is in progress */
  isPending: boolean;
}

/**
 * Hook to manage department form state and submission
 */
export function useDepartmentForm({
  department,
  mode,
}: UseDepartmentFormProps): UseDepartmentFormReturn {
  const { t } = useI18n();
  const router = useRouter();
  const [isPending] = useTransition();
  const createDepartmentMutation = useCreateDepartment();
  const updateDepartmentMutation = useUpdateDepartment();

  // Initialize form with react-hook-form and Zod validation
  const form = useForm<DepartmentFormValues>({
    resolver: zodResolver(departmentFormSchema),
    defaultValues: department
      ? {
          name: department.name || '',
          description: department.description || '',
          email: department.email || '',
          autoAssignment: department.autoAssignment ?? false,
          roundRobinAssignment: department.roundRobinAssignment ?? false,
          defaultPriority: department.defaultPriority || 'medium',
          isActive: department.isActive ?? true,
          replyTime: department.replyTime,
          businessHours: department.businessHours ? {
            timezone: department.businessHours.timezone,
            monday: department.businessHours.monday ?? { isOpen: true, openTime: '09:00', closeTime: '17:00' },
            tuesday: department.businessHours.tuesday ?? { isOpen: true, openTime: '09:00', closeTime: '17:00' },
            wednesday: department.businessHours.wednesday ?? { isOpen: true, openTime: '09:00', closeTime: '17:00' },
            thursday: department.businessHours.thursday ?? { isOpen: true, openTime: '09:00', closeTime: '17:00' },
            friday: department.businessHours.friday ?? { isOpen: true, openTime: '09:00', closeTime: '17:00' },
            saturday: department.businessHours.saturday ?? { isOpen: false },
            sunday: department.businessHours.sunday ?? { isOpen: false },
          } : undefined,
        }
      : {
          name: '',
          description: '',
          email: '',
          autoAssignment: false,
          roundRobinAssignment: false,
          defaultPriority: 'medium',
          isActive: true,
          replyTime: undefined,
          businessHours: undefined,
        },
  });

  // Handle form submission
  const onSubmit = async (data: DepartmentFormValues) => {
    try {
      if (mode === 'edit' && department) {
        await updateDepartmentMutation.mutateAsync({
          id: department.id,
          data: {
            name: data.name,
            description: data.description || undefined,
            email: data.email || undefined,
            autoAssignment: data.autoAssignment,
            roundRobinAssignment: data.roundRobinAssignment,
            defaultPriority: data.defaultPriority,
            isActive: data.isActive,
            replyTime: data.replyTime,
            businessHours: data.businessHours,
          },
        });

        toast.success(t.helpdesk.teamsPage.departmentUpdated);
        router.push(`/welddesk/teams/${department.id}`);
      } else {
        const result = await createDepartmentMutation.mutateAsync({
          name: data.name,
          description: data.description || undefined,
          email: data.email || undefined,
          autoAssignment: data.autoAssignment,
          roundRobinAssignment: data.roundRobinAssignment,
          defaultPriority: data.defaultPriority,
          isActive: data.isActive,
          replyTime: data.replyTime,
          businessHours: data.businessHours,
        });

        toast.success(t.helpdesk.teamsPage.departmentCreated);

        // Navigate to the new department or back to the list
        if (result?.id) {
          router.push(`/welddesk/teams/${result.id}`);
        } else {
          router.push('/welddesk/teams');
        }
      }
    } catch (error) {
      console.error('Error saving department:', error);
      toast.error(
        mode === 'edit' ? t.helpdesk.teamsPage.failedToUpdateDepartment : t.helpdesk.teamsPage.failedToCreateDepartment,
        { description: error instanceof Error ? error.message : undefined }
      );
    }
  };

  return {
    form,
    onSubmit,
    isPending: isPending || createDepartmentMutation.isPending || updateDepartmentMutation.isPending,
  };
}
