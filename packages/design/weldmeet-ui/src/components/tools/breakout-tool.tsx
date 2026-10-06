import { useState } from 'react';
import { DoorOpen, Minus, Plus, Shuffle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';
import { formatLabel, type MeetingToolsLabels } from '../../tools/labels';
import {
  breakoutRoomOf,
  participantKey,
  type BreakoutRoom,
  type BreakoutState,
  type MeetingToolsStore,
} from '../../tools/tools-store';
import type { MeetingPeer } from '../../types';

const MIN_ROOMS = 2;
const MAX_ROOMS = 10;
const MAIN_ROOM = '';

export interface BreakoutToolProps {
  store: MeetingToolsStore;
  breakout: BreakoutState;
  /** Everyone in the meeting, local participant first (not filtered by room). */
  participants: MeetingPeer[];
  /** Only the host creates, opens and closes rooms and moves people around. */
  canManage: boolean;
  labels: MeetingToolsLabels;
}

interface Person {
  key: string;
  name: string;
  isSelf: boolean;
}

function makeRooms(count: number, previous: BreakoutRoom[], roomNameLabel: string): BreakoutRoom[] {
  return Array.from({ length: count }, (_, index) => {
    const existing = previous[index];
    return (
      existing ?? {
        id: `room-${index + 1}`,
        name: formatLabel(roomNameLabel, { number: index + 1 }),
        members: [],
      }
    );
  });
}

/** Deals everyone but the host over the rooms in a random order. */
function assignAutomatically(rooms: BreakoutRoom[], people: Person[]): BreakoutRoom[] {
  const keys = people.filter((person) => !person.isSelf).map((person) => person.key);
  const order = new Uint32Array(keys.length);
  globalThis.crypto.getRandomValues(order);
  const shuffled = keys
    .map((key, index) => ({ key, weight: order[index]! }))
    .sort((a, b) => a.weight - b.weight)
    .map((entry) => entry.key);
  const next = rooms.map((room) => ({ ...room, members: [] as string[] }));
  shuffled.forEach((key, index) => next[index % next.length]!.members.push(key));
  return next;
}

function moveMember(rooms: BreakoutRoom[], key: string, roomId: string): BreakoutRoom[] {
  return rooms.map((room) => {
    const others = room.members.filter((member) => member !== key);
    return { ...room, members: room.id === roomId ? [...others, key] : others };
  });
}

const SELECT_CLASS =
  'h-7 max-w-[130px] rounded-md border bg-background px-1.5 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30 dark:border-input';

export function BreakoutTool({ store, breakout, participants, canManage, labels }: BreakoutToolProps) {
  const t = labels.breakout;
  const [draft, setDraft] = useState<BreakoutRoom[]>(() =>
    makeRooms(Math.max(MIN_ROOMS, breakout.rooms.length), breakout.rooms, t.roomName),
  );

  const people: Person[] = participants
    .map((p, index) => ({ key: participantKey(p), name: p.name || 'Guest', isSelf: index === 0 }))
    .filter((person, index, all) => person.key && all.findIndex((other) => other.key === person.key) === index);
  const selfKey = people[0]?.key ?? '';

  // While the rooms are open the shared state is the truth and every change
  // goes out at once; before that the host arranges a local draft.
  const rooms = breakout.active ? breakout.rooms : draft;
  const update = (next: BreakoutRoom[]) => {
    if (breakout.active) store.setBreakout({ active: true, rooms: next });
    else setDraft(next);
  };
  const roomIdOf = (key: string) => rooms.find((room) => room.members.includes(key))?.id ?? MAIN_ROOM;
  const unassigned = people.filter((person) => roomIdOf(person.key) === MAIN_ROOM);

  if (!canManage) {
    const ownRoom = breakoutRoomOf(breakout, selfKey);
    if (!breakout.active) {
      return <p className="p-4 text-sm text-muted-foreground">{t.participantHint}</p>;
    }
    return (
      <div className="p-4 space-y-4">
        <RoomCard
          title={ownRoom?.name ?? t.mainRoom}
          badge={t.youAreHere}
          people={people.filter((person) => roomIdOf(person.key) === (ownRoom?.id ?? MAIN_ROOM))}
          emptyLabel={t.empty}
        />
        {ownRoom && (
          <Button type="button" variant="outline" className="w-full" onClick={() => store.moveSelfToRoom(null)}>
            <DoorOpen className="h-4 w-4" />
            {t.leave}
          </Button>
        )}
      </div>
    );
  }

  const renderMove = (person: Person) => (
    <select
      className={SELECT_CLASS}
      aria-label={formatLabel(t.moveTo, { name: person.name })}
      value={roomIdOf(person.key)}
      onChange={(e) => update(moveMember(rooms, person.key, e.target.value))}
    >
      <option value={MAIN_ROOM}>{t.mainRoom}</option>
      {rooms.map((room) => (
        <option key={room.id} value={room.id}>
          {room.name}
        </option>
      ))}
    </select>
  );

  return (
    <div className="p-4 space-y-4">
      <p className="text-sm text-muted-foreground">{t.intro}</p>

      {!breakout.active && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 px-3 py-2.5">
          <span className="text-sm font-medium">{t.roomCount}</span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={t.removeRoom}
              disabled={draft.length <= MIN_ROOMS}
              onClick={() => setDraft(makeRooms(draft.length - 1, draft, t.roomName))}
            >
              <Minus className="h-3.5 w-3.5" />
            </Button>
            <span className="w-5 text-center text-sm font-medium tabular-nums">{draft.length}</span>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={t.addRoom}
              disabled={draft.length >= MAX_ROOMS}
              onClick={() => setDraft(makeRooms(draft.length + 1, draft, t.roomName))}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      <Button type="button" variant="outline" size="sm" onClick={() => update(assignAutomatically(rooms, people))}>
        <Shuffle className="h-3.5 w-3.5" />
        {t.assignAutomatically}
      </Button>

      <div className="space-y-2">
        {rooms.map((room) => {
          const here = breakout.active && roomIdOf(selfKey) === room.id;
          return (
            <RoomCard
              key={room.id}
              title={room.name}
              badge={here ? t.youAreHere : undefined}
              action={
                breakout.active && !here ? (
                  <Button type="button" variant="outline" size="xs" onClick={() => store.moveSelfToRoom(room.id)}>
                    {t.join}
                  </Button>
                ) : undefined
              }
              people={people.filter((person) => roomIdOf(person.key) === room.id)}
              emptyLabel={t.empty}
              renderMove={renderMove}
            />
          );
        })}
        <RoomCard
          title={t.mainRoom}
          badge={breakout.active && roomIdOf(selfKey) === MAIN_ROOM ? t.youAreHere : undefined}
          action={
            breakout.active && roomIdOf(selfKey) !== MAIN_ROOM ? (
              <Button type="button" variant="outline" size="xs" onClick={() => store.moveSelfToRoom(null)}>
                {t.join}
              </Button>
            ) : undefined
          }
          people={unassigned}
          emptyLabel={t.empty}
          renderMove={renderMove}
        />
      </div>

      {breakout.active ? (
        <Button
          type="button"
          variant="destructive"
          className="w-full"
          onClick={() => {
            setDraft(breakout.rooms);
            store.setBreakout({ active: false, rooms: breakout.rooms });
          }}
        >
          {t.close}
        </Button>
      ) : (
        <Button type="button" className="w-full" onClick={() => store.setBreakout({ active: true, rooms: draft })}>
          <DoorOpen className="h-4 w-4" />
          {t.open}
        </Button>
      )}
    </div>
  );
}

function RoomCard({
  title,
  badge,
  action,
  people,
  emptyLabel,
  renderMove,
}: {
  title: string;
  badge?: string;
  action?: React.ReactNode;
  people: Person[];
  emptyLabel: string;
  renderMove?: (person: Person) => React.ReactNode;
}) {
  return (
    <section className="rounded-xl bg-muted/40 px-3 py-2.5">
      <header className="flex items-center justify-between gap-2">
        <h4 className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="truncate">{title}</span>
          <span className="text-xs font-normal tabular-nums text-muted-foreground">{people.length}</span>
        </h4>
        {badge ? (
          <span className="flex-shrink-0 rounded-[5px] border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            {badge}
          </span>
        ) : (
          action
        )}
      </header>
      {people.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {people.map((person) => (
            <li key={person.key} className="flex items-center justify-between gap-2">
              <span className={cn('min-w-0 truncate text-sm', person.isSelf && 'font-medium')}>{person.name}</span>
              {renderMove?.(person)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
