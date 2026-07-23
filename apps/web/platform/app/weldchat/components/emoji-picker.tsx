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
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { cn } from '@/lib/utils';
import { useTranslations } from '@weldsuite/i18n/client';

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
}

const RECENT_EMOJIS_KEY = 'weldchat-recent-emojis';
const MAX_RECENT = 18;

function getRecentEmojis(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_EMOJIS_KEY) || '[]');
  } catch {
    return [];
  }
}

function addRecentEmoji(emoji: string) {
  const recent = getRecentEmojis().filter((e) => e !== emoji);
  recent.unshift(emoji);
  localStorage.setItem(RECENT_EMOJIS_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
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

// Keyword map for search - maps emoji to searchable terms
const EMOJI_KEYWORDS: Record<string, string> = {
  '😀':'grin happy','😃':'smile happy','😄':'smile happy','😁':'grin beam','😆':'laugh squint',
  '😅':'sweat smile nervous','🤣':'rofl rolling laugh','😂':'joy laugh cry tears','🙂':'slight smile',
  '🙃':'upside down','😉':'wink','😊':'blush happy','😇':'angel innocent halo','🥰':'love hearts face',
  '😍':'heart eyes love','🤩':'star struck excited','😘':'kiss blow','😗':'kiss','😚':'kiss blush',
  '😙':'kiss smile','🥲':'happy tear cry','😋':'yum delicious tasty','😛':'tongue out','😜':'wink tongue',
  '🤪':'zany crazy wild','😝':'squint tongue','🤑':'money face rich','🤗':'hug hugging','🤭':'giggle oops',
  '🤫':'shush quiet secret','🤔':'think hmm wonder','🤐':'zipper mouth quiet','🤨':'raised eyebrow skeptic',
  '😐':'neutral blank','😑':'expressionless','😶':'mute silent no mouth','😏':'smirk sly',
  '😒':'unamused bored','🙄':'eye roll whatever','😬':'grimace awkward cringe','🤥':'liar pinocchio lie',
  '😌':'relieved peaceful','😔':'sad pensive','😪':'sleepy','🤤':'drool drooling','😴':'sleep zzz snore',
  '😷':'mask sick medical','🤒':'sick thermometer fever','🤕':'hurt bandage injured','🤢':'nauseous sick green',
  '🤮':'vomit throw up sick','🥵':'hot sweating heat','🥶':'cold freezing frozen','🥴':'woozy drunk dizzy',
  '😵':'dizzy knocked out','🤯':'mind blown exploding head','🤠':'cowboy hat','🥳':'party celebrate birthday',
  '🥸':'disguise glasses nose','😎':'cool sunglasses','🤓':'nerd glasses geek','🧐':'monocle inspect',
  '😕':'confused','😟':'worried','🙁':'frown sad','😮':'surprised oh wow','😯':'hushed','😲':'astonished shocked',
  '😳':'flushed embarrassed','🥺':'pleading puppy eyes please','😦':'frown open','😧':'anguished',
  '😨':'fearful scared afraid','😰':'anxious sweat','😥':'sad relieved','😢':'cry sad tear',
  '😭':'sob cry loud','😱':'scream horror scared','😖':'confounded','😣':'persevere','😞':'disappointed',
  '😓':'downcast sweat','😩':'weary tired','😫':'tired exhausted','🥱':'yawn bored sleepy',
  '😤':'angry huff steam','😡':'angry mad rage red','😠':'angry','🤬':'swear cursing symbols',
  '😈':'devil evil smile','👿':'devil angry imp','💀':'skull dead death','☠️':'skull crossbones death',
  '💩':'poop poo','🤡':'clown','👹':'ogre demon','👺':'goblin','👻':'ghost boo halloween',
  '👽':'alien ufo space','👾':'space invader game','🤖':'robot bot',
  '👋':'wave hello hi bye','🤚':'raised hand back','🖐️':'hand fingers spread','✋':'stop high five hand',
  '🖖':'vulcan spock','👌':'ok perfect fine','🤌':'pinched italian chef kiss','🤏':'pinch small tiny',
  '✌️':'peace victory two','🤞':'crossed fingers luck hope','🤟':'love you gesture','🤘':'rock metal horns',
  '🤙':'call me shaka hang loose','👈':'point left','👉':'point right','👆':'point up',
  '🖕':'middle finger','👇':'point down','☝️':'point up index','👍':'thumbs up like yes good',
  '👎':'thumbs down dislike no bad','✊':'fist raised','👊':'fist bump punch','🤛':'left fist',
  '🤜':'right fist','👏':'clap applause bravo','🙌':'raised hands hooray praise',
  '👐':'open hands','🤲':'palms up','🤝':'handshake deal agree','🙏':'pray please thanks hope',
  '✍️':'write writing','💪':'strong muscle flex bicep','❤️':'heart love red','🧡':'orange heart',
  '💛':'yellow heart','💚':'green heart','💙':'blue heart','💜':'purple heart','🖤':'black heart',
  '🤍':'white heart','🤎':'brown heart','💔':'broken heart','💕':'two hearts','💞':'revolving hearts',
  '💓':'heartbeat','💗':'growing heart','💖':'sparkling heart','💘':'cupid arrow heart',
  '💝':'gift heart ribbon','💟':'heart decoration','💯':'hundred perfect score 100',
  '💢':'anger symbol','💥':'boom collision crash','💫':'dizzy star','💦':'sweat splash water',
  '💨':'dash wind fast','🔥':'fire hot lit flame','⭐':'star','🌟':'glowing star shine',
  '✨':'sparkles magic','⚡':'lightning zap electric','💎':'diamond gem jewel',
  '✅':'check done yes correct','❌':'cross no wrong','⭕':'circle','❓':'question',
  '❗':'exclamation alert','‼️':'double exclamation','⁉️':'exclamation question',
  '🐶':'dog puppy','🐱':'cat kitten','🐭':'mouse','🐹':'hamster','🐰':'rabbit bunny',
  '🦊':'fox','🐻':'bear','🐼':'panda','🐨':'koala','🐯':'tiger','🦁':'lion',
  '🐮':'cow','🐷':'pig','🐸':'frog','🐵':'monkey','🐔':'chicken','🐧':'penguin',
  '🐦':'bird','🦅':'eagle','🦉':'owl','🐺':'wolf','🐴':'horse','🦄':'unicorn',
  '🐝':'bee honeybee','🦋':'butterfly','🐌':'snail','🐞':'ladybug','🐢':'turtle',
  '🐍':'snake','🦈':'shark','🐙':'octopus','🐠':'fish','🐬':'dolphin','🐳':'whale',
  '🌸':'cherry blossom flower pink','🌹':'rose flower red','🌺':'hibiscus flower',
  '🌻':'sunflower','🌼':'blossom flower','🌷':'tulip flower','🌱':'seedling plant sprout',
  '🌲':'tree evergreen pine','🌳':'tree deciduous','🍀':'clover luck four leaf','🌈':'rainbow',
  '🍎':'apple red fruit','🍐':'pear fruit','🍊':'orange tangerine fruit','🍋':'lemon fruit',
  '🍌':'banana fruit','🍉':'watermelon fruit','🍇':'grapes fruit','🍓':'strawberry fruit',
  '🍑':'peach fruit','🍒':'cherries fruit','🍕':'pizza food','🍔':'burger hamburger food',
  '🍟':'fries french food','🌭':'hot dog food','🍿':'popcorn snack','🧁':'cupcake cake',
  '🍰':'cake slice','🎂':'birthday cake','🍩':'donut doughnut','🍪':'cookie',
  '🍫':'chocolate candy','☕':'coffee tea hot drink','🍵':'tea drink','🥤':'cup drink straw',
  '🍺':'beer drink','🍻':'beers cheers drink','🥂':'champagne toast celebrate','🍷':'wine drink',
  '🥃':'whiskey tumbler drink','🍸':'cocktail martini drink',
  '⚽':'soccer football sport','🏀':'basketball sport','🏈':'football american sport',
  '⚾':'baseball sport','🎾':'tennis sport','🏐':'volleyball sport','🎱':'pool billiards',
  '🎯':'target bullseye dart','🎮':'game gaming controller','🎲':'dice game',
  '🎭':'theater drama masks','🎨':'art palette paint','🎬':'movie film clapper',
  '🎤':'microphone karaoke sing','🎧':'headphones music listen','🎵':'music note',
  '🎶':'music notes','🎸':'guitar music','🎹':'piano keyboard music','🎺':'trumpet music',
  '🏆':'trophy winner champion','🥇':'gold medal first','🥈':'silver medal second',
  '🥉':'bronze medal third','🎉':'party tada celebration confetti','🎊':'confetti ball celebrate',
  '🎈':'balloon party','🎁':'gift present box','🎀':'ribbon bow',
  '🚀':'rocket launch space','✈️':'airplane plane flight travel','🚗':'car automobile',
  '🚕':'taxi cab','🚌':'bus','🏎️':'race car fast','🚲':'bike bicycle',
  '🚁':'helicopter','⛵':'sailboat','🚢':'ship boat','🏠':'house home','🏢':'office building',
  '🏰':'castle','🌍':'earth globe world','🌎':'earth americas','🌏':'earth asia',
  '🌙':'moon crescent night','☀️':'sun sunny','❄️':'snow cold winter',
  '💡':'light bulb idea','📱':'phone mobile cell','💻':'laptop computer',
  '⌨️':'keyboard type','🖥️':'desktop computer screen','📷':'camera photo',
  '📺':'tv television','🔔':'bell notification alert','🔕':'muted no bell',
  '📌':'pin pushpin','📎':'paperclip clip','🔗':'link chain url','📝':'memo note write',
  '📋':'clipboard','📁':'folder','📊':'chart graph bar','📈':'chart up growth trending',
  '📉':'chart down decline','🔒':'lock secure private','🔓':'unlock open',
  '🔑':'key','🔧':'wrench tool fix','🔨':'hammer tool build','⚙️':'gear settings cog',
  '🧪':'test tube science lab','💊':'pill medicine drug','🏁':'checkered flag finish race',
  '🚩':'red flag warning','🏳️':'white flag surrender','🏴':'black flag',
  '🇳🇱':'netherlands dutch flag','🇺🇸':'usa america united states flag',
  '🇬🇧':'uk britain united kingdom flag','🇩🇪':'germany german flag',
  '🇫🇷':'france french flag','🇪🇸':'spain spanish flag','🇮🇹':'italy italian flag',
  '🇧🇪':'belgium belgian flag','🇧🇷':'brazil flag','🇯🇵':'japan flag',
  '🇰🇷':'korea south flag','🇨🇳':'china flag','🇮🇳':'india flag',
  '🇦🇺':'australia flag','🇨🇦':'canada flag',
};

export function EmojiPicker({ onSelect }: EmojiPickerProps) {
  const t = useTranslations();
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
            placeholder={t('sweep.weldchat.emojiPicker.searchPlaceholder')}
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
              <Button
                key={cat.name}
                variant="ghost"
                size="icon"
                onClick={() => scrollToCategory(i)}
                className={cn(
                  'h-8 w-8 flex items-center justify-center rounded-lg hover:bg-accent transition-colors',
                  activeCategory === i ? 'bg-accent text-foreground' : 'text-muted-foreground',
                )}
                title={cat.name}
              >
                <Icon className="h-[18px] w-[18px]" />
              </Button>
            );
          })}
        </div>
      )}

      {/* Emoji grid */}
      <ScrollArea className="flex-1">
        <div className="p-2">
          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">{t('sweep.weldchat.emojiPicker.noEmojiFound')}</p>
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
                  <Button
                    key={`${emoji}-${i}`}
                    variant="ghost"
                    size="icon"
                    onClick={() => handleSelect(emoji)}
                    className="h-9 w-9 flex items-center justify-center text-2xl hover:bg-accent rounded-lg transition-colors"
                  >
                    {emoji}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
