
import { useState, useEffect, useMemo } from 'react';
import { Search, Check, Globe } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { useTranslations } from '@weldsuite/i18n/client';

// Flag component that renders country flags as SVGs
function Flag({ countryCode, className = "w-5 h-4" }: { countryCode: string; className?: string }) {
  const flags: Record<string, JSX.Element> = {
    gb: (
      <svg className={className} viewBox="0 0 60 30">
        <rect width="60" height="30" fill="#012169"/>
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6"/>
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" strokeWidth="4"/>
        <path d="M30,0 V30 M0,15 H60" stroke="#fff" strokeWidth="10"/>
        <path d="M30,0 V30 M0,15 H60" stroke="#C8102E" strokeWidth="6"/>
      </svg>
    ),
    nl: (
      <svg className={className} viewBox="0 0 9 6">
        <rect width="9" height="2" fill="#AE1C28"/>
        <rect y="2" width="9" height="2" fill="#FFF"/>
        <rect y="4" width="9" height="2" fill="#21468B"/>
      </svg>
    ),
    de: (
      <svg className={className} viewBox="0 0 5 3">
        <rect width="5" height="1" fill="#000"/>
        <rect y="1" width="5" height="1" fill="#DD0000"/>
        <rect y="2" width="5" height="1" fill="#FFCE00"/>
      </svg>
    ),
    fr: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="1" height="2" fill="#002395"/>
        <rect x="1" width="1" height="2" fill="#FFF"/>
        <rect x="2" width="1" height="2" fill="#ED2939"/>
      </svg>
    ),
    es: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="2" fill="#AA151B"/>
        <rect y="0.5" width="3" height="1" fill="#F1BF00"/>
      </svg>
    ),
    it: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="1" height="2" fill="#009246"/>
        <rect x="1" width="1" height="2" fill="#FFF"/>
        <rect x="2" width="1" height="2" fill="#CE2B37"/>
      </svg>
    ),
    pt: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="1.2" height="2" fill="#006600"/>
        <rect x="1.2" width="1.8" height="2" fill="#FF0000"/>
      </svg>
    ),
    ru: (
      <svg className={className} viewBox="0 0 9 6">
        <rect width="9" height="2" fill="#FFF"/>
        <rect y="2" width="9" height="2" fill="#0039A6"/>
        <rect y="4" width="9" height="2" fill="#D52B1E"/>
      </svg>
    ),
    cn: (
      <svg className={className} viewBox="0 0 30 20">
        <rect width="30" height="20" fill="#DE2910"/>
        <polygon points="5,4 6,7 9,7 6.5,9 7.5,12 5,10 2.5,12 3.5,9 1,7 4,7" fill="#FFDE00"/>
      </svg>
    ),
    jp: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="2" fill="#FFF"/>
        <circle cx="1.5" cy="1" r="0.6" fill="#BC002D"/>
      </svg>
    ),
    kr: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="2" fill="#FFF"/>
        <circle cx="1.5" cy="1" r="0.5" fill="#C60C30"/>
      </svg>
    ),
    sa: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="2" fill="#006C35"/>
      </svg>
    ),
    in: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#FF9933"/>
        <rect y="0.67" width="3" height="0.67" fill="#FFF"/>
        <rect y="1.34" width="3" height="0.66" fill="#138808"/>
        <circle cx="1.5" cy="1" r="0.2" fill="#000080"/>
      </svg>
    ),
    bd: (
      <svg className={className} viewBox="0 0 5 3">
        <rect width="5" height="3" fill="#006A4E"/>
        <circle cx="2.2" cy="1.5" r="1" fill="#F42A41"/>
      </svg>
    ),
    tr: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="2" fill="#E30A17"/>
        <circle cx="1.1" cy="1" r="0.5" fill="#FFF"/>
        <circle cx="1.25" cy="1" r="0.4" fill="#E30A17"/>
      </svg>
    ),
    vn: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="2" fill="#DA251D"/>
        <polygon points="1.5,0.4 1.7,1 2.3,1 1.8,1.3 2,1.9 1.5,1.5 1,1.9 1.2,1.3 0.7,1 1.3,1" fill="#FFFF00"/>
      </svg>
    ),
    th: (
      <svg className={className} viewBox="0 0 9 6">
        <rect width="9" height="1" fill="#A51931"/>
        <rect y="1" width="9" height="1" fill="#F4F5F8"/>
        <rect y="2" width="9" height="2" fill="#2D2A4A"/>
        <rect y="4" width="9" height="1" fill="#F4F5F8"/>
        <rect y="5" width="9" height="1" fill="#A51931"/>
      </svg>
    ),
    pl: (
      <svg className={className} viewBox="0 0 8 5">
        <rect width="8" height="2.5" fill="#FFF"/>
        <rect y="2.5" width="8" height="2.5" fill="#DC143C"/>
      </svg>
    ),
    ua: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="1" fill="#005BBB"/>
        <rect y="1" width="3" height="1" fill="#FFD500"/>
      </svg>
    ),
    ro: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="1" height="2" fill="#002B7F"/>
        <rect x="1" width="1" height="2" fill="#FCD116"/>
        <rect x="2" width="1" height="2" fill="#CE1126"/>
      </svg>
    ),
    gr: (
      <svg className={className} viewBox="0 0 27 18">
        <rect width="27" height="18" fill="#0D5EAF"/>
        <path d="M0,2 H27 M0,6 H27 M0,10 H27 M0,14 H27" stroke="#FFF" strokeWidth="2"/>
        <rect width="10" height="10" fill="#0D5EAF"/>
        <path d="M5,0 V10 M0,5 H10" stroke="#FFF" strokeWidth="2"/>
      </svg>
    ),
    cz: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="1" fill="#FFF"/>
        <rect y="1" width="3" height="1" fill="#D7141A"/>
        <polygon points="0,0 1.5,1 0,2" fill="#11457E"/>
      </svg>
    ),
    se: (
      <svg className={className} viewBox="0 0 16 10">
        <rect width="16" height="10" fill="#006AA7"/>
        <path d="M0,5 H16 M5,0 V10" stroke="#FECC00" strokeWidth="2"/>
      </svg>
    ),
    hu: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#CE2939"/>
        <rect y="0.67" width="3" height="0.67" fill="#FFF"/>
        <rect y="1.34" width="3" height="0.66" fill="#477050"/>
      </svg>
    ),
    fi: (
      <svg className={className} viewBox="0 0 18 11">
        <rect width="18" height="11" fill="#FFF"/>
        <path d="M0,5.5 H18 M5.5,0 V11" stroke="#003580" strokeWidth="3"/>
      </svg>
    ),
    dk: (
      <svg className={className} viewBox="0 0 37 28">
        <rect width="37" height="28" fill="#C8102E"/>
        <path d="M0,14 H37 M12,0 V28" stroke="#FFF" strokeWidth="4"/>
      </svg>
    ),
    no: (
      <svg className={className} viewBox="0 0 22 16">
        <rect width="22" height="16" fill="#BA0C2F"/>
        <path d="M0,8 H22 M6,0 V16" stroke="#FFF" strokeWidth="4"/>
        <path d="M0,8 H22 M6,0 V16" stroke="#00205B" strokeWidth="2"/>
      </svg>
    ),
    il: (
      <svg className={className} viewBox="0 0 11 8">
        <rect width="11" height="8" fill="#FFF"/>
        <rect y="1" width="11" height="1" fill="#0038B8"/>
        <rect y="6" width="11" height="1" fill="#0038B8"/>
      </svg>
    ),
    id: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="1" fill="#FF0000"/>
        <rect y="1" width="3" height="1" fill="#FFF"/>
      </svg>
    ),
    my: (
      <svg className={className} viewBox="0 0 2 1">
        <rect width="2" height="1" fill="#CC0000"/>
        <rect y="0.07" width="2" height="0.07" fill="#FFF"/>
        <rect y="0.21" width="2" height="0.07" fill="#FFF"/>
        <rect y="0.35" width="2" height="0.07" fill="#FFF"/>
        <rect y="0.5" width="2" height="0.07" fill="#FFF"/>
        <rect y="0.64" width="2" height="0.07" fill="#FFF"/>
        <rect y="0.78" width="2" height="0.07" fill="#FFF"/>
        <rect y="0.92" width="2" height="0.07" fill="#FFF"/>
        <rect width="0.8" height="0.5" fill="#010066"/>
      </svg>
    ),
    ph: (
      <svg className={className} viewBox="0 0 2 1">
        <rect width="2" height="0.5" fill="#0038A8"/>
        <rect y="0.5" width="2" height="0.5" fill="#CE1126"/>
        <polygon points="0,0 0.8,0.5 0,1" fill="#FFF"/>
      </svg>
    ),
    // Additional flags for new languages
    tw: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="2" fill="#FE0000"/>
        <rect width="1.5" height="1" fill="#000095"/>
      </svg>
    ),
    br: (
      <svg className={className} viewBox="0 0 20 14">
        <rect width="20" height="14" fill="#009739"/>
        <polygon points="10,1 19,7 10,13 1,7" fill="#FEDD00"/>
        <circle cx="10" cy="7" r="3" fill="#002776"/>
      </svg>
    ),
    sk: (
      <svg className={className} viewBox="0 0 9 6">
        <rect width="9" height="2" fill="#FFF"/>
        <rect y="2" width="9" height="2" fill="#0B4EA2"/>
        <rect y="4" width="9" height="2" fill="#EE1C25"/>
      </svg>
    ),
    bg: (
      <svg className={className} viewBox="0 0 5 3">
        <rect width="5" height="1" fill="#FFF"/>
        <rect y="1" width="5" height="1" fill="#00966E"/>
        <rect y="2" width="5" height="1" fill="#D62612"/>
      </svg>
    ),
    hr: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#FF0000"/>
        <rect y="0.67" width="3" height="0.67" fill="#FFF"/>
        <rect y="1.34" width="3" height="0.66" fill="#171796"/>
      </svg>
    ),
    rs: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#C6363C"/>
        <rect y="0.67" width="3" height="0.67" fill="#0C4076"/>
        <rect y="1.34" width="3" height="0.66" fill="#FFF"/>
      </svg>
    ),
    si: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#FFF"/>
        <rect y="0.67" width="3" height="0.67" fill="#0000FF"/>
        <rect y="1.34" width="3" height="0.66" fill="#FF0000"/>
      </svg>
    ),
    lt: (
      <svg className={className} viewBox="0 0 5 3">
        <rect width="5" height="1" fill="#FDB913"/>
        <rect y="1" width="5" height="1" fill="#006A44"/>
        <rect y="2" width="5" height="1" fill="#C1272D"/>
      </svg>
    ),
    lv: (
      <svg className={className} viewBox="0 0 2 1">
        <rect width="2" height="0.4" fill="#9E3039"/>
        <rect y="0.4" width="2" height="0.2" fill="#FFF"/>
        <rect y="0.6" width="2" height="0.4" fill="#9E3039"/>
      </svg>
    ),
    ee: (
      <svg className={className} viewBox="0 0 33 21">
        <rect width="33" height="7" fill="#0072CE"/>
        <rect y="7" width="33" height="7" fill="#000"/>
        <rect y="14" width="33" height="7" fill="#FFF"/>
      </svg>
    ),
    is: (
      <svg className={className} viewBox="0 0 25 18">
        <rect width="25" height="18" fill="#02529C"/>
        <path d="M0,9 H25 M7,0 V18" stroke="#FFF" strokeWidth="4"/>
        <path d="M0,9 H25 M7,0 V18" stroke="#DC1E35" strokeWidth="2"/>
      </svg>
    ),
    ie: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="1" height="2" fill="#169B62"/>
        <rect x="1" width="1" height="2" fill="#FFF"/>
        <rect x="2" width="1" height="2" fill="#FF883E"/>
      </svg>
    ),
    mt: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="1.5" height="2" fill="#FFF"/>
        <rect x="1.5" width="1.5" height="2" fill="#CF142B"/>
      </svg>
    ),
    al: (
      <svg className={className} viewBox="0 0 7 5">
        <rect width="7" height="5" fill="#E41E20"/>
      </svg>
    ),
    mk: (
      <svg className={className} viewBox="0 0 2 1">
        <rect width="2" height="1" fill="#CE2028"/>
        <circle cx="1" cy="0.5" r="0.25" fill="#F9D616"/>
      </svg>
    ),
    ba: (
      <svg className={className} viewBox="0 0 2 1">
        <rect width="2" height="1" fill="#002395"/>
        <polygon points="0.4,0 1.2,0 2,1 1.2,1" fill="#FECB00"/>
      </svg>
    ),
    by: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="1.33" fill="#C8313E"/>
        <rect y="1.33" width="3" height="0.67" fill="#4AA657"/>
      </svg>
    ),
    np: (
      <svg className={className} viewBox="0 0 5 6">
        <rect width="5" height="6" fill="#FFF"/>
        <polygon points="0,0 4,3 0,3" fill="#DC143C" stroke="#003893" strokeWidth="0.3"/>
        <polygon points="0,3 4,6 0,6" fill="#DC143C" stroke="#003893" strokeWidth="0.3"/>
      </svg>
    ),
    lk: (
      <svg className={className} viewBox="0 0 2 1">
        <rect width="0.25" height="1" fill="#005641"/>
        <rect x="0.25" width="0.25" height="1" fill="#FF7722"/>
        <rect x="0.5" width="1.5" height="1" fill="#8D153A"/>
      </svg>
    ),
    mm: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#FECB00"/>
        <rect y="0.67" width="3" height="0.67" fill="#34B233"/>
        <rect y="1.34" width="3" height="0.66" fill="#EA2839"/>
      </svg>
    ),
    kh: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.5" fill="#032EA1"/>
        <rect y="0.5" width="3" height="1" fill="#E00025"/>
        <rect y="1.5" width="3" height="0.5" fill="#032EA1"/>
      </svg>
    ),
    la: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.5" fill="#CE1126"/>
        <rect y="0.5" width="3" height="1" fill="#002868"/>
        <rect y="1.5" width="3" height="0.5" fill="#CE1126"/>
        <circle cx="1.5" cy="1" r="0.3" fill="#FFF"/>
      </svg>
    ),
    mn: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="1" height="2" fill="#C4272F"/>
        <rect x="1" width="1" height="2" fill="#015197"/>
        <rect x="2" width="1" height="2" fill="#C4272F"/>
      </svg>
    ),
    ge: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="2" fill="#FFF"/>
        <path d="M1.5,0 V2 M0,1 H3" stroke="#FF0000" strokeWidth="0.3"/>
      </svg>
    ),
    am: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#D90012"/>
        <rect y="0.67" width="3" height="0.67" fill="#0033A0"/>
        <rect y="1.34" width="3" height="0.66" fill="#F2A800"/>
      </svg>
    ),
    az: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#00B5E2"/>
        <rect y="0.67" width="3" height="0.67" fill="#EF3340"/>
        <rect y="1.34" width="3" height="0.66" fill="#509E2F"/>
      </svg>
    ),
    kz: (
      <svg className={className} viewBox="0 0 2 1">
        <rect width="2" height="1" fill="#00AFCA"/>
      </svg>
    ),
    uz: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#1EB53A"/>
        <rect y="0.67" width="3" height="0.67" fill="#FFF"/>
        <rect y="1.34" width="3" height="0.66" fill="#0099B5"/>
      </svg>
    ),
    tj: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.5" fill="#CC0000"/>
        <rect y="0.5" width="3" height="1" fill="#FFF"/>
        <rect y="1.5" width="3" height="0.5" fill="#006600"/>
      </svg>
    ),
    kg: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="2" fill="#E8112D"/>
      </svg>
    ),
    tm: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="2" fill="#00843D"/>
        <rect x="0.3" width="0.5" height="2" fill="#D22630"/>
      </svg>
    ),
    ir: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#239F40"/>
        <rect y="0.67" width="3" height="0.67" fill="#FFF"/>
        <rect y="1.34" width="3" height="0.66" fill="#DA0000"/>
      </svg>
    ),
    pk: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="0.75" height="2" fill="#FFF"/>
        <rect x="0.75" width="2.25" height="2" fill="#01411C"/>
      </svg>
    ),
    af: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="1" height="2" fill="#000"/>
        <rect x="1" width="1" height="2" fill="#BF0000"/>
        <rect x="2" width="1" height="2" fill="#009900"/>
      </svg>
    ),
    iq: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#CE1126"/>
        <rect y="0.67" width="3" height="0.67" fill="#FFF"/>
        <rect y="1.34" width="3" height="0.66" fill="#000"/>
      </svg>
    ),
    ke: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.5" fill="#000"/>
        <rect y="0.5" width="3" height="0.1" fill="#FFF"/>
        <rect y="0.6" width="3" height="0.8" fill="#BB0000"/>
        <rect y="1.4" width="3" height="0.1" fill="#FFF"/>
        <rect y="1.5" width="3" height="0.5" fill="#006600"/>
      </svg>
    ),
    et: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#009739"/>
        <rect y="0.67" width="3" height="0.67" fill="#FCDD09"/>
        <rect y="1.34" width="3" height="0.66" fill="#DA121A"/>
      </svg>
    ),
    ng: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="1" height="2" fill="#009639"/>
        <rect x="1" width="1" height="2" fill="#FFF"/>
        <rect x="2" width="1" height="2" fill="#009639"/>
      </svg>
    ),
    za: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#E03C31"/>
        <rect y="0.67" width="3" height="0.67" fill="#FFF"/>
        <rect y="1.34" width="3" height="0.66" fill="#001489"/>
        <polygon points="0,0 1,1 0,2" fill="#FFB81C"/>
        <polygon points="0,0.2 0.8,1 0,1.8" fill="#000"/>
        <polygon points="0,0.4 0.6,1 0,1.6" fill="#007749"/>
      </svg>
    ),
    so: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="2" fill="#4189DD"/>
      </svg>
    ),
    rw: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="1" fill="#00A1DE"/>
        <rect y="1" width="3" height="0.5" fill="#FAD201"/>
        <rect y="1.5" width="3" height="0.5" fill="#20603D"/>
      </svg>
    ),
    us: (
      <svg className={className} viewBox="0 0 19 10">
        <rect width="19" height="10" fill="#BF0A30"/>
        <path d="M0,1 H19 M0,3 H19 M0,5 H19 M0,7 H19 M0,9 H19" stroke="#FFF" strokeWidth="0.77"/>
        <rect width="7.6" height="5.4" fill="#002868"/>
      </svg>
    ),
    au: (
      <svg className={className} viewBox="0 0 2 1">
        <rect width="2" height="1" fill="#00008B"/>
        <rect width="0.5" height="0.25" fill="#FFF"/>
        <path d="M0,0 L0.5,0.25 M0.5,0 L0,0.25" stroke="#C8102E" strokeWidth="0.05"/>
      </svg>
    ),
    ca: (
      <svg className={className} viewBox="0 0 4 2">
        <rect width="1" height="2" fill="#FF0000"/>
        <rect x="1" width="2" height="2" fill="#FFF"/>
        <rect x="3" width="1" height="2" fill="#FF0000"/>
      </svg>
    ),
    mx: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="1" height="2" fill="#006341"/>
        <rect x="1" width="1" height="2" fill="#FFF"/>
        <rect x="2" width="1" height="2" fill="#CE1126"/>
      </svg>
    ),
    ar: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#74ACDF"/>
        <rect y="0.67" width="3" height="0.67" fill="#FFF"/>
        <rect y="1.34" width="3" height="0.66" fill="#74ACDF"/>
      </svg>
    ),
    at: (
      <svg className={className} viewBox="0 0 3 2">
        <rect width="3" height="0.67" fill="#ED2939"/>
        <rect y="0.67" width="3" height="0.67" fill="#FFF"/>
        <rect y="1.34" width="3" height="0.66" fill="#ED2939"/>
      </svg>
    ),
    ch: (
      <svg className={className} viewBox="0 0 1 1">
        <rect width="1" height="1" fill="#FF0000"/>
        <path d="M0.5,0.2 V0.8 M0.2,0.5 H0.8" stroke="#FFF" strokeWidth="0.13"/>
      </svg>
    ),
  };

  const flag = flags[countryCode.toLowerCase()];
  if (!flag) {
    return <div className={`${className} bg-muted rounded`} />;
  }
  return flag;
}

