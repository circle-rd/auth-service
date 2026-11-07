import type { SelectOption } from '@/types/select';

/** ISO 3166-1 alpha-2 codes, alphabetical. */
export const COUNTRY_CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(
    ' ',
  );

const displayNamesCache = new Map<string, Intl.DisplayNames>();

function displayNames(locale: string): Intl.DisplayNames | null {
  if (typeof Intl.DisplayNames !== 'function') return null;
  const cached = displayNamesCache.get(locale);
  if (cached) return cached;
  try {
    const instance = new Intl.DisplayNames([locale], { type: 'region' });
    displayNamesCache.set(locale, instance);
    return instance;
  } catch {
    return null;
  }
}

/** Localized country name for a region code, falling back to the code. */
export function countryName(code: string, locale: string): string {
  if (!code) return '';
  const names = displayNames(locale);
  return names?.of(code.toUpperCase()) ?? code.toUpperCase();
}

/** Regional-indicator emoji for an ISO 3166-1 alpha-2 code. */
export function countryFlag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '🏳️';
  return String.fromCodePoint(
    ...code
      .toUpperCase()
      .split('')
      .map((char) => 0x1f1e6 + char.charCodeAt(0) - 65),
  );
}

export function countryOptions(locale: string): SelectOption[] {
  return COUNTRY_CODES.map((code) => ({
    value: code,
    label: countryName(code, locale),
    iconText: countryFlag(code),
  })).sort((a, b) => a.label.localeCompare(b.label, locale));
}

/**
 * Representative locale and timezone for a country. Only countries with a
 * clear default are listed; for the rest the user keeps full control instead
 * of receiving a guessed value.
 */
const COUNTRY_DEFAULTS: Record<string, { locale: string; timezone: string }> = {
  AR: { locale: 'es-AR', timezone: 'America/Argentina/Buenos_Aires' },
  AT: { locale: 'de-AT', timezone: 'Europe/Vienna' },
  AU: { locale: 'en-AU', timezone: 'Australia/Sydney' },
  BE: { locale: 'fr-BE', timezone: 'Europe/Brussels' },
  BG: { locale: 'bg-BG', timezone: 'Europe/Sofia' },
  BR: { locale: 'pt-BR', timezone: 'America/Sao_Paulo' },
  CA: { locale: 'en-CA', timezone: 'America/Toronto' },
  CH: { locale: 'fr-CH', timezone: 'Europe/Zurich' },
  CL: { locale: 'es-CL', timezone: 'America/Santiago' },
  CN: { locale: 'zh-CN', timezone: 'Asia/Shanghai' },
  CO: { locale: 'es-CO', timezone: 'America/Bogota' },
  CZ: { locale: 'cs-CZ', timezone: 'Europe/Prague' },
  DE: { locale: 'de-DE', timezone: 'Europe/Berlin' },
  DK: { locale: 'da-DK', timezone: 'Europe/Copenhagen' },
  DZ: { locale: 'fr-DZ', timezone: 'Africa/Algiers' },
  EE: { locale: 'et-EE', timezone: 'Europe/Tallinn' },
  EG: { locale: 'ar-EG', timezone: 'Africa/Cairo' },
  ES: { locale: 'es-ES', timezone: 'Europe/Madrid' },
  FI: { locale: 'fi-FI', timezone: 'Europe/Helsinki' },
  FR: { locale: 'fr-FR', timezone: 'Europe/Paris' },
  GB: { locale: 'en-GB', timezone: 'Europe/London' },
  GR: { locale: 'el-GR', timezone: 'Europe/Athens' },
  HK: { locale: 'zh-HK', timezone: 'Asia/Hong_Kong' },
  HR: { locale: 'hr-HR', timezone: 'Europe/Zagreb' },
  HU: { locale: 'hu-HU', timezone: 'Europe/Budapest' },
  ID: { locale: 'id-ID', timezone: 'Asia/Jakarta' },
  IE: { locale: 'en-IE', timezone: 'Europe/Dublin' },
  IL: { locale: 'he-IL', timezone: 'Asia/Jerusalem' },
  IN: { locale: 'en-IN', timezone: 'Asia/Kolkata' },
  IS: { locale: 'is-IS', timezone: 'Atlantic/Reykjavik' },
  IT: { locale: 'it-IT', timezone: 'Europe/Rome' },
  JP: { locale: 'ja-JP', timezone: 'Asia/Tokyo' },
  KR: { locale: 'ko-KR', timezone: 'Asia/Seoul' },
  LT: { locale: 'lt-LT', timezone: 'Europe/Vilnius' },
  LU: { locale: 'fr-LU', timezone: 'Europe/Luxembourg' },
  LV: { locale: 'lv-LV', timezone: 'Europe/Riga' },
  MA: { locale: 'fr-MA', timezone: 'Africa/Casablanca' },
  MX: { locale: 'es-MX', timezone: 'America/Mexico_City' },
  MY: { locale: 'ms-MY', timezone: 'Asia/Kuala_Lumpur' },
  NL: { locale: 'nl-NL', timezone: 'Europe/Amsterdam' },
  NO: { locale: 'nb-NO', timezone: 'Europe/Oslo' },
  NZ: { locale: 'en-NZ', timezone: 'Pacific/Auckland' },
  PE: { locale: 'es-PE', timezone: 'America/Lima' },
  PH: { locale: 'en-PH', timezone: 'Asia/Manila' },
  PL: { locale: 'pl-PL', timezone: 'Europe/Warsaw' },
  PT: { locale: 'pt-PT', timezone: 'Europe/Lisbon' },
  RO: { locale: 'ro-RO', timezone: 'Europe/Bucharest' },
  RS: { locale: 'sr-RS', timezone: 'Europe/Belgrade' },
  RU: { locale: 'ru-RU', timezone: 'Europe/Moscow' },
  SA: { locale: 'ar-SA', timezone: 'Asia/Riyadh' },
  SE: { locale: 'sv-SE', timezone: 'Europe/Stockholm' },
  SG: { locale: 'en-SG', timezone: 'Asia/Singapore' },
  SI: { locale: 'sl-SI', timezone: 'Europe/Ljubljana' },
  SK: { locale: 'sk-SK', timezone: 'Europe/Bratislava' },
  TH: { locale: 'th-TH', timezone: 'Asia/Bangkok' },
  TN: { locale: 'fr-TN', timezone: 'Africa/Tunis' },
  TR: { locale: 'tr-TR', timezone: 'Europe/Istanbul' },
  TW: { locale: 'zh-TW', timezone: 'Asia/Taipei' },
  UA: { locale: 'uk-UA', timezone: 'Europe/Kyiv' },
  US: { locale: 'en-US', timezone: 'America/New_York' },
  UY: { locale: 'es-UY', timezone: 'America/Montevideo' },
  VN: { locale: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh' },
  ZA: { locale: 'en-ZA', timezone: 'Africa/Johannesburg' },
};

export function countryDefaults(
  code: string | null | undefined,
): { locale: string; timezone: string } | null {
  if (!code) return null;
  return COUNTRY_DEFAULTS[code.toUpperCase()] ?? null;
}
