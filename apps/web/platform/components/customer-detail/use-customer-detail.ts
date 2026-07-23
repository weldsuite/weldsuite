
import type { CustomerDetailData, CustomerNavigationData } from './types';
import {
  useCompanyDetail,
  useCompanyNavigation,
} from '@/components/objects/company/use-company-data';
import {
  usePersonDetail,
  usePersonNavigation,
} from '@/components/objects/person/use-person-data';
import { useTranslations } from '@weldsuite/i18n/client';

interface UseCustomerDetailOptions {
  customerId: string;
  kind?: 'company' | 'person';
  listId?: string;
  initialData?: CustomerDetailData;
  enabled?: boolean;
}

interface UseCustomerDetailReturn {
  data: CustomerDetailData | null;
  navigation: CustomerNavigationData | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Hook to fetch and manage customer/person detail data.
 * Branches on `kind`: 'company' (default) → app-api /companies endpoints;
 * 'person' → app-api /people endpoints.
 */
function useCustomerDetail({
  customerId,
  kind = 'company',
  listId,
  initialData,
  enabled = true,
}: UseCustomerDetailOptions): UseCustomerDetailReturn {
  const t = useTranslations();
  const isCompany = kind === 'company';

  const companyDetailQuery = useCompanyDetail(
    customerId,
    { activitiesLimit: 20, ordersLimit: 20, opportunitiesLimit: 20, peopleLimit: 50 },
    enabled && !initialData && isCompany,
  );

  const personDetailQuery = usePersonDetail(
    customerId,
    { activitiesLimit: 20 },
    enabled && !initialData && !isCompany,
  );

  const companyNavQuery = useCompanyNavigation(customerId, listId, enabled && isCompany);
  const personNavQuery = usePersonNavigation(customerId, listId, enabled && !isCompany);

  const detailQuery = isCompany ? companyDetailQuery : personDetailQuery;
  const navQuery = isCompany ? companyNavQuery : personNavQuery;

  const data = initialData ?? (detailQuery.data?.data as CustomerDetailData | null ?? null);
  const navigation = navQuery.data?.data
    ? (navQuery.data.data as unknown as CustomerNavigationData)
    : null;

  const refresh = async () => {
    await Promise.all([detailQuery.refetch(), navQuery.refetch()]);
  };

  return {
    data,
    navigation,
    isLoading: detailQuery.isLoading,
    error: detailQuery.error
      ? detailQuery.error instanceof Error
        ? detailQuery.error.message
        : t('sweep.weldcrm.customerDetailProvider.errorOccurred')
      : null,
    refresh,
  };
}
