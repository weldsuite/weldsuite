/**
 * Emoji Picker — self-contained, dependency-free.
 *
 * Lives in @weldsuite/weldmeet-ui so the SHARED meeting chat composer works in
 * both the platform and the meeting-portal without each app wiring its own
 * picker. Mirrors the platform's WeldChat picker (apps/web/platform/app/weldchat/
 * components/emoji-picker.tsx) — keep the two roughly in sync.
 */

'use client';

import { useState, useMemo, useRef } from 'react';
import {
  Search,
  Clock,
  Smile,
  Hand,
  Heart,
  Dog,
  UtensilsCrossed,
  Trophy,
  Plane,
  Lightbulb,
  Flag,
} from 'lucide-react';
import { Input } from '@weldsuite/ui/components/input';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { cn } from '@weldsuite/ui/lib/utils';

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
}

const RECENT_EMOJIS_KEY = 'weldmeet-recent-emojis';
const MAX_RECENT = 18;

function getRecentEmojis(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(RECENT_EMOJIS_KEY) || '[]');
  } catch {
    return [];
  }
}

function addRecentEmoji(emoji: string) {
  if (typeof localStorage === 'undefined') return;
  const recent = getRecentEmojis().filter((e) => e !== emoji);
  recent.unshift(emoji);
  try {
    localStorage.setItem(RECENT_EMOJIS_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch {
    /* storage full / blocked — non-fatal */
  }
}

const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'Recently Used': Clock,
  'Smileys': Smile,
  'Gestures': Hand,
  'Hearts': Heart,
  'Animals': Dog,
  'Food': UtensilsCrossed,
  'Activities': Trophy,
  'Travel': Plane,
  'Objects': Lightbulb,
  'Flags': Flag,
};

const CATEGORIES: { name: string; emojis: string[] }[] = [
  {
    name: 'Smileys',
    emojis: [
      '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩',
      '😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐',
      '🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒',
      '🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','😟',
      '🙁','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣',
      '😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹',
      '👺','👻','👽','👾','🤖','😺','😸','😹','😻','😼','😽','🙀','😿','😾',
    ],
  },
  {
    name: 'Gestures',
    emojis: [
      '👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆',
      '🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️',
      '💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅',
      '👄','💋','🫂','👤','👥','🫅','🧑','👶','👧','🧒','👦','👩','👨','🧓','👴','👵',
    ],
  },
  {
    name: 'Hearts',
    emojis: [
      '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','💕','💞','💓','💗',
      '💖','💘','💝','💟','❣️','💯','💢','💥','💫','💦','💨','🔥','⭐','🌟','✨','⚡',
      '💎','✅','❌','⭕','❓','❗','‼️','⁉️','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪',
      '🟤','🔶','🔷','🔸','🔹','🔺','🔻','💠','🔘','🔳','🔲',
    ],
  },
  {
    name: 'Animals',
    emojis: [
      '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐽','🐸',
      '🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺',
      '🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️',
      '🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋',
      '🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃',
      '🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐈‍⬛','🪶',
      '🐓','🦃','🦤','🦚','🦜','🦢','🦩','🕊️','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁',
      '🐀','🐿️','🦔','🌸','🌹','🌺','🌻','🌼','🌷','🌱','🌲','🌳','🌴','🌵','🍀','🌈',
    ],
  },
  {
    name: 'Food',
    emojis: [
      '🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝',
      '🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🥐',
      '🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔',
      '🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🥫','🍝','🍜','🍲',
      '🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧','🍨',
      '🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🥛',
      '🍼','🫖','☕','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧉','🍾',
    ],
  },
  {
    name: 'Activities',
    emojis: [
      '⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🪀','🏓','🏸','🏒','🥅','⛳',
      '🪃','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🪂',
      '🏋️','🤸','🤺','⛹️','🤾','🏌️','🏇','🧘','🏄','🏊','🤽','🚣','🧗','🚵','🚴','🏆',
      '🥇','🥈','🥉','🏅','🎖️','🏵️','🎗️','🎫','🎟️','🎪','🎭','🎨','🎬','🎤','🎧','🎵',
      '🎶','🎹','🥁','🪘','🎷','🎺','🪗','🎸','🪕','🎻','🎲','♟️','🎯','🎳','🎮','🕹️',
      '🧩','🎉','🎊','🎈','🎁','🎀','🪄','🪅','🪩','🪆','🎐','🎏','🎎','🎑','🧧',
    ],
  },
  {
    name: 'Travel',
    emojis: [
      '🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🛵','🏍️',
      '🛺','🚲','🛴','🚨','🚔','🚍','🚘','🚖','🛞','🚡','🚠','🚟','🚃','🚋','🚞','🚝',
      '🚄','🚅','🚈','🚂','🚆','🚇','🚊','🚉','✈️','🛫','🛬','🛩️','💺','🛰️','🚀','🛸',
      '🚁','🛶','⛵','🚤','🛥️','🛳️','⛴️','🚢','⚓','🪝','⛽','🚧','🚦','🚥','🗺️','🗿',
      '🗽','🗼','🏰','🏯','🏟️','🎡','🎢','🎠','⛲','⛱️','🏖️','🏝️','🏜️','🌋','⛰️','🏔️',
      '🗻','🏕️','🛖','🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭',
      '🌍','🌎','🌏','🌙','☀️','⛅','🌧️','⛈️','❄️','🌈',
    ],
  },
  {
    name: 'Objects',
    emojis: [
      '💡','🔦','🕯️','📱','💻','⌨️','🖥️','🖨️','📷','📹','🎥','📺','📻','🎙️','🎚️','🎛️',
      '🧭','⏱️','⏲️','⏰','🕰️','⌛','📡','🔋','🔌','🪫','🔔','🔕','📌','📎','🔗','📝',
      '📋','📁','📂','🗂️','📊','📈','📉','📃','📄','📅','📆','🗒️','🗓️','📇','🗃️','🗳️',
      '🗄️','📦','📫','📪','📬','📭','📮','🏷️','🔖','✂️','🖇️','📐','📏','🧮','🔒','🔓',
      '🔑','🗝️','🔧','🔨','⛏️','🪚','🔩','⚙️','🧲','🪜','🧪','🧫','🧬','🔬','🔭','📡',
      '💊','💉','🩸','🩹','🩺','🩻','🚪','🛗','🪞','🪟','🛏️','🛋️','🪑','🚽','🪠','🚿',
      '🛁','🪤','🧴','🧷','🧹','🧺','🧻','🪣','🧽','🧯','🛒','🚬','⚰️','🪦','⚱️','🏺',
    ],
  },
  {
    name: 'Flags',
    emojis: [
      '🏁','🚩','🏳️','🏴','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️','🇳🇱','🇧🇪','🇩🇪','🇫🇷','🇬🇧','🇺🇸','🇪🇸','🇮🇹','🇵🇹',
      '🇧🇷','🇦🇷','🇲🇽','🇨🇦','🇦🇺','🇯🇵','🇰🇷','🇨🇳','🇮🇳','🇷🇺','🇹🇷','🇸🇦','🇦🇪','🇿🇦','🇳🇬','🇪🇬',
      '🇮🇱','🇵🇱','🇸🇪','🇳🇴','🇩🇰','🇫🇮','🇨🇭','🇦🇹','🇮🇪','🇬🇷','🇭🇷','🇷🇴','🇭🇺','🇨🇿','🇸🇰','🇧🇬',
      '🇺🇦','🇱🇹','🇱🇻','🇪🇪','🇮🇸','🇱🇺','🇲🇨','🇲🇹','🇨🇾','🇬🇪','🇦🇲','🇦🇿','🇰🇿','🇺🇿','🇹🇭','🇻🇳',
      '🇮🇩','🇲🇾','🇸🇬','🇵🇭','🇹🇼','🇭🇰','🇲🇴','🇳🇿','🇨🇱','🇨🇴','🇵🇪','🇻🇪','🇪🇨','🇵🇾','🇺🇾','🇧🇴',
    ],
  },
];

// Keyword map for search — maps emoji to searchable terms (subset; emoji not
// listed are still reachable by browsing categories).
const EMOJI_KEYWORDS: Record<string, string> = {
  '😀':'grin happy','😃':'smile happy','😄':'smile happy','😁':'grin beam','😆':'laugh squint',
  '😅':'sweat smile nervous','🤣':'rofl rolling laugh','😂':'joy laugh cry tears','🙂':'slight smile',
  '🙃':'upside down','😉':'wink','😊':'blush happy','😇':'angel innocent halo','🥰':'love hearts face',
  '😍':'heart eyes love','🤩':'star struck excited','😘':'kiss blow','😋':'yum delicious tasty',
  '🤔':'think hmm wonder','😎':'cool sunglasses','🥳':'party celebrate birthday','😭':'sob cry loud',
  '😡':'angry mad rage red','💀':'skull dead death','💩':'poop poo','🤡':'clown','👻':'ghost boo halloween',
  '🤖':'robot bot','👋':'wave hello hi bye','👌':'ok perfect fine','✌️':'peace victory two',
  '🤞':'crossed fingers luck hope','🤙':'call me shaka','👍':'thumbs up like yes good',
  '👎':'thumbs down dislike no bad','👏':'clap applause bravo','🙌':'raised hands hooray praise',
  '🙏':'pray please thanks hope','💪':'strong muscle flex bicep','❤️':'heart love red','🧡':'orange heart',
  '💛':'yellow heart','💚':'green heart','💙':'blue heart','💜':'purple heart','🖤':'black heart',
  '💔':'broken heart','💯':'hundred perfect score 100','🔥':'fire hot lit flame','⭐':'star',
  '✨':'sparkles magic','⚡':'lightning zap electric','✅':'check done yes correct','❌':'cross no wrong',
  '❓':'question','❗':'exclamation alert','🐶':'dog puppy','🐱':'cat kitten','🦊':'fox','🐻':'bear',
  '🐼':'panda','🦄':'unicorn','🐝':'bee honeybee','🦋':'butterfly','🌸':'cherry blossom flower pink',
  '🌹':'rose flower red','🌈':'rainbow','🍎':'apple red fruit','🍌':'banana fruit','🍕':'pizza food',
  '🍔':'burger hamburger food','🍟':'fries french food','🍿':'popcorn snack','🎂':'birthday cake',
  '🍩':'donut doughnut','🍪':'cookie','☕':'coffee tea hot drink','🍺':'beer drink','🍻':'beers cheers drink',
  '🥂':'champagne toast celebrate','🍷':'wine drink','⚽':'soccer football sport','🏀':'basketball sport',
  '🎾':'tennis sport','🎯':'target bullseye dart','🎮':'game gaming controller','🎲':'dice game',
  '🎨':'art palette paint','🎬':'movie film clapper','🎤':'microphone karaoke sing','🎧':'headphones music',
  '🎵':'music note','🎸':'guitar music','🏆':'trophy winner champion','🥇':'gold medal first',
  '🎉':'party tada celebration confetti','🎊':'confetti ball celebrate','🎈':'balloon party',
  '🎁':'gift present box','🚀':'rocket launch space','✈️':'airplane plane flight travel','🚗':'car automobile',
  '🚲':'bike bicycle','🚢':'ship boat','🏠':'house home','🌍':'earth globe world','🌙':'moon crescent night',
  '☀️':'sun sunny','❄️':'snow cold winter','💡':'light bulb idea','📱':'phone mobile cell','💻':'laptop computer',
  '📷':'camera photo','🔔':'bell notification alert','📌':'pin pushpin','📎':'paperclip clip',
  '🔗':'link chain url','📝':'memo note write','📊':'chart graph bar','📈':'chart up growth trending',
  '🔒':'lock secure private','🔑':'key','🔧':'wrench tool fix','🔨':'hammer tool build','⚙️':'gear settings cog',
  '🏁':'checkered flag finish race','🚩':'red flag warning','🇳🇱':'netherlands dutch flag',
  '🇺🇸':'usa america united states flag','🇬🇧':'uk britain united kingdom flag','🇩🇪':'germany german flag',
  '🇫🇷':'france french flag','🇧🇪':'belgium belgian flag',
};

export function EmojiPicker({ onSelect }: EmojiPickerProps) {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState(0);
  const [recentEmojis, setRecentEmojis] = useState<string[]>(getRecentEmojis);
  const categoryRefs = useRef<(HTMLDivElement | null)[]>([]);

  const handleSelect = (emoji: string) => {
    addRecentEmoji(emoji);
    setRecentEmojis(getRecentEmojis());
    onSelect(emoji);
  };

  const allCategories = useMemo(() => {
    const cats = [...CATEGORIES];
    if (recentEmojis.length > 0) {
      cats.unshift({ name: 'Recently Used', emojis: recentEmojis });
    }
    return cats;
  }, [recentEmojis]);

  const filtered = useMemo(() => {
    if (!search) return allCategories;
    const q = search.toLowerCase();
    return allCategories
      .map((cat) => ({
        ...cat,
        emojis: cat.emojis.filter((e) => {
          const keywords = EMOJI_KEYWORDS[e] || '';
          return keywords.includes(q) || e.includes(q);
        }),
      }))
      .filter((cat) => cat.emojis.length > 0);
  }, [search, allCategories]);

  const scrollToCategory = (index: number) => {
    setActiveCategory(index);
    categoryRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="flex flex-col h-[370px]">
      {/* Search */}
      <div className="p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search emoji..."
            className="h-[34px] pl-7 text-sm"
            autoFocus
          />
        </div>
      </div>

      {/* Category nav */}
      {!search && (
        <div className="flex items-center justify-between px-2 pb-1.5 border-b">
          {allCategories.map((cat, i) => {
            const Icon = CATEGORY_ICONS[cat.name] || Smile;
            return (
              <button
                key={cat.name}
                onClick={() => scrollToCategory(i)}
                className={cn(
                  'h-8 w-8 flex items-center justify-center rounded-lg hover:bg-accent transition-colors',
                  activeCategory === i ? 'bg-accent text-foreground' : 'text-muted-foreground',
                )}
                title={cat.name}
              >
                <Icon className="h-[18px] w-[18px]" />
              </button>
            );
          })}
        </div>
      )}

      {/* Emoji grid */}
      <ScrollArea className="flex-1">
        <div className="p-2">
          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No emoji found</p>
          )}
          {filtered.map((cat, catIndex) => (
            <div
              key={cat.name}
              ref={(el) => { categoryRefs.current[catIndex] = el; }}
              className={catIndex > 0 ? 'mt-5' : ''}
            >
              <p className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide px-1 pb-1.5">
                {cat.name}
              </p>
              <div className="grid grid-cols-8 gap-1 justify-items-center">
                {cat.emojis.map((emoji, i) => (
                  <button
                    key={`${emoji}-${i}`}
                    type="button"
                    onClick={() => handleSelect(emoji)}
                    className="h-9 w-9 flex items-center justify-center text-2xl hover:bg-accent rounded-lg transition-colors"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
