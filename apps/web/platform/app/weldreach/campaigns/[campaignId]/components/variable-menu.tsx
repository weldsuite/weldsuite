/** "Insert variable": the template variables and the custom fields seen on prospects. */

import { Braces } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';
import { REACH_TEMPLATE_VARIABLES } from '@weldsuite/app-api-client/schemas/reach';
import { variableToken } from '../../lib/sequence';

type TemplateVariable = (typeof REACH_TEMPLATE_VARIABLES)[number];

const VARIABLE_DESCRIPTION: Record<TemplateVariable, string> = {
  firstName: 'reachEngage.sequence.variables.firstName',
  lastName: 'reachEngage.sequence.variables.lastName',
  fullName: 'reachEngage.sequence.variables.fullName',
  email: 'reachEngage.sequence.variables.email',
  companyName: 'reachEngage.sequence.variables.companyName',
  title: 'reachEngage.sequence.variables.title',
  senderFirstName: 'reachEngage.sequence.variables.senderFirstName',
  senderLastName: 'reachEngage.sequence.variables.senderLastName',
  senderFullName: 'reachEngage.sequence.variables.senderFullName',
};

export function VariableMenu({
  customFields,
  disabled,
  onInsert,
}: Readonly<{
  customFields: string[];
  disabled?: boolean;
  /** Receives the `{{name}}` token to put at the cursor. */
  onInsert: (token: string) => void;
}>) {
  const t = useTranslations();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8" disabled={disabled}>
          <Braces className="mr-1.5 h-4 w-4" />
          {t('reachEngage.sequence.insertVariable')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('reachEngage.sequence.standardVariables')}</DropdownMenuLabel>
          {REACH_TEMPLATE_VARIABLES.map((name) => (
            <DropdownMenuItem key={name} onSelect={() => onInsert(variableToken(name))}>
              <span className="flex min-w-0 flex-col">
                <span className="font-mono text-xs">{variableToken(name)}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {t(VARIABLE_DESCRIPTION[name])}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>

        {customFields.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t('reachEngage.sequence.customVariables')}</DropdownMenuLabel>
              {customFields.map((name) => (
                <DropdownMenuItem key={name} onSelect={() => onInsert(variableToken(name))}>
                  <span className="truncate font-mono text-xs">{variableToken(name)}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