interface Language {
  code: string;
  name: string;
  nativeName: string;
  countryCode: string;
}

const LANGUAGES: Language[] = [
  // Major World Languages
  { code: 'en', name: 'English', nativeName: 'English', countryCode: 'gb' },
  { code: 'zh', name: 'Chinese (Simplified)', nativeName: '简体中文', countryCode: 'cn' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '繁體中文', countryCode: 'tw' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', countryCode: 'es' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', countryCode: 'sa' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', countryCode: 'in' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', countryCode: 'bd' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', countryCode: 'pt' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)', countryCode: 'br' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', countryCode: 'ru' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', countryCode: 'jp' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', countryCode: 'de' },
  { code: 'fr', name: 'French', nativeName: 'Français', countryCode: 'fr' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', countryCode: 'kr' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', countryCode: 'it' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', countryCode: 'tr' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', countryCode: 'vn' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย', countryCode: 'th' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', countryCode: 'pl' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', countryCode: 'nl' },

  // European Languages
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська', countryCode: 'ua' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română', countryCode: 'ro' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά', countryCode: 'gr' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština', countryCode: 'cz' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska', countryCode: 'se' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar', countryCode: 'hu' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi', countryCode: 'fi' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk', countryCode: 'dk' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk', countryCode: 'no' },
  { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina', countryCode: 'sk' },
  { code: 'bg', name: 'Bulgarian', nativeName: 'Български', countryCode: 'bg' },
  { code: 'hr', name: 'Croatian', nativeName: 'Hrvatski', countryCode: 'hr' },
  { code: 'sr', name: 'Serbian', nativeName: 'Српски', countryCode: 'rs' },
  { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina', countryCode: 'si' },
  { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių', countryCode: 'lt' },
  { code: 'lv', name: 'Latvian', nativeName: 'Latviešu', countryCode: 'lv' },
  { code: 'et', name: 'Estonian', nativeName: 'Eesti', countryCode: 'ee' },
  { code: 'is', name: 'Icelandic', nativeName: 'Íslenska', countryCode: 'is' },
  { code: 'ga', name: 'Irish', nativeName: 'Gaeilge', countryCode: 'ie' },
  { code: 'mt', name: 'Maltese', nativeName: 'Malti', countryCode: 'mt' },
  { code: 'sq', name: 'Albanian', nativeName: 'Shqip', countryCode: 'al' },
  { code: 'mk', name: 'Macedonian', nativeName: 'Македонски', countryCode: 'mk' },
  { code: 'bs', name: 'Bosnian', nativeName: 'Bosanski', countryCode: 'ba' },
  { code: 'be', name: 'Belarusian', nativeName: 'Беларуская', countryCode: 'by' },
  { code: 'ca', name: 'Catalan', nativeName: 'Català', countryCode: 'es' },
  { code: 'gl', name: 'Galician', nativeName: 'Galego', countryCode: 'es' },
  { code: 'eu', name: 'Basque', nativeName: 'Euskara', countryCode: 'es' },
  { code: 'cy', name: 'Welsh', nativeName: 'Cymraeg', countryCode: 'gb' },

  // Asian Languages
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', countryCode: 'id' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu', countryCode: 'my' },
  { code: 'tl', name: 'Filipino', nativeName: 'Filipino', countryCode: 'ph' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', countryCode: 'in' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు', countryCode: 'in' },
  { code: 'mr', name: 'Marathi', nativeName: 'मराठी', countryCode: 'in' },
  { code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી', countryCode: 'in' },
  { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ', countryCode: 'in' },
  { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം', countryCode: 'in' },
  { code: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', countryCode: 'in' },
  { code: 'or', name: 'Odia', nativeName: 'ଓଡ଼ିଆ', countryCode: 'in' },
  { code: 'as', name: 'Assamese', nativeName: 'অসমীয়া', countryCode: 'in' },
  { code: 'ne', name: 'Nepali', nativeName: 'नेपाली', countryCode: 'np' },
  { code: 'si', name: 'Sinhala', nativeName: 'සිංහල', countryCode: 'lk' },
  { code: 'my', name: 'Burmese', nativeName: 'မြန်မာဘာသာ', countryCode: 'mm' },
  { code: 'km', name: 'Khmer', nativeName: 'ភាសាខ្មែរ', countryCode: 'kh' },
  { code: 'lo', name: 'Lao', nativeName: 'ລາວ', countryCode: 'la' },
  { code: 'mn', name: 'Mongolian', nativeName: 'Монгол', countryCode: 'mn' },
  { code: 'ka', name: 'Georgian', nativeName: 'ქართული', countryCode: 'ge' },
  { code: 'hy', name: 'Armenian', nativeName: 'Հdelays', countryCode: 'am' },
  { code: 'az', name: 'Azerbaijani', nativeName: 'Azərbaycan', countryCode: 'az' },
  { code: 'kk', name: 'Kazakh', nativeName: 'Қазақша', countryCode: 'kz' },
  { code: 'uz', name: 'Uzbek', nativeName: 'Oʻzbek', countryCode: 'uz' },
  { code: 'tg', name: 'Tajik', nativeName: 'Тоҷикӣ', countryCode: 'tj' },
  { code: 'ky', name: 'Kyrgyz', nativeName: 'Кыргызча', countryCode: 'kg' },
  { code: 'tk', name: 'Turkmen', nativeName: 'Türkmen', countryCode: 'tm' },

  // Middle Eastern Languages
  { code: 'he', name: 'Hebrew', nativeName: 'עברית', countryCode: 'il' },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی', countryCode: 'ir' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو', countryCode: 'pk' },
  { code: 'ps', name: 'Pashto', nativeName: 'پښتو', countryCode: 'af' },
  { code: 'ku', name: 'Kurdish', nativeName: 'Kurdî', countryCode: 'iq' },

  // African Languages
  { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili', countryCode: 'ke' },
  { code: 'am', name: 'Amharic', nativeName: 'አማርኛ', countryCode: 'et' },
  { code: 'ha', name: 'Hausa', nativeName: 'Hausa', countryCode: 'ng' },
  { code: 'yo', name: 'Yoruba', nativeName: 'Yorùbá', countryCode: 'ng' },
  { code: 'ig', name: 'Igbo', nativeName: 'Igbo', countryCode: 'ng' },
  { code: 'zu', name: 'Zulu', nativeName: 'isiZulu', countryCode: 'za' },
  { code: 'xh', name: 'Xhosa', nativeName: 'isiXhosa', countryCode: 'za' },
  { code: 'af', name: 'Afrikaans', nativeName: 'Afrikaans', countryCode: 'za' },
  { code: 'so', name: 'Somali', nativeName: 'Soomaali', countryCode: 'so' },
  { code: 'rw', name: 'Kinyarwanda', nativeName: 'Kinyarwanda', countryCode: 'rw' },

  // Other Languages
  { code: 'en-US', name: 'English (US)', nativeName: 'English (US)', countryCode: 'us' },
  { code: 'en-AU', name: 'English (Australia)', nativeName: 'English (Australia)', countryCode: 'au' },
  { code: 'en-CA', name: 'English (Canada)', nativeName: 'English (Canada)', countryCode: 'ca' },
  { code: 'es-MX', name: 'Spanish (Mexico)', nativeName: 'Español (México)', countryCode: 'mx' },
  { code: 'es-AR', name: 'Spanish (Argentina)', nativeName: 'Español (Argentina)', countryCode: 'ar' },
  { code: 'fr-CA', name: 'French (Canada)', nativeName: 'Français (Canada)', countryCode: 'ca' },
  { code: 'de-AT', name: 'German (Austria)', nativeName: 'Deutsch (Österreich)', countryCode: 'at' },
  { code: 'de-CH', name: 'German (Switzerland)', nativeName: 'Deutsch (Schweiz)', countryCode: 'ch' },
];

interface LanguageSelectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedLanguage?: string;
  onSelect: (language: Language) => void;
}

export function LanguageSelectorDialog({
  open,
  onOpenChange,
  selectedLanguage,
  onSelect,
}: LanguageSelectorDialogProps) {
  const t = useTranslations();
  const [searchQuery, setSearchQuery] = useState('');

  // Filter languages based on search query
  const filteredLanguages = useMemo(() => {
    if (!searchQuery) return LANGUAGES;
    const query = searchQuery.toLowerCase();
    return LANGUAGES.filter(
      (lang) =>
        lang.name.toLowerCase().includes(query) ||
        lang.nativeName.toLowerCase().includes(query) ||
        lang.code.toLowerCase().includes(query)
    );
  }, [searchQuery]);

  const handleSelect = (language: Language) => {
    onSelect(language);
    onOpenChange(false);
  };

  // Reset search when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery('');
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:!max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4" />
            {t('sweep.weldcrm.languageSelectorDialog.selectLanguage')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('sweep.weldcrm.languageSelectorDialog.searchLanguages')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-gray-300 focus-visible:border-gray-300 dark:focus:border-gray-600 dark:focus-visible:border-gray-600"
              autoFocus
            />
          </div>

          {/* Languages List */}
          <ScrollArea className="h-[320px] -mx-1">
            <div className="space-y-0.5 px-1">
              {filteredLanguages.map((language) => {
                const isSelected = selectedLanguage === language.name || selectedLanguage === language.code;
                return (
                  <Button
                    key={language.code}
                    variant="ghost"
                    onClick={() => handleSelect(language)}
                    className="flex w-full items-center gap-3 py-2 text-sm transition-colors hover:opacity-70"
                  >
                    <Flag countryCode={language.countryCode} className="w-5 h-4 flex-shrink-0" />
                    <span className="flex-1 text-left">{language.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {language.nativeName}
                    </span>
                    {isSelected && (
                      <Check className="h-4 w-4 text-primary" />
                    )}
                  </Button>
                );
              })}
              {filteredLanguages.length === 0 && (
                <div className="py-8 text-center text-muted-foreground">
                  {t('sweep.weldcrm.languageSelectorDialog.noLanguagesFound')}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
