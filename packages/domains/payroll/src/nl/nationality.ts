/**
 * ISO 3166-1 alpha-2 → nationality code of the BRP (GBA tabel 32), the code
 * the loonaangifte asks for in `Nat` (gegevensspecificaties 2026, rubriek
 * Nationaliteit: "Code conform codering van de BRP/GBA").
 *
 * Source: `Coderingenlandennatsector_versie 1-1-2026.xlsx`, sheet
 * "Nationaliteiten 2026" (stand 1 september 2025), in the ODB release
 * LH2026v09 (https://odb.belastingdienst.nl/wp-content/uploads/2026/01/LH2026v09.zip).
 * The BRP table lists nationalities by Dutch adjective only; each entry below
 * matches one adjective to its country. Unlisted countries map to 0000
 * ("onbekend", allowed by the specification) and the builder warns.
 */
export const BRP_NATIONALITY: Record<string, number> = {
  NL: 1, SK: 27, CZ: 28, BA: 29, GE: 30, TM: 31, TJ: 32, UZ: 33, UA: 34, KG: 35, MD: 36, KZ: 37, BY: 38,
  AZ: 39, AM: 40, RU: 41, SI: 42, HR: 43, LV: 44, EE: 45, LT: 46, MH: 47, MM: 48, NA: 49, AL: 50, AD: 51,
  BE: 52, BG: 53, DK: 54, DE: 55, FI: 56, FR: 57, YE: 58, GR: 59, GB: 60, HU: 61, IE: 62, IS: 63, IT: 64,
  LI: 66, LU: 67, MT: 68, MC: 69, NO: 70, AT: 71, PL: 72, PT: 73, RO: 74, SM: 76, ES: 77, VA: 79, SE: 80,
  CH: 81, ER: 84, XK: 87, MK: 88,
  DZ: 100, AO: 101, BI: 104, BW: 105, BF: 106, CF: 108, KM: 109, CG: 110, BJ: 111, EG: 112, GQ: 113,
  ET: 114, DJ: 115, GA: 116, GM: 117, GH: 118, GN: 119, CI: 120, CV: 121, CM: 122, KE: 123, LS: 125,
  LR: 126, LY: 127, MG: 128, MW: 129, ML: 130, MA: 131, MR: 132, MU: 133, MZ: 134, NE: 136, NG: 137,
  UG: 138, GW: 139, ZA: 140, SZ: 141, ZW: 142, RW: 143, ST: 144, SN: 145, SL: 147, SD: 148, SO: 149,
  TZ: 151, TG: 152, TD: 154, TN: 155, ZM: 156, SS: 157,
  BS: 200, BZ: 202, CA: 204, CR: 205, CU: 206, DO: 207, SV: 208, GT: 211, HT: 212, HN: 213, JM: 214,
  MX: 216, NI: 218, PA: 219, TT: 222, US: 223, AR: 250, BB: 251, BO: 252, BR: 253, CL: 254, CO: 255,
  EC: 256, GY: 259, PY: 261, PE: 262, SR: 263, UY: 264, VE: 265, GD: 267, KN: 268,
  AF: 300, BH: 301, BT: 302, BN: 304, KH: 305, LK: 306, CN: 307, CY: 308, PH: 309, TW: 310, IN: 312,
  ID: 313, IQ: 314, IR: 315, IL: 316, JP: 317, JO: 319, KW: 320, LA: 321, LB: 322, MV: 324, MY: 325,
  MN: 326, OM: 327, NP: 328, KP: 329, PK: 331, QA: 333, SA: 334, SG: 335, SY: 336, TH: 337, AE: 338,
  TR: 339, KR: 341, VN: 342, BD: 345,
  AU: 400, PG: 401, NZ: 402, WS: 405, AG: 421, VU: 424, FJ: 425, TO: 430, NR: 431, PW: 432, SB: 442,
  FM: 443, SC: 444, KI: 445, TV: 446, LC: 447, DM: 448, VC: 449, CD: 451, TL: 452, RS: 454, ME: 455,
};

/** The 4-digit BRP code for an ISO country (or an already numeric BRP code), `0000` when unknown. */
export function brpNationalityCode(nationality: string | null | undefined): { code: string; known: boolean } {
  if (!nationality) return { code: '0000', known: false };
  const trimmed = nationality.trim().toUpperCase();
  if (/^\d{1,4}$/.test(trimmed)) return { code: trimmed.padStart(4, '0'), known: true };
  const n = BRP_NATIONALITY[trimmed];
  return n === undefined ? { code: '0000', known: false } : { code: String(n).padStart(4, '0'), known: true };
}
