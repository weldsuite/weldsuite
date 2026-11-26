import { DEFAULT_UI_LABELS, UiLabelsProvider } from '@weldsuite/ui/providers/ui-labels-provider';
import { t } from '../lib/i18n';
import { App } from '../popup/App';
import { mount } from './mount';

// The shared @weldsuite/ui components in the popup (the toolbar's filter
// pills) take their few words from here, in the browser's language.
const labels = {
  ...DEFAULT_UI_LABELS,
  search: t('searchLabel'),
  // The login details page's back button: it always returns to the logins.
  back: t('backToLogins'),
  remove: t('filterRemove'),
  retry: t('retry'),
  loading: t('loading'),
  cancel: t('cancel'),
};

mount(
  <UiLabelsProvider labels={labels}>
    <App />
  </UiLabelsProvider>,
);
