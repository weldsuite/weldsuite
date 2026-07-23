'use client';

import { useState, type FormEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';

import type { BookingPageProps } from '@/lib/schemas';

export interface BookingFormState {
  name: string;
  email: string;
  notes: string;
  answers: Record<string, string>;
  guests: string[];
}

interface BookingDetailsFormProps {
  bookingPage: BookingPageProps;
  submitting: boolean;
  accentColor: string;
  initial: BookingFormState;
  onBack: () => void;
  onSubmit: (state: BookingFormState) => void;
}

export function BookingDetailsForm({
  bookingPage,
  submitting,
  accentColor,
  initial,
  onBack,
  onSubmit,
}: BookingDetailsFormProps) {
  const [name, setName] = useState(initial.name);
  const [email, setEmail] = useState(initial.email);
  const [notes, setNotes] = useState(initial.notes);
  const [answers, setAnswers] = useState<Record<string, string>>(initial.answers);
  const [guests, setGuests] = useState<string[]>(initial.guests);
  const [guestInput, setGuestInput] = useState('');

  const trimmedGuest = guestInput.trim();
  const guestValid = trimmedGuest.length > 0 && trimmedGuest.includes('@');

  const addGuest = () => {
    if (!guestValid) return;
    setGuests((prev) => [...prev, trimmedGuest]);
    setGuestInput('');
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit({ name, email, notes, answers, guests });
  };

  return (
    <div className="pl-6 pt-6 pb-6 flex flex-col min-h-0 w-full md:w-[480px]">
      <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
        <div
          className="space-y-5 flex-1 min-h-0 overflow-y-auto scrollbar-thin-visible pr-6 md:pr-[14px]"
          style={{ scrollbarGutter: 'stable' }}
        >
          <div className="grid gap-2">
            <Label htmlFor="name">
              Your name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Doe"
              autoComplete="name"
              className="shadow-none"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="email">
              Email address <span className="text-destructive">*</span>
            </Label>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="john@example.com"
              autoComplete="email"
              className="shadow-none"
            />
          </div>

          {bookingPage.questions.map((q) => {
            const id = `q-${q.id}`;
            const value = answers[q.id] ?? '';
            const setValue = (v: string) =>
              setAnswers((prev) => ({ ...prev, [q.id]: v }));

            return (
              <div key={q.id} className="grid gap-2">
                <Label htmlFor={id}>
                  {q.label} {q.required && <span className="text-destructive">*</span>}
                </Label>
                {q.type === 'select' && q.options ? (
                  <select
                    id={id}
                    required={q.required}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-gray-900 dark:text-[#F2F2F4] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">Select...</option>
                    {q.options.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : q.type === 'textarea' ? (
                  <Textarea
                    id={id}
                    required={q.required}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={q.label}
                    className="min-h-[80px] shadow-none"
                  />
                ) : (
                  <Input
                    id={id}
                    required={q.required}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={q.label}
                    className="shadow-none"
                  />
                )}
              </div>
            );
          })}

          <div className="grid gap-2">
            <Label htmlFor="notes">Additional notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Please share anything that would help us prepare for the meeting."
              className="min-h-[100px] shadow-none"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="guests">Guests</Label>
            <div className="flex gap-2">
              <Input
                id="guests"
                type="email"
                value={guestInput}
                onChange={(e) => setGuestInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addGuest();
                  }
                }}
                placeholder="email@example.com"
                aria-describedby="guests-hint"
                className="shadow-none"
              />
              <Button
                type="button"
                variant={guestValid ? 'default' : 'outline'}
                className={`shrink-0 h-9 ${guestValid ? 'border border-transparent' : ''}`}
                style={{ paddingLeft: 17, paddingRight: 17 }}
                onClick={addGuest}
              >
                Add
              </Button>
            </div>
            <p id="guests-hint" className="sr-only">
              Add additional attendees by email. Press Enter to add.
            </p>
            {guests.map((guest, index) => (
              <div
                key={`${guest}-${index}`}
                className="flex items-center justify-between h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-gray-900 dark:text-[#F2F2F4]"
              >
                <span className="text-foreground dark:text-[#E4E4E7] truncate">{guest}</span>
                <button
                  type="button"
                  aria-label={`Remove ${guest}`}
                  onClick={() => setGuests((prev) => prev.filter((_, i) => i !== index))}
                  className="text-muted-foreground hover:text-red-600 hover:bg-red-50 transition-colors shrink-0 ml-2 p-1 -mr-2 rounded-[5px]"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 md:mt-4 pr-6">
          <div className="mb-5">
            <p className="text-xs text-muted-foreground dark:text-[#9999A1] text-left">
              By continuing, you agree to our{' '}
              <strong className="text-foreground dark:text-[#E4E4E7] font-semibold">Terms</strong>{' '}
              and{' '}
              <strong className="text-foreground dark:text-[#E4E4E7] font-semibold">
                Privacy Policy
              </strong>
              .
            </p>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onBack}>
              Back
            </Button>
            <Button
              type="submit"
              disabled={submitting}
              style={{ backgroundColor: accentColor, borderColor: accentColor }}
              className="text-white hover:opacity-90 dark:!bg-[#F2F2F4] dark:!border-[#F2F2F4] dark:!text-[#0A0A0B]"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Confirm
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
