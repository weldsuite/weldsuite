"use client";

import { Search, Smile } from "lucide-react";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "./badge";
import { Button } from "./button";
import { Input } from "./input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover";
import { ScrollArea } from "./scroll-area";

const emojis = [
  // Smileys & Emotion - face-smiling
  { code: ["1F600"], emoji: "😀", name: "grinning face", category: "Smileys & Emotion", subcategory: "face-smiling" },
  { code: ["1F603"], emoji: "😃", name: "grinning face with big eyes", category: "Smileys & Emotion", subcategory: "face-smiling" },
  { code: ["1F604"], emoji: "😄", name: "grinning face with smiling eyes", category: "Smileys & Emotion", subcategory: "face-smiling" },
  { code: ["1F601"], emoji: "😁", name: "beaming face with smiling eyes", category: "Smileys & Emotion", subcategory: "face-smiling" },
  { code: ["1F606"], emoji: "😆", name: "grinning squinting face", category: "Smileys & Emotion", subcategory: "face-smiling" },
  { code: ["1F605"], emoji: "😅", name: "grinning face with sweat", category: "Smileys & Emotion", subcategory: "face-smiling" },
  { code: ["1F923"], emoji: "🤣", name: "rolling on the floor laughing", category: "Smileys & Emotion", subcategory: "face-smiling" },
  { code: ["1F602"], emoji: "😂", name: "face with tears of joy", category: "Smileys & Emotion", subcategory: "face-smiling" },
  { code: ["1F642"], emoji: "🙂", name: "slightly smiling face", category: "Smileys & Emotion", subcategory: "face-smiling" },
  { code: ["1F643"], emoji: "🙃", name: "upside-down face", category: "Smileys & Emotion", subcategory: "face-smiling" },
  { code: ["1F609"], emoji: "😉", name: "winking face", category: "Smileys & Emotion", subcategory: "face-smiling" },
  { code: ["1F60A"], emoji: "😊", name: "smiling face with smiling eyes", category: "Smileys & Emotion", subcategory: "face-smiling" },
  { code: ["1F607"], emoji: "😇", name: "smiling face with halo", category: "Smileys & Emotion", subcategory: "face-smiling" },
  // Smileys & Emotion - face-affection
  { code: ["1F970"], emoji: "🥰", name: "smiling face with hearts", category: "Smileys & Emotion", subcategory: "face-affection" },
  { code: ["1F60D"], emoji: "😍", name: "smiling face with heart-eyes", category: "Smileys & Emotion", subcategory: "face-affection" },
  { code: ["1F929"], emoji: "🤩", name: "star-struck", category: "Smileys & Emotion", subcategory: "face-affection" },
  { code: ["1F618"], emoji: "😘", name: "face blowing a kiss", category: "Smileys & Emotion", subcategory: "face-affection" },
  { code: ["1F617"], emoji: "😗", name: "kissing face", category: "Smileys & Emotion", subcategory: "face-affection" },
  { code: ["1F61A"], emoji: "😚", name: "kissing face with closed eyes", category: "Smileys & Emotion", subcategory: "face-affection" },
  { code: ["1F619"], emoji: "😙", name: "kissing face with smiling eyes", category: "Smileys & Emotion", subcategory: "face-affection" },
  // Smileys & Emotion - face-tongue
  { code: ["1F60B"], emoji: "😋", name: "face savoring food", category: "Smileys & Emotion", subcategory: "face-tongue" },
  { code: ["1F61B"], emoji: "😛", name: "face with tongue", category: "Smileys & Emotion", subcategory: "face-tongue" },
  { code: ["1F61C"], emoji: "😜", name: "winking face with tongue", category: "Smileys & Emotion", subcategory: "face-tongue" },
  { code: ["1F92A"], emoji: "🤪", name: "zany face", category: "Smileys & Emotion", subcategory: "face-tongue" },
  { code: ["1F61D"], emoji: "😝", name: "squinting face with tongue", category: "Smileys & Emotion", subcategory: "face-tongue" },
  { code: ["1F911"], emoji: "🤑", name: "money-mouth face", category: "Smileys & Emotion", subcategory: "face-tongue" },
  // Smileys & Emotion - face-hand
  { code: ["1F917"], emoji: "🤗", name: "hugging face", category: "Smileys & Emotion", subcategory: "face-hand" },
  { code: ["1F92D"], emoji: "🤭", name: "face with hand over mouth", category: "Smileys & Emotion", subcategory: "face-hand" },
  { code: ["1F92B"], emoji: "🤫", name: "shushing face", category: "Smileys & Emotion", subcategory: "face-hand" },
  { code: ["1F914"], emoji: "🤔", name: "thinking face", category: "Smileys & Emotion", subcategory: "face-hand" },
  // Smileys & Emotion - face-neutral-skeptical
  { code: ["1F910"], emoji: "🤐", name: "zipper-mouth face", category: "Smileys & Emotion", subcategory: "face-neutral-skeptical" },
  { code: ["1F928"], emoji: "🤨", name: "face with raised eyebrow", category: "Smileys & Emotion", subcategory: "face-neutral-skeptical" },
  { code: ["1F610"], emoji: "😐", name: "neutral face", category: "Smileys & Emotion", subcategory: "face-neutral-skeptical" },
  { code: ["1F611"], emoji: "😑", name: "expressionless face", category: "Smileys & Emotion", subcategory: "face-neutral-skeptical" },
  { code: ["1F636"], emoji: "😶", name: "face without mouth", category: "Smileys & Emotion", subcategory: "face-neutral-skeptical" },
  { code: ["1F60F"], emoji: "😏", name: "smirking face", category: "Smileys & Emotion", subcategory: "face-neutral-skeptical" },
  { code: ["1F612"], emoji: "😒", name: "unamused face", category: "Smileys & Emotion", subcategory: "face-neutral-skeptical" },
  { code: ["1F644"], emoji: "🙄", name: "face with rolling eyes", category: "Smileys & Emotion", subcategory: "face-neutral-skeptical" },
  { code: ["1F62C"], emoji: "😬", name: "grimacing face", category: "Smileys & Emotion", subcategory: "face-neutral-skeptical" },
  { code: ["1F925"], emoji: "🤥", name: "lying face", category: "Smileys & Emotion", subcategory: "face-neutral-skeptical" },
  // Smileys & Emotion - face-sleepy
  { code: ["1F60C"], emoji: "😌", name: "relieved face", category: "Smileys & Emotion", subcategory: "face-sleepy" },
  { code: ["1F614"], emoji: "😔", name: "pensive face", category: "Smileys & Emotion", subcategory: "face-sleepy" },
  { code: ["1F62A"], emoji: "😪", name: "sleepy face", category: "Smileys & Emotion", subcategory: "face-sleepy" },
  { code: ["1F924"], emoji: "🤤", name: "drooling face", category: "Smileys & Emotion", subcategory: "face-sleepy" },
  { code: ["1F634"], emoji: "😴", name: "sleeping face", category: "Smileys & Emotion", subcategory: "face-sleepy" },
  // Smileys & Emotion - face-unwell
  { code: ["1F637"], emoji: "😷", name: "face with medical mask", category: "Smileys & Emotion", subcategory: "face-unwell" },
  { code: ["1F912"], emoji: "🤒", name: "face with thermometer", category: "Smileys & Emotion", subcategory: "face-unwell" },
  { code: ["1F915"], emoji: "🤕", name: "face with head-bandage", category: "Smileys & Emotion", subcategory: "face-unwell" },
  { code: ["1F922"], emoji: "🤢", name: "nauseated face", category: "Smileys & Emotion", subcategory: "face-unwell" },
  { code: ["1F92E"], emoji: "🤮", name: "face vomiting", category: "Smileys & Emotion", subcategory: "face-unwell" },
  { code: ["1F927"], emoji: "🤧", name: "sneezing face", category: "Smileys & Emotion", subcategory: "face-unwell" },
  { code: ["1F975"], emoji: "🥵", name: "hot face", category: "Smileys & Emotion", subcategory: "face-unwell" },
  { code: ["1F976"], emoji: "🥶", name: "cold face", category: "Smileys & Emotion", subcategory: "face-unwell" },
  { code: ["1F974"], emoji: "🥴", name: "woozy face", category: "Smileys & Emotion", subcategory: "face-unwell" },
  { code: ["1F635"], emoji: "😵", name: "dizzy face", category: "Smileys & Emotion", subcategory: "face-unwell" },
  // Smileys & Emotion - face-concerned
  { code: ["1F615"], emoji: "😕", name: "confused face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F61F"], emoji: "😟", name: "worried face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F641"], emoji: "🙁", name: "slightly frowning face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F62E"], emoji: "😮", name: "face with open mouth", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F62F"], emoji: "😯", name: "hushed face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F632"], emoji: "😲", name: "astonished face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F633"], emoji: "😳", name: "flushed face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F97A"], emoji: "🥺", name: "pleading face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F626"], emoji: "😦", name: "frowning face with open mouth", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F627"], emoji: "😧", name: "anguished face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F628"], emoji: "😨", name: "fearful face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F630"], emoji: "😰", name: "anxious face with sweat", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F625"], emoji: "😥", name: "sad but relieved face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F622"], emoji: "😢", name: "crying face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F62D"], emoji: "😭", name: "loudly crying face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F631"], emoji: "😱", name: "face screaming in fear", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F616"], emoji: "😖", name: "confounded face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F623"], emoji: "😣", name: "persevering face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F61E"], emoji: "😞", name: "disappointed face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F613"], emoji: "😓", name: "downcast face with sweat", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F629"], emoji: "😩", name: "weary face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F62B"], emoji: "😫", name: "tired face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  { code: ["1F971"], emoji: "🥱", name: "yawning face", category: "Smileys & Emotion", subcategory: "face-concerned" },
  // Smileys & Emotion - face-negative
  { code: ["1F624"], emoji: "😤", name: "face with steam from nose", category: "Smileys & Emotion", subcategory: "face-negative" },
  { code: ["1F621"], emoji: "😡", name: "pouting face", category: "Smileys & Emotion", subcategory: "face-negative" },
  { code: ["1F620"], emoji: "😠", name: "angry face", category: "Smileys & Emotion", subcategory: "face-negative" },
  { code: ["1F92C"], emoji: "🤬", name: "face with symbols on mouth", category: "Smileys & Emotion", subcategory: "face-negative" },
  { code: ["1F608"], emoji: "😈", name: "smiling face with horns", category: "Smileys & Emotion", subcategory: "face-negative" },
  { code: ["1F47F"], emoji: "👿", name: "angry face with horns", category: "Smileys & Emotion", subcategory: "face-negative" },
  { code: ["1F480"], emoji: "💀", name: "skull", category: "Smileys & Emotion", subcategory: "face-negative" },
  // Smileys & Emotion - face-costume
  { code: ["1F4A9"], emoji: "💩", name: "pile of poo", category: "Smileys & Emotion", subcategory: "face-costume" },
  { code: ["1F921"], emoji: "🤡", name: "clown face", category: "Smileys & Emotion", subcategory: "face-costume" },
  { code: ["1F479"], emoji: "👹", name: "ogre", category: "Smileys & Emotion", subcategory: "face-costume" },
  { code: ["1F47A"], emoji: "👺", name: "goblin", category: "Smileys & Emotion", subcategory: "face-costume" },
  { code: ["1F47B"], emoji: "👻", name: "ghost", category: "Smileys & Emotion", subcategory: "face-costume" },
  { code: ["1F47D"], emoji: "👽", name: "alien", category: "Smileys & Emotion", subcategory: "face-costume" },
  { code: ["1F47E"], emoji: "👾", name: "alien monster", category: "Smileys & Emotion", subcategory: "face-costume" },
  { code: ["1F916"], emoji: "🤖", name: "robot", category: "Smileys & Emotion", subcategory: "face-costume" },
  // Smileys & Emotion - cat-face
  { code: ["1F63A"], emoji: "😺", name: "grinning cat", category: "Smileys & Emotion", subcategory: "cat-face" },
  { code: ["1F638"], emoji: "😸", name: "grinning cat with smiling eyes", category: "Smileys & Emotion", subcategory: "cat-face" },
  { code: ["1F639"], emoji: "😹", name: "cat with tears of joy", category: "Smileys & Emotion", subcategory: "cat-face" },
  { code: ["1F63B"], emoji: "😻", name: "smiling cat with heart-eyes", category: "Smileys & Emotion", subcategory: "cat-face" },
  { code: ["1F63C"], emoji: "😼", name: "cat with wry smile", category: "Smileys & Emotion", subcategory: "cat-face" },
  { code: ["1F63D"], emoji: "😽", name: "kissing cat", category: "Smileys & Emotion", subcategory: "cat-face" },
  { code: ["1F640"], emoji: "🙀", name: "weary cat", category: "Smileys & Emotion", subcategory: "cat-face" },
  { code: ["1F63F"], emoji: "😿", name: "crying cat", category: "Smileys & Emotion", subcategory: "cat-face" },
  { code: ["1F63E"], emoji: "😾", name: "pouting cat", category: "Smileys & Emotion", subcategory: "cat-face" },
  // Smileys & Emotion - monkey-face
  { code: ["1F648"], emoji: "🙈", name: "see-no-evil monkey", category: "Smileys & Emotion", subcategory: "monkey-face" },
  { code: ["1F649"], emoji: "🙉", name: "hear-no-evil monkey", category: "Smileys & Emotion", subcategory: "monkey-face" },
  { code: ["1F64A"], emoji: "🙊", name: "speak-no-evil monkey", category: "Smileys & Emotion", subcategory: "monkey-face" },
  // Smileys & Emotion - emotion
  { code: ["1F48B"], emoji: "💋", name: "kiss mark", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F48C"], emoji: "💌", name: "love letter", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F498"], emoji: "💘", name: "heart with arrow", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F49D"], emoji: "💝", name: "heart with ribbon", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F496"], emoji: "💖", name: "sparkling heart", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F497"], emoji: "💗", name: "growing heart", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F493"], emoji: "💓", name: "beating heart", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F49E"], emoji: "💞", name: "revolving hearts", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F495"], emoji: "💕", name: "two hearts", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F49F"], emoji: "💟", name: "heart decoration", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["2764"], emoji: "❤️", name: "red heart", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F9E1"], emoji: "🧡", name: "orange heart", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F49B"], emoji: "💛", name: "yellow heart", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F49A"], emoji: "💚", name: "green heart", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F499"], emoji: "💙", name: "blue heart", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F49C"], emoji: "💜", name: "purple heart", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F90E"], emoji: "🤎", name: "brown heart", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F5A4"], emoji: "🖤", name: "black heart", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F90D"], emoji: "🤍", name: "white heart", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F494"], emoji: "💔", name: "broken heart", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F4AF"], emoji: "💯", name: "hundred points", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F4A2"], emoji: "💢", name: "anger symbol", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F4A5"], emoji: "💥", name: "collision", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F4AB"], emoji: "💫", name: "dizzy", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F4A6"], emoji: "💦", name: "sweat droplets", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F4A8"], emoji: "💨", name: "dashing away", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F573"], emoji: "🕳️", name: "hole", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F4A3"], emoji: "💣", name: "bomb", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F4AC"], emoji: "💬", name: "speech balloon", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F4AD"], emoji: "💭", name: "thought balloon", category: "Smileys & Emotion", subcategory: "emotion" },
  { code: ["1F4A4"], emoji: "💤", name: "zzz", category: "Smileys & Emotion", subcategory: "emotion" },
  // People & Body - hand-fingers-open
  { code: ["1F44B"], emoji: "👋", name: "waving hand", category: "People & Body", subcategory: "hand-fingers-open" },
  { code: ["1F91A"], emoji: "🤚", name: "raised back of hand", category: "People & Body", subcategory: "hand-fingers-open" },
  { code: ["1F590"], emoji: "🖐️", name: "hand with fingers splayed", category: "People & Body", subcategory: "hand-fingers-open" },
  { code: ["270B"], emoji: "✋", name: "raised hand", category: "People & Body", subcategory: "hand-fingers-open" },
  { code: ["1F596"], emoji: "🖖", name: "vulcan salute", category: "People & Body", subcategory: "hand-fingers-open" },
  // People & Body - hand-fingers-partial
  { code: ["1F44C"], emoji: "👌", name: "OK hand", category: "People & Body", subcategory: "hand-fingers-partial" },
  { code: ["1F90F"], emoji: "🤏", name: "pinching hand", category: "People & Body", subcategory: "hand-fingers-partial" },
  { code: ["270C"], emoji: "✌️", name: "victory hand", category: "People & Body", subcategory: "hand-fingers-partial" },
  { code: ["1F91E"], emoji: "🤞", name: "crossed fingers", category: "People & Body", subcategory: "hand-fingers-partial" },
  { code: ["1F91F"], emoji: "🤟", name: "love-you gesture", category: "People & Body", subcategory: "hand-fingers-partial" },
  { code: ["1F918"], emoji: "🤘", name: "sign of the horns", category: "People & Body", subcategory: "hand-fingers-partial" },
  { code: ["1F919"], emoji: "🤙", name: "call me hand", category: "People & Body", subcategory: "hand-fingers-partial" },
  // People & Body - hand-single-finger
  { code: ["1F448"], emoji: "👈", name: "backhand index pointing left", category: "People & Body", subcategory: "hand-single-finger" },
  { code: ["1F449"], emoji: "👉", name: "backhand index pointing right", category: "People & Body", subcategory: "hand-single-finger" },
  { code: ["1F446"], emoji: "👆", name: "backhand index pointing up", category: "People & Body", subcategory: "hand-single-finger" },
  { code: ["1F595"], emoji: "🖕", name: "middle finger", category: "People & Body", subcategory: "hand-single-finger" },
  { code: ["1F447"], emoji: "👇", name: "backhand index pointing down", category: "People & Body", subcategory: "hand-single-finger" },
  { code: ["261D"], emoji: "☝️", name: "index pointing up", category: "People & Body", subcategory: "hand-single-finger" },
  // People & Body - hand-fingers-closed
  { code: ["1F44D"], emoji: "👍", name: "thumbs up", category: "People & Body", subcategory: "hand-fingers-closed" },
  { code: ["1F44E"], emoji: "👎", name: "thumbs down", category: "People & Body", subcategory: "hand-fingers-closed" },
  { code: ["270A"], emoji: "✊", name: "raised fist", category: "People & Body", subcategory: "hand-fingers-closed" },
  { code: ["1F44A"], emoji: "👊", name: "oncoming fist", category: "People & Body", subcategory: "hand-fingers-closed" },
  { code: ["1F91B"], emoji: "🤛", name: "left-facing fist", category: "People & Body", subcategory: "hand-fingers-closed" },
  { code: ["1F91C"], emoji: "🤜", name: "right-facing fist", category: "People & Body", subcategory: "hand-fingers-closed" },
  // People & Body - hands
  { code: ["1F44F"], emoji: "👏", name: "clapping hands", category: "People & Body", subcategory: "hands" },
  { code: ["1F64C"], emoji: "🙌", name: "raising hands", category: "People & Body", subcategory: "hands" },
  { code: ["1F450"], emoji: "👐", name: "open hands", category: "People & Body", subcategory: "hands" },
  { code: ["1F932"], emoji: "🤲", name: "palms up together", category: "People & Body", subcategory: "hands" },
  { code: ["1F91D"], emoji: "🤝", name: "handshake", category: "People & Body", subcategory: "hands" },
  { code: ["1F64F"], emoji: "🙏", name: "folded hands", category: "People & Body", subcategory: "hands" },
  // People & Body - body-parts
  { code: ["1F4AA"], emoji: "💪", name: "flexed biceps", category: "People & Body", subcategory: "body-parts" },
  { code: ["1F9B5"], emoji: "🦵", name: "leg", category: "People & Body", subcategory: "body-parts" },
  { code: ["1F9B6"], emoji: "🦶", name: "foot", category: "People & Body", subcategory: "body-parts" },
  { code: ["1F442"], emoji: "👂", name: "ear", category: "People & Body", subcategory: "body-parts" },
  { code: ["1F9BB"], emoji: "🦻", name: "ear with hearing aid", category: "People & Body", subcategory: "body-parts" },
  { code: ["1F443"], emoji: "👃", name: "nose", category: "People & Body", subcategory: "body-parts" },
  { code: ["1F9E0"], emoji: "🧠", name: "brain", category: "People & Body", subcategory: "body-parts" },
  { code: ["1F440"], emoji: "👀", name: "eyes", category: "People & Body", subcategory: "body-parts" },
  { code: ["1F441"], emoji: "👁️", name: "eye", category: "People & Body", subcategory: "body-parts" },
  { code: ["1F445"], emoji: "👅", name: "tongue", category: "People & Body", subcategory: "body-parts" },
  { code: ["1F444"], emoji: "👄", name: "mouth", category: "People & Body", subcategory: "body-parts" },
  // Animals & Nature
  { code: ["1F436"], emoji: "🐶", name: "dog face", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F431"], emoji: "🐱", name: "cat face", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F42D"], emoji: "🐭", name: "mouse face", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F439"], emoji: "🐹", name: "hamster", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F430"], emoji: "🐰", name: "rabbit face", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F98A"], emoji: "🦊", name: "fox", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F43B"], emoji: "🐻", name: "bear", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F43C"], emoji: "🐼", name: "panda", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F428"], emoji: "🐨", name: "koala", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F42F"], emoji: "🐯", name: "tiger face", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F981"], emoji: "🦁", name: "lion", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F42E"], emoji: "🐮", name: "cow face", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F437"], emoji: "🐷", name: "pig face", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F438"], emoji: "🐸", name: "frog", category: "Animals & Nature", subcategory: "animal-amphibian" },
  { code: ["1F435"], emoji: "🐵", name: "monkey face", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F412"], emoji: "🐒", name: "monkey", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F414"], emoji: "🐔", name: "chicken", category: "Animals & Nature", subcategory: "animal-bird" },
  { code: ["1F427"], emoji: "🐧", name: "penguin", category: "Animals & Nature", subcategory: "animal-bird" },
  { code: ["1F426"], emoji: "🐦", name: "bird", category: "Animals & Nature", subcategory: "animal-bird" },
  { code: ["1F424"], emoji: "🐤", name: "baby chick", category: "Animals & Nature", subcategory: "animal-bird" },
  { code: ["1F986"], emoji: "🦆", name: "duck", category: "Animals & Nature", subcategory: "animal-bird" },
  { code: ["1F985"], emoji: "🦅", name: "eagle", category: "Animals & Nature", subcategory: "animal-bird" },
  { code: ["1F989"], emoji: "🦉", name: "owl", category: "Animals & Nature", subcategory: "animal-bird" },
  { code: ["1F987"], emoji: "🦇", name: "bat", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F43A"], emoji: "🐺", name: "wolf", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F417"], emoji: "🐗", name: "boar", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F434"], emoji: "🐴", name: "horse face", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F984"], emoji: "🦄", name: "unicorn", category: "Animals & Nature", subcategory: "animal-mammal" },
  { code: ["1F41D"], emoji: "🐝", name: "honeybee", category: "Animals & Nature", subcategory: "animal-bug" },
  { code: ["1F41B"], emoji: "🐛", name: "bug", category: "Animals & Nature", subcategory: "animal-bug" },
  { code: ["1F98B"], emoji: "🦋", name: "butterfly", category: "Animals & Nature", subcategory: "animal-bug" },
  { code: ["1F40C"], emoji: "🐌", name: "snail", category: "Animals & Nature", subcategory: "animal-bug" },
  { code: ["1F41A"], emoji: "🐚", name: "spiral shell", category: "Animals & Nature", subcategory: "animal-marine" },
  { code: ["1F422"], emoji: "🐢", name: "turtle", category: "Animals & Nature", subcategory: "animal-reptile" },
  { code: ["1F40D"], emoji: "🐍", name: "snake", category: "Animals & Nature", subcategory: "animal-reptile" },
  { code: ["1F433"], emoji: "🐳", name: "spouting whale", category: "Animals & Nature", subcategory: "animal-marine" },
  { code: ["1F42C"], emoji: "🐬", name: "dolphin", category: "Animals & Nature", subcategory: "animal-marine" },
  { code: ["1F41F"], emoji: "🐟", name: "fish", category: "Animals & Nature", subcategory: "animal-marine" },
  { code: ["1F420"], emoji: "🐠", name: "tropical fish", category: "Animals & Nature", subcategory: "animal-marine" },
  { code: ["1F421"], emoji: "🐡", name: "blowfish", category: "Animals & Nature", subcategory: "animal-marine" },
  { code: ["1F988"], emoji: "🦈", name: "shark", category: "Animals & Nature", subcategory: "animal-marine" },
  { code: ["1F419"], emoji: "🐙", name: "octopus", category: "Animals & Nature", subcategory: "animal-marine" },
  // Plants
  { code: ["1F490"], emoji: "💐", name: "bouquet", category: "Animals & Nature", subcategory: "plant-flower" },
  { code: ["1F338"], emoji: "🌸", name: "cherry blossom", category: "Animals & Nature", subcategory: "plant-flower" },
  { code: ["1F4AE"], emoji: "💮", name: "white flower", category: "Animals & Nature", subcategory: "plant-flower" },
  { code: ["1F339"], emoji: "🌹", name: "rose", category: "Animals & Nature", subcategory: "plant-flower" },
  { code: ["1F33A"], emoji: "🌺", name: "hibiscus", category: "Animals & Nature", subcategory: "plant-flower" },
  { code: ["1F33B"], emoji: "🌻", name: "sunflower", category: "Animals & Nature", subcategory: "plant-flower" },
  { code: ["1F33C"], emoji: "🌼", name: "blossom", category: "Animals & Nature", subcategory: "plant-flower" },
  { code: ["1F337"], emoji: "🌷", name: "tulip", category: "Animals & Nature", subcategory: "plant-flower" },
  { code: ["1F331"], emoji: "🌱", name: "seedling", category: "Animals & Nature", subcategory: "plant-other" },
  { code: ["1F332"], emoji: "🌲", name: "evergreen tree", category: "Animals & Nature", subcategory: "plant-other" },
  { code: ["1F333"], emoji: "🌳", name: "deciduous tree", category: "Animals & Nature", subcategory: "plant-other" },
  { code: ["1F334"], emoji: "🌴", name: "palm tree", category: "Animals & Nature", subcategory: "plant-other" },
  { code: ["1F335"], emoji: "🌵", name: "cactus", category: "Animals & Nature", subcategory: "plant-other" },
  { code: ["1F33E"], emoji: "🌾", name: "sheaf of rice", category: "Animals & Nature", subcategory: "plant-other" },
  { code: ["1F33F"], emoji: "🌿", name: "herb", category: "Animals & Nature", subcategory: "plant-other" },
  { code: ["2618"], emoji: "☘️", name: "shamrock", category: "Animals & Nature", subcategory: "plant-other" },
  { code: ["1F340"], emoji: "🍀", name: "four leaf clover", category: "Animals & Nature", subcategory: "plant-other" },
  { code: ["1F341"], emoji: "🍁", name: "maple leaf", category: "Animals & Nature", subcategory: "plant-other" },
  { code: ["1F342"], emoji: "🍂", name: "fallen leaf", category: "Animals & Nature", subcategory: "plant-other" },
  { code: ["1F343"], emoji: "🍃", name: "leaf fluttering in wind", category: "Animals & Nature", subcategory: "plant-other" },
  // Food & Drink
  { code: ["1F347"], emoji: "🍇", name: "grapes", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F348"], emoji: "🍈", name: "melon", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F349"], emoji: "🍉", name: "watermelon", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F34A"], emoji: "🍊", name: "tangerine", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F34B"], emoji: "🍋", name: "lemon", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F34C"], emoji: "🍌", name: "banana", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F34D"], emoji: "🍍", name: "pineapple", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F96D"], emoji: "🥭", name: "mango", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F34E"], emoji: "🍎", name: "red apple", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F34F"], emoji: "🍏", name: "green apple", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F350"], emoji: "🍐", name: "pear", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F351"], emoji: "🍑", name: "peach", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F352"], emoji: "🍒", name: "cherries", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F353"], emoji: "🍓", name: "strawberry", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F95D"], emoji: "🥝", name: "kiwi fruit", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F345"], emoji: "🍅", name: "tomato", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F965"], emoji: "🥥", name: "coconut", category: "Food & Drink", subcategory: "food-fruit" },
  { code: ["1F951"], emoji: "🥑", name: "avocado", category: "Food & Drink", subcategory: "food-vegetable" },
  { code: ["1F346"], emoji: "🍆", name: "eggplant", category: "Food & Drink", subcategory: "food-vegetable" },
  { code: ["1F954"], emoji: "🥔", name: "potato", category: "Food & Drink", subcategory: "food-vegetable" },
  { code: ["1F955"], emoji: "🥕", name: "carrot", category: "Food & Drink", subcategory: "food-vegetable" },
  { code: ["1F33D"], emoji: "🌽", name: "ear of corn", category: "Food & Drink", subcategory: "food-vegetable" },
  { code: ["1F336"], emoji: "🌶️", name: "hot pepper", category: "Food & Drink", subcategory: "food-vegetable" },
  { code: ["1F952"], emoji: "🥒", name: "cucumber", category: "Food & Drink", subcategory: "food-vegetable" },
  { code: ["1F966"], emoji: "🥦", name: "broccoli", category: "Food & Drink", subcategory: "food-vegetable" },
  { code: ["1F344"], emoji: "🍄", name: "mushroom", category: "Food & Drink", subcategory: "food-vegetable" },
  { code: ["1F95C"], emoji: "🥜", name: "peanuts", category: "Food & Drink", subcategory: "food-vegetable" },
  { code: ["1F330"], emoji: "🌰", name: "chestnut", category: "Food & Drink", subcategory: "food-vegetable" },
  { code: ["1F35E"], emoji: "🍞", name: "bread", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F950"], emoji: "🥐", name: "croissant", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F956"], emoji: "🥖", name: "baguette bread", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F968"], emoji: "🥨", name: "pretzel", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F95E"], emoji: "🥞", name: "pancakes", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F9C0"], emoji: "🧀", name: "cheese wedge", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F356"], emoji: "🍖", name: "meat on bone", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F357"], emoji: "🍗", name: "poultry leg", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F969"], emoji: "🥩", name: "cut of meat", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F953"], emoji: "🥓", name: "bacon", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F354"], emoji: "🍔", name: "hamburger", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F35F"], emoji: "🍟", name: "french fries", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F355"], emoji: "🍕", name: "pizza", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F32D"], emoji: "🌭", name: "hot dog", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F96A"], emoji: "🥪", name: "sandwich", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F32E"], emoji: "🌮", name: "taco", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F32F"], emoji: "🌯", name: "burrito", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F959"], emoji: "🥙", name: "stuffed flatbread", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F95A"], emoji: "🥚", name: "egg", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F373"], emoji: "🍳", name: "cooking", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F958"], emoji: "🥘", name: "shallow pan of food", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F372"], emoji: "🍲", name: "pot of food", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F963"], emoji: "🥣", name: "bowl with spoon", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F957"], emoji: "🥗", name: "green salad", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F37F"], emoji: "🍿", name: "popcorn", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F9C8"], emoji: "🧈", name: "butter", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F9C2"], emoji: "🧂", name: "salt", category: "Food & Drink", subcategory: "food-prepared" },
  { code: ["1F96B"], emoji: "🥫", name: "canned food", category: "Food & Drink", subcategory: "food-prepared" },
  // Asian food
  { code: ["1F371"], emoji: "🍱", name: "bento box", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F358"], emoji: "🍘", name: "rice cracker", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F359"], emoji: "🍙", name: "rice ball", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F35A"], emoji: "🍚", name: "cooked rice", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F35B"], emoji: "🍛", name: "curry rice", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F35C"], emoji: "🍜", name: "steaming bowl", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F35D"], emoji: "🍝", name: "spaghetti", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F360"], emoji: "🍠", name: "roasted sweet potato", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F362"], emoji: "🍢", name: "oden", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F363"], emoji: "🍣", name: "sushi", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F364"], emoji: "🍤", name: "fried shrimp", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F365"], emoji: "🍥", name: "fish cake with swirl", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F96E"], emoji: "🥮", name: "moon cake", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F361"], emoji: "🍡", name: "dango", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F95F"], emoji: "🥟", name: "dumpling", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F960"], emoji: "🥠", name: "fortune cookie", category: "Food & Drink", subcategory: "food-asian" },
  { code: ["1F961"], emoji: "🥡", name: "takeout box", category: "Food & Drink", subcategory: "food-asian" },
  // Desserts
  { code: ["1F366"], emoji: "🍦", name: "soft ice cream", category: "Food & Drink", subcategory: "food-sweet" },
  { code: ["1F367"], emoji: "🍧", name: "shaved ice", category: "Food & Drink", subcategory: "food-sweet" },
  { code: ["1F368"], emoji: "🍨", name: "ice cream", category: "Food & Drink", subcategory: "food-sweet" },
  { code: ["1F369"], emoji: "🍩", name: "doughnut", category: "Food & Drink", subcategory: "food-sweet" },
  { code: ["1F36A"], emoji: "🍪", name: "cookie", category: "Food & Drink", subcategory: "food-sweet" },
  { code: ["1F382"], emoji: "🎂", name: "birthday cake", category: "Food & Drink", subcategory: "food-sweet" },
  { code: ["1F370"], emoji: "🍰", name: "shortcake", category: "Food & Drink", subcategory: "food-sweet" },
  { code: ["1F9C1"], emoji: "🧁", name: "cupcake", category: "Food & Drink", subcategory: "food-sweet" },
  { code: ["1F967"], emoji: "🥧", name: "pie", category: "Food & Drink", subcategory: "food-sweet" },
  { code: ["1F36B"], emoji: "🍫", name: "chocolate bar", category: "Food & Drink", subcategory: "food-sweet" },
  { code: ["1F36C"], emoji: "🍬", name: "candy", category: "Food & Drink", subcategory: "food-sweet" },
  { code: ["1F36D"], emoji: "🍭", name: "lollipop", category: "Food & Drink", subcategory: "food-sweet" },
  { code: ["1F36E"], emoji: "🍮", name: "custard", category: "Food & Drink", subcategory: "food-sweet" },
  { code: ["1F36F"], emoji: "🍯", name: "honey pot", category: "Food & Drink", subcategory: "food-sweet" },
  // Drinks
  { code: ["1F37C"], emoji: "🍼", name: "baby bottle", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F95B"], emoji: "🥛", name: "glass of milk", category: "Food & Drink", subcategory: "drink" },
  { code: ["2615"], emoji: "☕", name: "hot beverage", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F375"], emoji: "🍵", name: "teacup without handle", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F376"], emoji: "🍶", name: "sake", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F37E"], emoji: "🍾", name: "bottle with popping cork", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F377"], emoji: "🍷", name: "wine glass", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F378"], emoji: "🍸", name: "cocktail glass", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F379"], emoji: "🍹", name: "tropical drink", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F37A"], emoji: "🍺", name: "beer mug", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F37B"], emoji: "🍻", name: "clinking beer mugs", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F942"], emoji: "🥂", name: "clinking glasses", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F943"], emoji: "🥃", name: "tumbler glass", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F964"], emoji: "🥤", name: "cup with straw", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F9C3"], emoji: "🧃", name: "beverage box", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F9C9"], emoji: "🧉", name: "mate", category: "Food & Drink", subcategory: "drink" },
  { code: ["1F9CA"], emoji: "🧊", name: "ice", category: "Food & Drink", subcategory: "drink" },
  // Objects
  { code: ["1F4F1"], emoji: "📱", name: "mobile phone", category: "Objects", subcategory: "phone" },
  { code: ["1F4BB"], emoji: "💻", name: "laptop", category: "Objects", subcategory: "computer" },
  { code: ["1F5A5"], emoji: "🖥️", name: "desktop computer", category: "Objects", subcategory: "computer" },
  { code: ["1F4F7"], emoji: "📷", name: "camera", category: "Objects", subcategory: "light-video" },
  { code: ["1F4FA"], emoji: "📺", name: "television", category: "Objects", subcategory: "light-video" },
  { code: ["1F4A1"], emoji: "💡", name: "light bulb", category: "Objects", subcategory: "light-video" },
  { code: ["1F4B0"], emoji: "💰", name: "money bag", category: "Objects", subcategory: "money" },
  { code: ["1F4B5"], emoji: "💵", name: "dollar banknote", category: "Objects", subcategory: "money" },
  { code: ["1F4B8"], emoji: "💸", name: "money with wings", category: "Objects", subcategory: "money" },
  { code: ["1F4B3"], emoji: "💳", name: "credit card", category: "Objects", subcategory: "money" },
  { code: ["1F4E7"], emoji: "📧", name: "e-mail", category: "Objects", subcategory: "mail" },
  { code: ["1F4DD"], emoji: "📝", name: "memo", category: "Objects", subcategory: "writing" },
  { code: ["270F"], emoji: "✏️", name: "pencil", category: "Objects", subcategory: "writing" },
  { code: ["1F512"], emoji: "🔒", name: "locked", category: "Objects", subcategory: "lock" },
  { code: ["1F513"], emoji: "🔓", name: "unlocked", category: "Objects", subcategory: "lock" },
  { code: ["1F511"], emoji: "🔑", name: "key", category: "Objects", subcategory: "lock" },
  { code: ["1F528"], emoji: "🔨", name: "hammer", category: "Objects", subcategory: "tool" },
  { code: ["1F527"], emoji: "🔧", name: "wrench", category: "Objects", subcategory: "tool" },
  { code: ["1F529"], emoji: "🔩", name: "nut and bolt", category: "Objects", subcategory: "tool" },
  { code: ["2699"], emoji: "⚙️", name: "gear", category: "Objects", subcategory: "tool" },
  { code: ["1F389"], emoji: "🎉", name: "party popper", category: "Activities", subcategory: "event" },
  { code: ["1F38A"], emoji: "🎊", name: "confetti ball", category: "Activities", subcategory: "event" },
  { code: ["1F381"], emoji: "🎁", name: "wrapped gift", category: "Activities", subcategory: "event" },
  { code: ["1F3C6"], emoji: "🏆", name: "trophy", category: "Activities", subcategory: "award-medal" },
  { code: ["1F947"], emoji: "🥇", name: "1st place medal", category: "Activities", subcategory: "award-medal" },
  { code: ["1F948"], emoji: "🥈", name: "2nd place medal", category: "Activities", subcategory: "award-medal" },
  { code: ["1F949"], emoji: "🥉", name: "3rd place medal", category: "Activities", subcategory: "award-medal" },
  { code: ["26BD"], emoji: "⚽", name: "soccer ball", category: "Activities", subcategory: "sport" },
  { code: ["1F3C0"], emoji: "🏀", name: "basketball", category: "Activities", subcategory: "sport" },
  { code: ["1F3C8"], emoji: "🏈", name: "american football", category: "Activities", subcategory: "sport" },
  { code: ["26BE"], emoji: "⚾", name: "baseball", category: "Activities", subcategory: "sport" },
  { code: ["1F3BE"], emoji: "🎾", name: "tennis", category: "Activities", subcategory: "sport" },
  { code: ["1F3B5"], emoji: "🎵", name: "musical note", category: "Objects", subcategory: "music" },
  { code: ["1F3B6"], emoji: "🎶", name: "musical notes", category: "Objects", subcategory: "music" },
  { code: ["1F3A4"], emoji: "🎤", name: "microphone", category: "Objects", subcategory: "music" },
  { code: ["1F3A7"], emoji: "🎧", name: "headphone", category: "Objects", subcategory: "music" },
  // Symbols
  { code: ["2705"], emoji: "✅", name: "check mark button", category: "Symbols", subcategory: "other-symbol" },
  { code: ["274C"], emoji: "❌", name: "cross mark", category: "Symbols", subcategory: "other-symbol" },
  { code: ["2714"], emoji: "✔️", name: "check mark", category: "Symbols", subcategory: "other-symbol" },
  { code: ["2716"], emoji: "✖️", name: "multiplication sign", category: "Symbols", subcategory: "other-symbol" },
  { code: ["2795"], emoji: "➕", name: "plus", category: "Symbols", subcategory: "other-symbol" },
  { code: ["2796"], emoji: "➖", name: "minus", category: "Symbols", subcategory: "other-symbol" },
  { code: ["2757"], emoji: "❗", name: "exclamation mark", category: "Symbols", subcategory: "other-symbol" },
  { code: ["2753"], emoji: "❓", name: "question mark", category: "Symbols", subcategory: "other-symbol" },
  { code: ["1F4F4"], emoji: "📴", name: "mobile phone off", category: "Symbols", subcategory: "av-symbol" },
  { code: ["1F4F3"], emoji: "📳", name: "vibration mode", category: "Symbols", subcategory: "av-symbol" },
  { code: ["1F199"], emoji: "🆙", name: "UP! button", category: "Symbols", subcategory: "alphanum" },
  { code: ["1F192"], emoji: "🆒", name: "COOL button", category: "Symbols", subcategory: "alphanum" },
  { code: ["1F195"], emoji: "🆕", name: "NEW button", category: "Symbols", subcategory: "alphanum" },
  { code: ["1F197"], emoji: "🆗", name: "OK button", category: "Symbols", subcategory: "alphanum" },
  { code: ["1F198"], emoji: "🆘", name: "SOS button", category: "Symbols", subcategory: "alphanum" },
  { code: ["26A0"], emoji: "⚠️", name: "warning", category: "Symbols", subcategory: "warning" },
  { code: ["1F6AB"], emoji: "🚫", name: "prohibited", category: "Symbols", subcategory: "warning" },
  { code: ["2B06"], emoji: "⬆️", name: "up arrow", category: "Symbols", subcategory: "arrow" },
  { code: ["2B07"], emoji: "⬇️", name: "down arrow", category: "Symbols", subcategory: "arrow" },
  { code: ["2B05"], emoji: "⬅️", name: "left arrow", category: "Symbols", subcategory: "arrow" },
  { code: ["27A1"], emoji: "➡️", name: "right arrow", category: "Symbols", subcategory: "arrow" },
  { code: ["1F504"], emoji: "🔄", name: "counterclockwise arrows button", category: "Symbols", subcategory: "arrow" },
  { code: ["1F501"], emoji: "🔁", name: "repeat button", category: "Symbols", subcategory: "av-symbol" },
  { code: ["1F502"], emoji: "🔂", name: "repeat single button", category: "Symbols", subcategory: "av-symbol" },
  { code: ["25B6"], emoji: "▶️", name: "play button", category: "Symbols", subcategory: "av-symbol" },
  { code: ["23F8"], emoji: "⏸️", name: "pause button", category: "Symbols", subcategory: "av-symbol" },
  { code: ["23F9"], emoji: "⏹️", name: "stop button", category: "Symbols", subcategory: "av-symbol" },
  { code: ["23FA"], emoji: "⏺️", name: "record button", category: "Symbols", subcategory: "av-symbol" },
  // Weather
  { code: ["2600"], emoji: "☀️", name: "sun", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F324"], emoji: "🌤️", name: "sun behind small cloud", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["26C5"], emoji: "⛅", name: "sun behind cloud", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F325"], emoji: "🌥️", name: "sun behind large cloud", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["2601"], emoji: "☁️", name: "cloud", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F326"], emoji: "🌦️", name: "sun behind rain cloud", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F327"], emoji: "🌧️", name: "cloud with rain", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["26C8"], emoji: "⛈️", name: "cloud with lightning and rain", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F329"], emoji: "🌩️", name: "cloud with lightning", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F328"], emoji: "🌨️", name: "cloud with snow", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["2744"], emoji: "❄️", name: "snowflake", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F32C"], emoji: "🌬️", name: "wind face", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F32A"], emoji: "🌪️", name: "tornado", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F308"], emoji: "🌈", name: "rainbow", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["2614"], emoji: "☔", name: "umbrella with rain drops", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["26A1"], emoji: "⚡", name: "high voltage", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F525"], emoji: "🔥", name: "fire", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F4A7"], emoji: "💧", name: "droplet", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F30A"], emoji: "🌊", name: "water wave", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["2B50"], emoji: "⭐", name: "star", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F31F"], emoji: "🌟", name: "glowing star", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F319"], emoji: "🌙", name: "crescent moon", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F31E"], emoji: "🌞", name: "sun with face", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F31D"], emoji: "🌝", name: "full moon face", category: "Travel & Places", subcategory: "sky-weather" },
  { code: ["1F31A"], emoji: "🌚", name: "new moon face", category: "Travel & Places", subcategory: "sky-weather" },
  // Flags
  { code: ["1F1FA", "1F1F8"], emoji: "🇺🇸", name: "flag: United States", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1EC", "1F1E7"], emoji: "🇬🇧", name: "flag: United Kingdom", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1E8", "1F1E6"], emoji: "🇨🇦", name: "flag: Canada", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1E6", "1F1FA"], emoji: "🇦🇺", name: "flag: Australia", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1E9", "1F1EA"], emoji: "🇩🇪", name: "flag: Germany", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1EB", "1F1F7"], emoji: "🇫🇷", name: "flag: France", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1EA", "1F1F8"], emoji: "🇪🇸", name: "flag: Spain", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1EE", "1F1F9"], emoji: "🇮🇹", name: "flag: Italy", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1EF", "1F1F5"], emoji: "🇯🇵", name: "flag: Japan", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1E8", "1F1F3"], emoji: "🇨🇳", name: "flag: China", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1F0", "1F1F7"], emoji: "🇰🇷", name: "flag: South Korea", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1E7", "1F1F7"], emoji: "🇧🇷", name: "flag: Brazil", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1F3", "1F1F1"], emoji: "🇳🇱", name: "flag: Netherlands", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1F7", "1F1FA"], emoji: "🇷🇺", name: "flag: Russia", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1EE", "1F1F3"], emoji: "🇮🇳", name: "flag: India", category: "Flags", subcategory: "country-flag" },
  { code: ["1F1F2", "1F1FD"], emoji: "🇲🇽", name: "flag: Mexico", category: "Flags", subcategory: "country-flag" },
  { code: ["1F3F3"], emoji: "🏳️", name: "white flag", category: "Flags", subcategory: "flag" },
  { code: ["1F3F4"], emoji: "🏴", name: "black flag", category: "Flags", subcategory: "flag" },
  { code: ["1F3C1"], emoji: "🏁", name: "chequered flag", category: "Flags", subcategory: "flag" },
];

