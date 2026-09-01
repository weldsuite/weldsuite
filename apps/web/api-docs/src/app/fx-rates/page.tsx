import { CrudResourcePage } from '@/components/CrudResourcePage'
import { WELDBOOKS_RESOURCE_CONFIGS } from '@/lib/weldbooks-resource-configs'

export default function Page() {
  return <CrudResourcePage config={WELDBOOKS_RESOURCE_CONFIGS['fx-rates']} />
}
