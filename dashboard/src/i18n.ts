import React from 'react';
import { es } from './locales/es.ts';
import { en } from './locales/en.ts';

export type Language = 'es' | 'en';
export type TranslationKey = keyof typeof es;
export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** Clave de `localStorage` donde se persiste la elección del usuario. */
export const languageStorageKey = 'agentscope.language';

const dictionaries: Record<Language, Record<TranslationKey, string>> = { es, en };
const locales: Record<Language, string> = { es: 'es-UY', en: 'en-US' };

/** Código de error estable de la API -> clave del diccionario que lo traduce. */
export const apiErrorText = {
  telemetry_key_missing: 'errors.telemetry_key_missing',
  rating_invalid: 'errors.rating_invalid',
  budget_invalid: 'errors.budget_invalid',
  protocol_unsupported: 'errors.protocol_unsupported',
  ingest_invalid: 'errors.ingest_invalid',
  session_not_found: 'errors.session_not_found',
  before_invalid: 'errors.before_invalid',
  suite_missing: 'errors.suite_missing',
  models_missing: 'errors.models_missing',
  judge_missing: 'errors.judge_missing',
  variant_invalid: 'errors.variant_invalid',
  judge_is_model: 'errors.judge_is_model',
  model_not_in_catalog: 'errors.model_not_in_catalog',
  judge_not_in_catalog: 'errors.judge_not_in_catalog',
  model_catalog_unavailable: 'errors.model_catalog_unavailable',
  model_catalog_timeout: 'errors.model_catalog_timeout',
  model_catalog_exit: 'errors.model_catalog_exit',
  run_not_found: 'errors.run_not_found',
  run_finished: 'errors.run_finished',
  run_finished_while_cancelling: 'errors.run_finished_while_cancelling',
  cancel_before_delete: 'errors.cancel_before_delete',
  invalid_language: 'errors.invalid_language',
  suite_id_invalid: 'errors.suite_id_invalid',
  suite_not_found: 'errors.suite_not_found',
  suite_unreadable: 'errors.suite_unreadable',
  suite_invalid: 'errors.suite_invalid',
  suite_name_missing: 'errors.suite_name_missing',
  suite_name_too_long: 'errors.suite_name_too_long',
  suite_timeout_out_of_range: 'errors.suite_timeout_out_of_range',
  suite_tests_missing: 'errors.suite_tests_missing',
  test_name_missing: 'errors.test_name_missing',
  test_name_too_long: 'errors.test_name_too_long',
  test_duplicated: 'errors.test_duplicated',
  test_type_invalid: 'errors.test_type_invalid',
  test_prompt_missing: 'errors.test_prompt_missing',
  test_prompt_not_found: 'errors.test_prompt_not_found',
  open_test_judge_forbidden: 'errors.open_test_judge_forbidden',
  open_test_rubric_missing: 'errors.open_test_rubric_missing',
  code_test_verify_missing: 'errors.code_test_verify_missing',
  test_fixture_not_found: 'errors.test_fixture_not_found',
  verify_timeout_out_of_range: 'errors.verify_timeout_out_of_range',
  verify_command_unsafe: 'errors.verify_command_unsafe',
  path_outside_suite: 'errors.path_outside_suite',
  state_changed: 'errors.state_changed',
  baseline_verify_failed: 'errors.baseline_verify_failed',
  baseline_verify_timeout: 'errors.baseline_verify_timeout',
  baseline_setup_failed: 'errors.baseline_setup_failed',
  test_missing: 'errors.test_missing',
  git_init_failed: 'errors.git_init_failed',
  model_timeout: 'errors.model_timeout',
  verify_timeout: 'errors.verify_timeout',
  judge_timeout: 'errors.judge_timeout',
  judge_invalid_json: 'errors.judge_invalid_json',
  metrics_missing: 'errors.metrics_missing',
  verdict_timeout: 'errors.verdict_timeout',
} as const;

export type ApiErrorCode = keyof typeof apiErrorText;

/**
 * Resuelve el idioma inicial: lo guardado manda sólo si es un idioma soportado;
 * en cualquier otro caso decide el navegador, y lo que no sea español cae a inglés.
 */
export function resolveInitialLanguage(stored: string | null, navigatorLanguage: string): Language {
  if (stored === 'es' || stored === 'en') return stored;
  return navigatorLanguage.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/** Elige la forma plural del idioma con las reglas de `Intl.PluralRules`. */
export function plural(language: Language, count: number, forms: { one: string; other: string }): string {
  return new Intl.PluralRules(locales[language]).select(count) === 'one' ? forms.one : forms.other;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    return value === undefined ? '' : String(value);
  });
}

/**
 * Traduce una clave en el idioma pedido. Una clave inexistente devuelve la clave
 * en lugar de `undefined`, para que un backend o cliente más nuevo no rompa la vista.
 */
export function translate(language: Language, key: TranslationKey, params?: Record<string, string | number>): string {
  const template = (dictionaries[language] as Record<string, string>)[key];
  if (template === undefined) return key;
  const count = params?.count;
  const text = typeof count === 'number' && template.includes('|')
    ? plural(language, count, { one: template.split('|')[0], other: template.split('|')[1] })
    : template;
  return interpolate(text, params);
}

/** Placeholders que espera una plantilla; con plurales se revisan las dos formas. */
function templateParams(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
}

