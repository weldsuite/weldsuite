
import { useState, useEffect, useRef } from 'react';
import { LocationAutocomplete } from '@/app/weldcalendar/components/location-autocomplete';
import type { LocationEditorProps } from '../types';

type LocationParts = { city: string; state: string; country: string };

function normalizeToString(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const v = value as { city?: string; state?: string; country?: string };
    return [v.city, v.state, v.country].filter(Boolean).join(', ');
  }
  return '';
}

function parseStringToParts(input: string): LocationParts {
  const parts = input.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return { city: parts[0], state: parts[1], country: parts[parts.length - 1] };
  if (parts.length === 2) return { city: parts[0], state: '', country: parts[1] };
  if (parts.length === 1) return { city: parts[0], state: '', country: '' };
  return { city: '', state: '', country: '' };
}

function suggestionToParts(s: {
  name: string;
  place_formatted?: string;
  feature_type?: string;
}): LocationParts {
  const place = (s.place_formatted || '').split(',').map((p) => p.trim()).filter(Boolean);
  switch (s.feature_type) {
    case 'country':
      return { city: '', state: '', country: s.name };
    case 'region':
      return { city: '', state: s.name, country: place[place.length - 1] || '' };
    case 'place':
      if (place.length >= 2) return { city: s.name, state: place[0], country: place[place.length - 1] };
      if (place.length === 1) return { city: s.name, state: '', country: place[0] };
      return { city: s.name, state: '', country: '' };
    case 'address':
    case 'poi':
      if (place.length >= 3) return { city: place[0], state: place[1], country: place[place.length - 1] };
      if (place.length === 2) return { city: place[0], state: '', country: place[1] };
      if (place.length === 1) return { city: place[0], state: '', country: '' };
      return { city: s.name, state: '', country: '' };
    default:
      return parseStringToParts(`${s.name}${s.place_formatted ? ', ' + s.place_formatted : ''}`);
  }
}

function suggestionToDisplay(s: { name: string; place_formatted?: string; feature_type?: string }): string {
  if (s.feature_type === 'country') return s.name;
  return s.place_formatted ? `${s.name}, ${s.place_formatted}` : s.name;
}

export function LocationEditor({ value, onChange, onCommit }: LocationEditorProps) {
  // The normalized initial string, used only for change detection and "did we
  // start with data?" checks. We deliberately depend on the *content* of the
  // string, NOT on `value`'s object reference (the parent re-creates the
  // object on every render).
  const initialString = normalizeToString(value);

  const [localValue, setLocalValue] = useState<string>(initialString);

  // Refs so the always-fresh values are visible inside callbacks that may run
  // after unmount (the autocomplete fires `onBlurAfterGrace` on a 200ms timer).
  const initialRef = useRef(initialString);
  const localRef = useRef(localValue);
  const hasCommittedRef = useRef(false);
  const isMountedRef = useRef(true);

  // Sync refs (cheap, no rerender).
  localRef.current = localValue;

  // If the underlying string actually changes (NOT just a new object reference
  // from an unrelated parent re-render), accept the new value and reset state.
  useEffect(() => {
    setLocalValue(initialString);
    initialRef.current = initialString;
    hasCommittedRef.current = false;
  }, [initialString]);

  // Track mount status for safe post-unmount callbacks.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Commit `parts` exactly once. Subsequent callers no-op.
  const commitParts = (parts: LocationParts) => {
    if (hasCommittedRef.current) return;
    hasCommittedRef.current = true;
    onChange?.(parts);
  };

  // Try to commit a free-typed string by parsing it into city/state/country.
  // Hard guards:
  //   - never commit if the string is unchanged from initial (no actual edit)
  //   - never commit empty parts on top of saved data (race-safety)
  const tryCommitString = (next: string) => {
    if (hasCommittedRef.current) return;
    if (next === initialRef.current) return;
    const parts = parseStringToParts(next);
    const allEmpty = !parts.city && !parts.state && !parts.country;
    if (allEmpty && initialRef.current !== '') return;
    commitParts(parts);
  };

  // On unmount, commit any pending free-typed text once. Do NOT call
  // `onCommit()` here — the cell already exited edit mode if we're unmounting.
  useEffect(() => {
    return () => {
      tryCommitString(localRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <LocationAutocomplete
      value={localValue}
      onChange={setLocalValue}
      onSuggestionSelect={(s) => {
        const display = suggestionToDisplay(s);
        // Lock both refs to the new display so any straggling cleanup
        // commit can't overwrite the structured save we're about to do.
        initialRef.current = display;
        localRef.current = display;
        setLocalValue(display);
        commitParts(suggestionToParts(s));
        if (isMountedRef.current) onCommit();
      }}
      placeholder=""
      className="h-7 text-sm shadow-none border-0 px-0 focus-visible:ring-0 bg-transparent"
      autoFocus
      popoverAlignOffset={-12}
      popoverSideOffset={9}
      onBlurAfterGrace={() => {
        // Fired 200ms after the input blurs. By the time this runs the editor
        // may already be unmounted (user clicked another cell). In that case
        // the unmount-cleanup has already attempted a commit, and we MUST NOT
        // call `onCommit()` — that would clear the *new* cell's edit state,
        // which is the "it unselects when I click another cell" bug.
        if (!isMountedRef.current) return;
        tryCommitString(localRef.current);
        onCommit();
      }}
    />
  );
}