interface EmojiPickerProps {
  onEmojiSelect: (emoji: string) => void;
  trigger?: React.ReactNode;
  maxRecentEmojis?: number;
}

interface EmojiGridProps {
  emojis: typeof emojis;
  showCategory?: boolean;
  selectedIndex: number;
  allVisibleEmojis: typeof emojis;
  onEmojiClick: (emoji: string) => void;
  setSelectedIndex: (index: number) => void;
  emojiGridRef: React.RefObject<HTMLDivElement | null>;
}

const EmojiGrid = ({
  emojis: emojiList,
  showCategory = false,
  selectedIndex,
  allVisibleEmojis,
  onEmojiClick,
  setSelectedIndex,
  emojiGridRef,
}: EmojiGridProps) => (
  <div className="grid grid-cols-8 gap-1 p-2" ref={emojiGridRef}>
    {emojiList.map((emoji, index) => {
      const globalIndex = showCategory
        ? allVisibleEmojis.findIndex((e) => e.emoji === emoji.emoji)
        : index;

      return (
        <Button
          key={`${emoji.emoji}-${index}`}
          variant="ghost"
          size="sm"
          className={`hover:bg-accent h-8 w-8 p-0 transition-colors ${
            selectedIndex >= 0 && selectedIndex === globalIndex ? "bg-accent ring-primary ring-1" : ""
          }`}
          onClick={() => onEmojiClick(emoji.emoji)}
          title={emoji.name}
          onMouseEnter={() => setSelectedIndex(globalIndex)}
          onMouseLeave={() => setSelectedIndex(-1)}
        >
          <span className="text-lg" role="img" aria-label={emoji.name}>
            {emoji.emoji}
          </span>
        </Button>
      );
    })}
  </div>
);

