import { t } from '@weldsuite/storefront-theme';
import type { HeadContext } from '../seo';
import type { ShopRequest } from './shop';

export function headContext(shop: ShopRequest): HeadContext {
  return {
    shopName: shop.site.channel.name,
    strings: t(shop.site.locale),
    primaryOrigin: shop.site.primaryOrigin,
    preview: shop.site.preview,
    seo: shop.doc.seo ?? {},
  };
}