/**
 * Traduce un `code` de la API; si el cliente no lo conoce, conserva el texto en inglés.
 * Los `params` que mandó la API se interpolan en la plantilla del código conocido. Si
 * falta alguno de los que la plantilla necesita, se devuelve el `fallback` en lugar de
 * dejar un hueco: la prosa de la API ya trae el valor.
 */
export function translateError(
  t: Translate,
  code: string | undefined,
  fallback: string,
  params?: Record<string, string | number>,
): string {
  if (!code) return fallback;
  const key = (apiErrorText as Record<string, TranslationKey | undefined>)[code];
  if (key === undefined) return fallback;
  const template = (es as Record<string, string>)[key];
  if (template !== undefined && templateParams(template).some((name) => params?.[name] === undefined)) {
    return fallback;
  }
  return t(key, params);
}

/**
 * Etiqueta visible de un estado de la API. Un estado que el diccionario no conoce se
 * muestra crudo: un backend más nuevo no deja la vista sin texto.
 */
export function statusLabel(t: Translate, value: string): string {
  const key = `status.${value}` as TranslationKey;
  return key in es ? t(key) : value;
}

export type BehaviorSignalText = { kind: string; title: string; explanation: string; evidence: Record<string, unknown> };

/**
 * Clave del diccionario para una señal: `signals.<kind>.<part>`. El cast es seguro
 * porque el `kind` sólo se usa después de que `hasSignal` confirme que la clave existe.
 */
export function signalTextKey(kind: string, part: 'title' | 'explanation'): TranslationKey {
  return `signals.${kind}.${part}` as TranslationKey;
}

/** ¿El diccionario conoce el `kind` de señal? Si no, se muestra el texto de la API. */
export function hasSignal(kind: string): boolean {
  return signalTextKey(kind, 'title') in es;
}

/** Sólo los valores escalares de `evidence` sirven como parámetros de plantilla. */
function signalParams(evidence: Record<string, unknown>): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(evidence)) {
    if (typeof value === 'string' || typeof value === 'number') params[name] = value;
  }
  return params;
}

const signalPlurals: Record<string, Record<string, TranslationKey>> = {
  tool_loop: { calls: 'signals.tool_loop.calls', errors: 'signals.tool_loop.errors' },
  error_burst: { toolErrors: 'signals.error_burst.toolErrors', modelErrors: 'signals.error_burst.modelErrors' },
  long_session: { modelSteps: 'signals.long_session.modelSteps', spans: 'signals.long_session.spans' },
};

/**
 * Traduce una señal por `kind` y `evidence`. Un `kind` que el diccionario no
 * conoce conserva el título y la explicación que mandó la API, nunca una clave.
 */
export function translateSignal(t: Translate, signal: BehaviorSignalText): { title: string; explanation: string } {
  if (!hasSignal(signal.kind)) return { title: signal.title, explanation: signal.explanation };
  const params = signalParams(signal.evidence);
  for (const [field, pluralKey] of Object.entries(signalPlurals[signal.kind] ?? {})) {
    const value = params[field];
    if (typeof value === 'number') {
      params[`${field}Text`] = t(pluralKey, { count: value, value });
    }
  }
  return {
    title: t(signalTextKey(signal.kind, 'title'), params),
    explanation: t(signalTextKey(signal.kind, 'explanation'), params),
  };
}

export function formatCompact(language: Language, value: number): string {
  return new Intl.NumberFormat(locales[language], { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/**
 * Número decimal localizado con los decimales que pida el llamador. Sin opciones usa el
 * valor por defecto de `Intl`, así que quien necesite exactitud (tasas, montos acotados)
 * debe fijar `minimumFractionDigits` y `maximumFractionDigits`.
 */
export function formatNumber(language: Language, value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locales[language], options).format(value);
}

/** Fecha y hora localizadas; para sólo la hora está `formatClock`. */
export function formatDate(language: Language, value: string | Date): string {
  return new Date(value).toLocaleString(locales[language]);
}

export function formatClock(language: Language, value: string | Date): string {
  return new Date(value).toLocaleTimeString(locales[language]);
}

export function formatMoney(language: Language, value: number): string {
  const formatted = new Intl.NumberFormat(locales[language], {
    minimumFractionDigits: 8,
    maximumFractionDigits: 8,
  }).format(value);
  return `US$ ${formatted}`;
}

type LanguageContextValue = {
  language: Language;
  t: Translate;
  setLanguage: (language: Language) => void;
};

const LanguageContext = React.createContext<LanguageContextValue | null>(null);

function storedLanguage(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(languageStorageKey);
  } catch {
    return null;
  }
}

function applyDocumentLanguage(language: Language): void {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

/** Provee el idioma activo, su `t` memoizado por idioma y el setter persistente. */
export function LanguageProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [language, setLanguageState] = React.useState<Language>(() =>
    resolveInitialLanguage(storedLanguage(), typeof navigator === 'undefined' ? 'en' : navigator.language));

  const setLanguage = React.useCallback((next: Language) => {
    try {
      window.localStorage.setItem(languageStorageKey, next);
    } catch {
      // Sin almacenamiento disponible el cambio vale sólo para esta sesión.
    }
    applyDocumentLanguage(next);
    setLanguageState(next);
  }, []);

  React.useEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

  const t = React.useMemo<Translate>(
    () => (key, params) => translate(language, key, params),
    [language],
  );

  return React.createElement(LanguageContext.Provider, { value: { language, t, setLanguage } }, children);
}

export function useLanguage(): LanguageContextValue {
  const value = React.useContext(LanguageContext);
  if (value === null) throw new Error('useLanguage debe usarse dentro de LanguageProvider');
  return value;
}
