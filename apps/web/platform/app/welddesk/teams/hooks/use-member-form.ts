/**
 * Hook for member form management
 * Handles form state, validation, and submission logic
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from '@/lib/router';
import { useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateAgent, useUpdateAgent } from '@/hooks/queries/use-helpdesk-queries';

// Form validation schema
export const memberFormSchema = z.object({
  userId: z.string().min(1, 'Please select a user'),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  role: z.enum(['agent', 'senior_agent', 'team_lead', 'supervisor', 'admin']),
  status: z.enum(['active', 'inactive', 'on_leave', 'training']),
  availability: z.enum(['available', 'busy', 'away', 'offline']),
  maxActiveTickets: z.string().optional(),
  skills: z.string().optional(),
  languages: z.string().optional(),
});

export type MemberFormValues = z.infer<typeof memberFormSchema>;

export interface User {
  id: string;
  email: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
}

export interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: 'agent' | 'senior_agent' | 'team_lead' | 'supervisor' | 'admin';
  status: 'active' | 'inactive' | 'on_leave' | 'training';
  availability: 'available' | 'busy' | 'away' | 'offline';
  maxActiveTickets?: number;
  skills?: string[];
  languages?: string[];
}

interface UseMemberFormProps {
  departmentId: string;
  users: User[];
  member?: Member;
  mode: 'add' | 'edit';
}

interface UseMemberFormReturn {
  form: ReturnType<typeof useForm<MemberFormValues>>;
  onSubmit: (data: MemberFormValues) => Promise<void>;
  isSubmitting: boolean;
  handleUserSelect: (userId: string) => void;
}

export function useMemberForm({
  departmentId,
  users,
  member,
  mode,
}: UseMemberFormProps): UseMemberFormReturn {
  const { t } = useI18n();
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const createAgentMutation = useCreateAgent();
  const updateAgentMutation = useUpdateAgent();

  const form = useForm<MemberFormValues>({
    resolver: zodResolver(memberFormSchema),
    defaultValues: member
      ? {
          userId: member.userId,
          name: member.name,
          email: member.email,
          role: member.role,
          status: member.status,
          availability: member.availability,
          maxActiveTickets: member.maxActiveTickets?.toString() || '',
          skills: member.skills?.join(', ') || '',
          languages: member.languages?.join(', ') || '',
        }
      : {
          userId: '',
          name: '',
          email: '',
          role: 'agent',
          status: 'active',
          availability: 'available',
          maxActiveTickets: '',
          skills: '',
          languages: '',
        },
  });

  const handleUserSelect = (userId: string) => {
    const user = users.find((u) => u.id === userId);
    if (user) {
      form.setValue('userId', user.id);
      form.setValue(
        'name',
        user.fullName || `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email
      );
      form.setValue('email', user.email);
    }
  };

  const onSubmit = async (data: MemberFormValues) => {
    setIsSubmitting(true);
    try {
      const payload = {
        userId: data.userId,
        name: data.name,
        email: data.email,
        role: data.role,
        departmentId,
        status: data.status,
        availability: data.availability,
        maxActiveTickets: data.maxActiveTickets ? parseInt(data.maxActiveTickets) : undefined,
        skills: data.skills ? data.skills.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        languages: data.languages ? data.languages.split(',').map((l) => l.trim()).filter(Boolean) : undefined,
      };

      if (mode === 'edit' && member) {
        await updateAgentMutation.mutateAsync({ id: member.id, data: payload });
        toast.success(t.helpdesk.teamsPage.teamMemberUpdated);
        router.push(`/welddesk/teams/${departmentId}`);
      } else {
        await createAgentMutation.mutateAsync(payload);
        toast.success(t.helpdesk.teamsPage.teamMemberAdded);
        router.push(`/welddesk/teams/${departmentId}`);
      }
    } catch (error: any) {
      console.error('Error saving member:', error);
      toast.error(
        mode === 'edit' ? t.helpdesk.teamsPage.failedToUpdateTeamMember : t.helpdesk.teamsPage.failedToAddTeamMember,
        { description: error.message }
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    form,
    onSubmit,
    isSubmitting,
    handleUserSelect,
  };
}
