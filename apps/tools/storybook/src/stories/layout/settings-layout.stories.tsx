import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { SettingRow, SettingsPage, SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { Switch } from '@weldsuite/ui/components/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';

const meta = {
  title: 'Layout/SettingsLayout',
  component: SettingsPage,
  parameters: { layout: 'fullscreen' },
  args: {
    title: 'Attendance settings',
    hasChanges: false,
    saving: false,
    onSave: () => undefined,
    children: null,
  },
} satisfies Meta<typeof SettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [clockIn, setClockIn] = useState(true);
    const [rounding, setRounding] = useState('5');
    const [saved, setSaved] = useState({ clockIn: true, rounding: '5' });
    const hasChanges = clockIn !== saved.clockIn || rounding !== saved.rounding;
    return (
      <div className="h-[560px]">
        <SettingsPage
          title="Attendance settings"
          description="How employees clock in and how their hours are rounded."
          hasChanges={hasChanges}
          saving={false}
          onSave={() => setSaved({ clockIn, rounding })}
          onCancel={() => {
            setClockIn(saved.clockIn);
            setRounding(saved.rounding);
          }}
        >
          <SettingsSection title="Clocking" description="Applies to every work location.">
            <SettingRow label="Allow clock-in from the web" description="Employees can clock in from their browser.">
              <Switch checked={clockIn} onCheckedChange={setClockIn} aria-label="Allow clock-in from the web" />
            </SettingRow>
            <SettingRow label="Round worked time" description="To the nearest number of minutes.">
              <Select value={rounding} onValueChange={setRounding}>
                <SelectTrigger className="w-28" aria-label="Round worked time">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 min</SelectItem>
                  <SelectItem value="5">5 min</SelectItem>
                  <SelectItem value="15">15 min</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
          </SettingsSection>
        </SettingsPage>
      </div>
    );
  },
};

export const Saving: Story = {
  render: () => (
    <div className="h-[320px]">
      <SettingsPage title="Leave settings" hasChanges saving onSave={() => undefined}>
        <SettingsSection title="Allowance">
          <SettingRow label="Carry over unused days">
            <Switch defaultChecked aria-label="Carry over unused days" />
          </SettingRow>
        </SettingsSection>
      </SettingsPage>
    </div>
  ),
};
