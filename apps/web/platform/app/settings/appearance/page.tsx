import * as React from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Slider } from '@weldsuite/ui/components/slider';
import { Separator } from '@weldsuite/ui/components/separator';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { cn } from '@/lib/utils';
import { useUserPreferences, useUpdateTheme, useUpdateFontSize } from '@/hooks/queries/use-settings-queries';
import { useTheme } from '@/hooks/use-theme';
import { toast } from 'sonner';
import { stableLanguages, languageNames, type Language } from '@/lib/i18n/locales';
import { useI18n } from '@/lib/i18n/provider';
import { useAppApiClient } from '@/lib/api/use-app-api';

export default function AppearanceSettingsPage() {
  const [theme, setThemeState] = React.useState<'light' | 'dark' | 'system'>('system');
  const [fontSize, setFontSize] = React.useState([16]);
  const { setTheme: setAppTheme } = useTheme();
  const { language, setLanguage, t } = useI18n();
  const { getClient } = useAppApiClient();
  const ta = t.settings.appearance;

  const { data: preferences, isLoading: loading } = useUserPreferences();
  const updateThemeMutation = useUpdateTheme();
  const updateFontSizeMutation = useUpdateFontSize();

  // Sync local state when preferences load
  React.useEffect(() => {
    if (preferences) {
      setThemeState(preferences.theme || 'system');
      setFontSize([preferences.fontSize || 16]);
    }
  }, [preferences]);

  const handleThemeChange = async (newTheme: 'light' | 'dark' | 'system') => {
    const previousTheme = theme;
    setThemeState(newTheme);
    setAppTheme(newTheme);

    try {
      await updateThemeMutation.mutateAsync(newTheme);
    } catch (error) {
      setThemeState(previousTheme);
      setAppTheme(previousTheme);
      toast.error(ta.messages.themeError);
    }
  };

  const handleFontSizeChange = async (newSize: number[]) => {
    const previousSize = fontSize;
    setFontSize(newSize);
    document.documentElement.style.fontSize = `${newSize[0]}px`;
    localStorage.setItem('fontSize', String(newSize[0]));

    try {
      await updateFontSizeMutation.mutateAsync(newSize[0]);
    } catch (error) {
      setFontSize(previousSize);
      document.documentElement.style.fontSize = `${previousSize[0]}px`;
      localStorage.setItem('fontSize', String(previousSize[0]));
      toast.error(ta.messages.fontSizeError);
    }
  };

  if (loading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ta.title}</h1>
        <p className="text-muted-foreground">{ta.description}</p>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">{ta.theme.title}</h3>
        <RadioGroup value={theme} onValueChange={(value) => handleThemeChange(value as 'light' | 'dark' | 'system')}>
          <div className="grid grid-cols-3 gap-4">
            {/* Light theme */}
            <label className="cursor-pointer">
              <RadioGroupItem value="light" className="sr-only" />
              <div
                className={cn(
                  'rounded-xl overflow-hidden border-2 transition-all',
                  theme === 'light'
                    ? 'border-blue-500'
                    : 'border-gray-200 dark:border-[#333] hover:border-gray-300 dark:hover:border-[#444]'
                )}
              >
                <svg viewBox="0 0 200 105" fill="none" className="w-full block">
                  <rect width="200" height="130" fill="#ffffff" />
                  <rect width="56" height="130" fill="#f5f5f6" />
                  <line x1="56" y1="0" x2="56" y2="130" stroke="#ebebeb" strokeWidth="0.5" />
                  <rect x="12" y="10" width="10" height="10" rx="2.5" fill="#dedede" />
                  <rect x="12" y="30" width="30" height="2.5" rx="1.25" fill="#d0d0d0" />
                  <rect x="12" y="37" width="22" height="2.5" rx="1.25" fill="#dedede" />
                  <rect x="12" y="44" width="26" height="2.5" rx="1.25" fill="#dedede" />
                  <rect x="12" y="51" width="18" height="2.5" rx="1.25" fill="#dedede" />
                  <rect x="12" y="58" width="24" height="2.5" rx="1.25" fill="#dedede" />
                  <rect x="12" y="65" width="16" height="2.5" rx="1.25" fill="#dedede" />
                  <rect x="68" y="12" width="44" height="2.5" rx="1.25" fill="#d0d0d0" />
                  <line x1="68" y1="24" x2="188" y2="24" stroke="#f0f0f0" strokeWidth="0.5" />
                  <rect x="68" y="29" width="26" height="2" rx="1" fill="#d8d8d8" />
                  <rect x="108" y="29" width="22" height="2" rx="1" fill="#d8d8d8" />
                  <rect x="144" y="29" width="18" height="2" rx="1" fill="#d8d8d8" />
                  <line x1="68" y1="37" x2="188" y2="37" stroke="#f0f0f0" strokeWidth="0.5" />
                  <rect x="68" y="42" width="24" height="2.5" rx="1.25" fill="#e4e4e4" />
                  <rect x="108" y="42" width="18" height="2.5" rx="1.25" fill="#eeeeee" />
                  <rect x="144" y="42" width="14" height="2.5" rx="1.25" fill="#f0f0f0" />
                  <line x1="68" y1="51" x2="188" y2="51" stroke="#f0f0f0" strokeWidth="0.5" />
                  <rect x="68" y="56" width="22" height="2.5" rx="1.25" fill="#e4e4e4" />

                  <rect x="144" y="56" width="10" height="2.5" rx="1.25" fill="#f0f0f0" />
                  <line x1="68" y1="65" x2="188" y2="65" stroke="#f0f0f0" strokeWidth="0.5" />
                  <rect x="68" y="70" width="30" height="2.5" rx="1.25" fill="#e4e4e4" />
                  <rect x="108" y="70" width="16" height="2.5" rx="1.25" fill="#eeeeee" />
                  <rect x="144" y="70" width="20" height="2.5" rx="1.25" fill="#f0f0f0" />
                  <line x1="68" y1="79" x2="188" y2="79" stroke="#f0f0f0" strokeWidth="0.5" />
                  <rect x="68" y="84" width="26" height="2.5" rx="1.25" fill="#e4e4e4" />
                  <rect x="108" y="84" width="20" height="2.5" rx="1.25" fill="#eeeeee" />
                  <rect x="144" y="84" width="16" height="2.5" rx="1.25" fill="#f0f0f0" />
                  <line x1="68" y1="93" x2="188" y2="93" stroke="#f0f0f0" strokeWidth="0.5" />
                  <rect x="68" y="98" width="20" height="2.5" rx="1.25" fill="#e4e4e4" />
                  <rect x="108" y="98" width="24" height="2.5" rx="1.25" fill="#eeeeee" />
                  <rect x="144" y="98" width="12" height="2.5" rx="1.25" fill="#f0f0f0" />
                </svg>
              </div>
              <div className="flex items-center justify-center gap-1.5 mt-2.5">
                <Sun className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-medium">{ta.theme.light}</span>
              </div>
            </label>

            {/* Dark theme */}
            <label className="cursor-pointer">
              <RadioGroupItem value="dark" className="sr-only" />
              <div
                className={cn(
                  'rounded-xl overflow-hidden border-2 transition-all',
                  theme === 'dark'
                    ? 'border-blue-500'
                    : 'border-gray-200 dark:border-[#333] hover:border-gray-300 dark:hover:border-[#444]'
                )}
              >
                <svg viewBox="0 0 200 105" fill="none" className="w-full block">
                  <rect width="200" height="130" fill="#111113" />
                  <rect width="56" height="130" fill="#1c1c1e" />
                  <line x1="56" y1="0" x2="56" y2="130" stroke="#2a2a2c" strokeWidth="0.5" />
                  <rect x="12" y="10" width="10" height="10" rx="2.5" fill="#333335" />
                  <rect x="12" y="30" width="30" height="2.5" rx="1.25" fill="#3a3a3c" />
                  <rect x="12" y="37" width="22" height="2.5" rx="1.25" fill="#333335" />
                  <rect x="12" y="44" width="26" height="2.5" rx="1.25" fill="#333335" />
                  <rect x="12" y="51" width="18" height="2.5" rx="1.25" fill="#333335" />
                  <rect x="12" y="58" width="24" height="2.5" rx="1.25" fill="#333335" />
                  <rect x="12" y="65" width="16" height="2.5" rx="1.25" fill="#333335" />
                  <rect x="68" y="12" width="44" height="2.5" rx="1.25" fill="#3a3a3c" />
                  <line x1="68" y1="24" x2="188" y2="24" stroke="#222224" strokeWidth="0.5" />
                  <rect x="68" y="29" width="26" height="2" rx="1" fill="#3a3a3c" />
                  <rect x="108" y="29" width="22" height="2" rx="1" fill="#3a3a3c" />
                  <rect x="144" y="29" width="18" height="2" rx="1" fill="#3a3a3c" />
                  <line x1="68" y1="37" x2="188" y2="37" stroke="#222224" strokeWidth="0.5" />
                  <rect x="68" y="42" width="24" height="2.5" rx="1.25" fill="#333335" />
                  <rect x="108" y="42" width="18" height="2.5" rx="1.25" fill="#2a2a2c" />
                  <rect x="144" y="42" width="14" height="2.5" rx="1.25" fill="#222224" />
                  <line x1="68" y1="51" x2="188" y2="51" stroke="#222224" strokeWidth="0.5" />
                  <rect x="68" y="56" width="22" height="2.5" rx="1.25" fill="#333335" />

                  <rect x="144" y="56" width="10" height="2.5" rx="1.25" fill="#222224" />
                  <line x1="68" y1="65" x2="188" y2="65" stroke="#222224" strokeWidth="0.5" />
                  <rect x="68" y="70" width="30" height="2.5" rx="1.25" fill="#333335" />
                  <rect x="108" y="70" width="16" height="2.5" rx="1.25" fill="#2a2a2c" />
                  <rect x="144" y="70" width="20" height="2.5" rx="1.25" fill="#222224" />
                  <line x1="68" y1="79" x2="188" y2="79" stroke="#222224" strokeWidth="0.5" />
                  <rect x="68" y="84" width="26" height="2.5" rx="1.25" fill="#333335" />
                  <rect x="108" y="84" width="20" height="2.5" rx="1.25" fill="#2a2a2c" />
                  <rect x="144" y="84" width="16" height="2.5" rx="1.25" fill="#222224" />
                  <line x1="68" y1="93" x2="188" y2="93" stroke="#222224" strokeWidth="0.5" />
                  <rect x="68" y="98" width="20" height="2.5" rx="1.25" fill="#333335" />
                  <rect x="108" y="98" width="24" height="2.5" rx="1.25" fill="#2a2a2c" />
                  <rect x="144" y="98" width="12" height="2.5" rx="1.25" fill="#222224" />
                </svg>
              </div>
              <div className="flex items-center justify-center gap-1.5 mt-2.5">
                <Moon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-medium">{ta.theme.dark}</span>
              </div>
            </label>

            {/* System theme */}
            <label className="cursor-pointer">
              <RadioGroupItem value="system" className="sr-only" />
              <div
                className={cn(
                  'rounded-xl overflow-hidden border-2 transition-all',
                  theme === 'system'
                    ? 'border-blue-500'
                    : 'border-gray-200 dark:border-[#333] hover:border-gray-300 dark:hover:border-[#444]'
                )}
              >
                <svg viewBox="0 0 200 105" fill="none" className="w-full block">
                  <defs>
                    <clipPath id="system-left"><rect width="100" height="130" /></clipPath>
                    <clipPath id="system-right"><rect x="100" width="100" height="130" /></clipPath>
                  </defs>
                  {/* Left half - Light */}
                  <g clipPath="url(#system-left)">
                    <rect width="200" height="130" fill="#ffffff" />
                    <rect width="56" height="130" fill="#f5f5f6" />
                    <line x1="56" y1="0" x2="56" y2="130" stroke="#ebebeb" strokeWidth="0.5" />
                    <rect x="12" y="10" width="10" height="10" rx="2.5" fill="#dedede" />
                    <rect x="12" y="30" width="30" height="2.5" rx="1.25" fill="#d0d0d0" />
                    <rect x="12" y="37" width="22" height="2.5" rx="1.25" fill="#dedede" />
                    <rect x="12" y="44" width="26" height="2.5" rx="1.25" fill="#dedede" />
                    <rect x="12" y="51" width="18" height="2.5" rx="1.25" fill="#dedede" />
                    <rect x="12" y="58" width="24" height="2.5" rx="1.25" fill="#dedede" />
                    <rect x="12" y="65" width="16" height="2.5" rx="1.25" fill="#dedede" />
                    <rect x="68" y="12" width="44" height="2.5" rx="1.25" fill="#d0d0d0" />
                    <line x1="68" y1="24" x2="188" y2="24" stroke="#f0f0f0" strokeWidth="0.5" />
                    <rect x="68" y="29" width="26" height="2" rx="1" fill="#d8d8d8" />
                    <line x1="68" y1="37" x2="188" y2="37" stroke="#f0f0f0" strokeWidth="0.5" />
                    <rect x="68" y="42" width="24" height="2.5" rx="1.25" fill="#e4e4e4" />
                    <line x1="68" y1="51" x2="188" y2="51" stroke="#f0f0f0" strokeWidth="0.5" />
                    <rect x="68" y="56" width="22" height="2.5" rx="1.25" fill="#e4e4e4" />
                    <line x1="68" y1="65" x2="188" y2="65" stroke="#f0f0f0" strokeWidth="0.5" />
                    <rect x="68" y="70" width="30" height="2.5" rx="1.25" fill="#e4e4e4" />
                    <line x1="68" y1="79" x2="188" y2="79" stroke="#f0f0f0" strokeWidth="0.5" />
                    <rect x="68" y="84" width="26" height="2.5" rx="1.25" fill="#e4e4e4" />
                    <line x1="68" y1="93" x2="188" y2="93" stroke="#f0f0f0" strokeWidth="0.5" />
                    <rect x="68" y="98" width="20" height="2.5" rx="1.25" fill="#e4e4e4" />
                  </g>
                  {/* Right half - Dark */}
                  <g clipPath="url(#system-right)">
                    <rect width="200" height="130" fill="#111113" />
                    <rect width="56" height="130" fill="#1c1c1e" />
                    <line x1="56" y1="0" x2="56" y2="130" stroke="#2a2a2c" strokeWidth="0.5" />
                    <rect x="68" y="12" width="44" height="2.5" rx="1.25" fill="#3a3a3c" />
                    <line x1="68" y1="24" x2="188" y2="24" stroke="#222224" strokeWidth="0.5" />
                    <rect x="68" y="29" width="26" height="2" rx="1" fill="#3a3a3c" />
                    <rect x="108" y="29" width="22" height="2" rx="1" fill="#3a3a3c" />
                    <rect x="144" y="29" width="18" height="2" rx="1" fill="#3a3a3c" />
                    <line x1="68" y1="37" x2="188" y2="37" stroke="#222224" strokeWidth="0.5" />
                    <rect x="68" y="42" width="24" height="2.5" rx="1.25" fill="#333335" />
                    <rect x="108" y="42" width="18" height="2.5" rx="1.25" fill="#2a2a2c" />
                    <rect x="144" y="42" width="14" height="2.5" rx="1.25" fill="#222224" />
                    <line x1="68" y1="51" x2="188" y2="51" stroke="#222224" strokeWidth="0.5" />
                    <rect x="68" y="56" width="22" height="2.5" rx="1.25" fill="#333335" />

                    <rect x="144" y="56" width="10" height="2.5" rx="1.25" fill="#222224" />
                    <line x1="68" y1="65" x2="188" y2="65" stroke="#222224" strokeWidth="0.5" />
                    <rect x="68" y="70" width="30" height="2.5" rx="1.25" fill="#333335" />
                    <rect x="108" y="70" width="16" height="2.5" rx="1.25" fill="#2a2a2c" />
                    <rect x="144" y="70" width="20" height="2.5" rx="1.25" fill="#222224" />
                    <line x1="68" y1="79" x2="188" y2="79" stroke="#222224" strokeWidth="0.5" />
                    <rect x="68" y="84" width="26" height="2.5" rx="1.25" fill="#333335" />
                    <rect x="108" y="84" width="20" height="2.5" rx="1.25" fill="#2a2a2c" />
                    <rect x="144" y="84" width="16" height="2.5" rx="1.25" fill="#222224" />
                    <line x1="68" y1="93" x2="188" y2="93" stroke="#222224" strokeWidth="0.5" />
                    <rect x="68" y="98" width="20" height="2.5" rx="1.25" fill="#333335" />
                    <rect x="108" y="98" width="24" height="2.5" rx="1.25" fill="#2a2a2c" />
                    <rect x="144" y="98" width="12" height="2.5" rx="1.25" fill="#222224" />
                  </g>
                </svg>
              </div>
              <div className="flex items-center justify-center gap-1.5 mt-2.5">
                <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-medium">{ta.theme.system}</span>
              </div>
            </label>
          </div>
        </RadioGroup>
      </div>

      <Separator />

      <div>
        <h3 className="text-lg font-semibold mb-4">{ta.fontSize.title}</h3>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">{ta.fontSize.size}</span>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{fontSize[0]}px</span>
              {fontSize[0] !== 16 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleFontSizeChange([16])}
                >
                  {ta.fontSize.reset}
                </Button>
              )}
            </div>
          </div>
          <Slider
            value={fontSize}
            onValueChange={handleFontSizeChange}
            min={12}
            max={20}
            step={1}
            className="w-full"
          />
        </div>
      </div>

      <Separator />

      <div>
        <h3 className="text-lg font-semibold mb-4">{ta.language.title}</h3>
        <Select
          value={language}
          onValueChange={async (locale: string) => {
            try {
              setLanguage(locale as Language);
              const client = await getClient();
              // app-api PUT /api/user-preferences (was /settings/preferences).
              await client.put('/user-preferences', { language: locale });
            } catch (error) {
              toast.error(ta.messages.languageError);
            }
          }}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {stableLanguages.map((lang) => (
              <SelectItem key={lang} value={lang}>
                {languageNames[lang]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
