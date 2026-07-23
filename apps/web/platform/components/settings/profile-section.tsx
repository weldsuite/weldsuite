
import * as React from "react"
import { useTranslations } from '@weldsuite/i18n/client'
import { Upload, Save, Loader2, Check, ChevronsUpDown } from "lucide-react"
import { Button } from "@weldsuite/ui/components/button"
import { Input } from "@weldsuite/ui/components/input"
import { Label } from "@weldsuite/ui/components/label"
import { Textarea } from "@weldsuite/ui/components/textarea"
import { Avatar, AvatarFallback } from "@weldsuite/ui/components/avatar"
import { Popover, PopoverContent, PopoverTrigger } from "@weldsuite/ui/components/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@weldsuite/ui/components/command"
import { TIMEZONES } from "@/lib/timezones"
import { cn } from "@/lib/utils"

export interface ProfileData {
  name: string
  email: string
  nickname: string
  phone: string
  jobTitle: string
  bio: string
  timezone: string
  avatar: string
}

interface ProfileSectionProps {
  profileData: ProfileData
  profileChanged: boolean
  loading: boolean
  fileInputRef: React.RefObject<HTMLInputElement>
  onProfileChange: (field: keyof ProfileData, value: string) => void
  onProfileSave: () => void
  onProfileCancel: () => void
  onAvatarUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
}