export default function EmojiPicker({
  onEmojiSelect,
  trigger,
  maxRecentEmojis = 24,
}: EmojiPickerProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [recentEmojis, setRecentEmojis] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const emojiGridRef = useRef<HTMLDivElement>(null);

  // Load recent emojis from localStorage
  useEffect(() => {
    const stored = localStorage.getItem("recent-emojis");
    if (stored) {
      try {
        startTransition(() => {
          setRecentEmojis(JSON.parse(stored));
        });
      } catch {
        // Ignore invalid JSON in localStorage
      }
    }
  }, []);

  // Get unique categories with better ordering
  const categories = useMemo(() => {
    const categoryOrder = [
      "Smileys & Emotion",
      "People & Body",
      "Animals & Nature",
      "Food & Drink",
      "Travel & Places",
      "Activities",
      "Objects",
      "Symbols",
      "Flags",
    ];

    const availableCategories = Array.from(
      new Set(emojis.map((emoji) => emoji.category)),
    );
    return categoryOrder.filter((cat) => availableCategories.includes(cat));
  }, []);

  // Enhanced search with keywords and fuzzy matching
  const filteredEmojis = useMemo(() => {
    if (!searchTerm) return emojis;

    const searchLower = searchTerm.toLowerCase();
    return emojis.filter((emoji) => {
      const nameMatch = emoji.name.toLowerCase().includes(searchLower);
      const categoryMatch = emoji.category.toLowerCase().includes(searchLower);

      // Add keyword matching if emoji has keywords property
      const emojiKeywords =
        "keywords" in emoji && Array.isArray(emoji.keywords)
          ? emoji.keywords
          : [];
      const keywordMatch = emojiKeywords.some((keyword: string) =>
        keyword.toLowerCase().includes(searchLower),
      );

      return nameMatch || categoryMatch || keywordMatch;
    });
  }, [searchTerm]);

  // Group emojis by category
  const emojisByCategory = useMemo(() => {
    return categories.reduce(
      (acc, category) => {
        acc[category] = filteredEmojis.filter(
          (emoji) => emoji.category === category,
        );
        return acc;
      },
      {} as Record<string, typeof emojis>,
    );
  }, [categories, filteredEmojis]);

  // Get all visible emojis for keyboard navigation
  const allVisibleEmojis = useMemo(() => {
    if (searchTerm) {
      return filteredEmojis;
    }
    return categories.flatMap((category) => emojisByCategory[category] || []);
  }, [searchTerm, filteredEmojis, categories, emojisByCategory]);

  const handleEmojiClick = (emoji: string) => {
    onEmojiSelect(emoji);

    // Update recent emojis
    const newRecent = [emoji, ...recentEmojis.filter((e) => e !== emoji)].slice(
      0,
      maxRecentEmojis,
    );

    setRecentEmojis(newRecent);
    localStorage.setItem("recent-emojis", JSON.stringify(newRecent));

    setIsOpen(false);
    setSearchTerm("");
    setSelectedIndex(-1);
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < allVisibleEmojis.length - 1 ? prev + 1 : prev,
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : -1));
        break;
      case "Enter":
        e.preventDefault();
        if (selectedIndex >= 0 && allVisibleEmojis[selectedIndex]) {
          handleEmojiClick(allVisibleEmojis[selectedIndex].emoji);
        }
        break;
      case "Escape":
        setIsOpen(false);
        setSearchTerm("");
        setSelectedIndex(-1);
        break;
    }
  };

  // Focus search input when popover opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  // Reset selection when search changes
  useEffect(() => {
    startTransition(() => {
      setSelectedIndex(-1);
    });
  }, [searchTerm]);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        {trigger || (
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 bg-transparent p-0"
          >
            <Smile className="h-4 w-4" />
            <span className="sr-only">Open emoji picker</span>
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0 z-[9999999]"
        align="start"
        side="top"
        onKeyDown={handleKeyDown}
      >
        {/* Search Header */}
        <div className="space-y-2 px-3 pt-3 pb-1">
          <div className="relative">
            <Search className="text-muted-foreground absolute left-2 top-2.5 h-4 w-4" />
            <Input
              ref={searchInputRef}
              placeholder="Search emojis..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8 shadow-none focus-visible:ring-0"
              aria-label="Search emojis"
            />
          </div>

          {/* Search Results Count */}
          {searchTerm && (
            <div className="text-muted-foreground flex items-center justify-between text-xs">
              <span>{filteredEmojis.length} results found</span>
              {filteredEmojis.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  Use ↑↓ to navigate, Enter to select
                </Badge>
              )}
            </div>
          )}
        </div>

        {/* Search Results */}
        {searchTerm ? (
          <ScrollArea className="h-64">
            {filteredEmojis.length > 0 ? (
              <EmojiGrid
                emojis={filteredEmojis}
                showCategory
                selectedIndex={selectedIndex}
                allVisibleEmojis={allVisibleEmojis}
                onEmojiClick={handleEmojiClick}
                setSelectedIndex={setSelectedIndex}
                emojiGridRef={emojiGridRef}
              />
            ) : (
              <div className="text-muted-foreground flex h-32 flex-col items-center justify-center">
                <Search className="mb-2 h-8 w-8" />
                <p className="text-sm">No emojis found</p>
                <p className="text-xs">Try a different search term</p>
              </div>
            )}
          </ScrollArea>
        ) : (
          /* All Emojis - no category tabs */
          <ScrollArea className="h-64">
            <EmojiGrid
              emojis={allVisibleEmojis}
              selectedIndex={selectedIndex}
              allVisibleEmojis={allVisibleEmojis}
              onEmojiClick={handleEmojiClick}
              setSelectedIndex={setSelectedIndex}
              emojiGridRef={emojiGridRef}
            />
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