export function ProfileSection({
  profileData,
  profileChanged,
  loading,
  fileInputRef,
  onProfileChange,
  onProfileSave,
  onProfileCancel,
  onAvatarUpload,
}: ProfileSectionProps) {
  const t = useTranslations()
  const [timezoneOpen, setTimezoneOpen] = React.useState(false)
  const selectedTz = TIMEZONES.find((tz) => tz.id === profileData.timezone)
  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('sweep.settings.profile.title')}</h1>
        <p className="text-muted-foreground">{t('sweep.settings.profile.description')}</p>
      </div>

      <div>
        <div className="space-y-4">
          {/* Avatar Upload Section */}
          <div className="flex items-center gap-4 mb-6">
            <div className="relative">
              <Avatar className="h-20 w-20 rounded-[1.25rem]">
                {profileData.avatar ? (
                  <img src={profileData.avatar} alt={t('sweep.settings.profile.avatarAlt')} className="object-cover" />
                ) : (
                  <AvatarFallback className="text-2xl rounded-[1.25rem]">
                    {profileData.name ? profileData.name.charAt(0).toUpperCase() : 'U'}
                  </AvatarFallback>
                )}
              </Avatar>
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium">{t('sweep.settings.profile.profilePicture')}</p>
              <p className="text-xs text-muted-foreground mb-2">{t('sweep.settings.profile.uploadAvatarHint')}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shadow-none"
                onClick={() => {
                  fileInputRef.current?.click()
                }}
                disabled={loading}
              >
                <Upload className="h-4 w-4 mr-0.5" />
                {t('sweep.settings.profile.chooseFile')}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                className="hidden"
                onChange={onAvatarUpload}
                disabled={loading}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="profile-name">{t('sweep.settings.profile.nameLabel')}</Label>
              <Input
                id="profile-name"
                placeholder={t('sweep.settings.profile.namePlaceholder')}
                value={profileData.name}
                onChange={(e) => onProfileChange('name', e.target.value)}
                className="mt-1.5 shadow-none"
              />
            </div>
            <div>
              <Label htmlFor="profile-email">{t('sweep.settings.profile.emailLabel')}</Label>
              <Input
                id="profile-email"
                type="email"
                value={profileData.email}
                disabled
                className="mt-1.5 opacity-60 shadow-none"
              />
              <p className="text-xs text-muted-foreground mt-1">{t('sweep.settings.profile.emailCannotChange')}</p>
            </div>
          </div>
          <div>
            <Label htmlFor="profile-phone">{t('sweep.settings.profile.phoneLabel')}</Label>
            <Input
              id="profile-phone"
              placeholder="+1 (555) 123-4567"
              value={profileData.phone}
              onChange={(e) => onProfileChange('phone', e.target.value)}
              className="mt-1.5 shadow-none"
            />
          </div>
          <div>
            <Label htmlFor="profile-job-title">{t('sweep.settings.profile.jobTitleLabel')}</Label>
            <Input
              id="profile-job-title"
              placeholder={t('sweep.settings.profile.jobTitlePlaceholder')}
              value={profileData.jobTitle}
              onChange={(e) => onProfileChange('jobTitle', e.target.value)}
              className="mt-1.5 shadow-none"
            />
          </div>
          <div>
            <Label htmlFor="profile-bio">{t('sweep.settings.profile.bioLabel')}</Label>
            <Textarea
              id="profile-bio"
              placeholder={t('sweep.settings.profile.bioPlaceholder')}
              value={profileData.bio}
              onChange={(e) => onProfileChange('bio', e.target.value)}
              className="mt-1.5 shadow-none"
              rows={4}
            />
          </div>
          <div>
            <Label htmlFor="profile-timezone">{t('sweep.settings.profile.timezoneLabel')}</Label>
            <Popover open={timezoneOpen} onOpenChange={setTimezoneOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  id="profile-timezone"
                  variant="outline"
                  role="combobox"
                  aria-expanded={timezoneOpen}
                  className={cn(
                    'mt-1.5 w-full justify-between font-normal shadow-none',
                    !selectedTz && 'text-muted-foreground',
                  )}
                >
                  {selectedTz ? selectedTz.label : t('sweep.settings.profile.selectTimezone')}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-[var(--radix-popover-trigger-width)] min-w-[var(--radix-popover-trigger-width)] p-0"
                align="start"
                onOpenAutoFocus={() => {
                  requestAnimationFrame(() => {
                    const list = document.querySelector<HTMLDivElement>(
                      '[data-profile-timezone-list]',
                    )
                    if (!list) return
                    const item = list.querySelector<HTMLElement>(
                      '[cmdk-item][data-selected="true"]',
                    )
                    if (!item) return
                    const offset =
                      item.offsetTop - list.clientHeight * 0.6 + item.clientHeight / 2
                    list.scrollTop = Math.max(0, offset)
                  })
                }}
              >
                <Command defaultValue={selectedTz?.label}>
                  <CommandInput placeholder={t('sweep.settings.profile.searchTimezonePlaceholder')} />
                  <CommandList
                    data-profile-timezone-list
                    className="max-h-[240px] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent"
                  >
                    <CommandEmpty>{t('sweep.settings.profile.noTimezoneFound')}</CommandEmpty>
                    <CommandGroup className="pr-0">
                      {TIMEZONES.map((tz) => {
                        const isCurrent = profileData.timezone === tz.id
                        return (
                          <CommandItem
                            key={tz.id}
                            value={tz.label}
                            onSelect={() => {
                              onProfileChange('timezone', tz.id)
                              setTimezoneOpen(false)
                            }}
                            className={cn(
                              'flex justify-between',
                              isCurrent && 'bg-accent text-accent-foreground',
                            )}
                          >
                            {tz.label}
                            <Check
                              className={cn(
                                'h-4 w-4',
                                isCurrent ? 'opacity-100' : 'opacity-0',
                              )}
                            />
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          {profileChanged && (
            <div className="flex items-center justify-end gap-2 pt-4">
              <Button
                variant="outline"
                size="sm"
                className="shadow-none"
                onClick={onProfileCancel}
              >
                {t('sweep.settings.profile.cancel')}
              </Button>
              <Button
                size="sm"
                className="shadow-none"
                onClick={onProfileSave}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('sweep.settings.profile.saving')}
                  </>
                ) : (
                  <>
                    <Save className="mr-2 h-4 w-4" />
                    {t('sweep.settings.profile.saveChanges')}
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
