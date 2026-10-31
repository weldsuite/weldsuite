import type { DeskPortalField, DeskPortalRequestType } from '@weldsuite/app-api-client/schemas/desk-portal'

/**
 * The request form's conditional-field rules, client side. A copy of
 * `isDeskPortalFieldShown` in packages/core/db/src/lib/desk-portal.ts (the
 * server re-validates with that one); @weldsuite/db stays out of the browser
 * bundle. Keep the two in step.
 */

/** A form value: text-like fields hold strings, multiselect an array, checkbox a boolean. */
export type FieldValue = string | string[] | boolean

export type Answers = Record<string, unknown>

/**
 * DESK_PORTAL_TITLE_MAX / DESK_PORTAL_BODY_MAX of the desk-portal schemas, as
 * plain numbers: importing the schema module would pull zod into the browser.
 */
export const TITLE_MAX = 200
export const BODY_MAX = 10_000

const TITLE_KEY = 'title'
const DESCRIPTION_KEY = 'description'

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

function conditionText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(',')
  if (value === null || value === undefined) return ''
  return String(value)
}

/** Whether a field is shown, given the answers so far (all its conditions must hold). */
export function isFieldShown(field: Pick<DeskPortalField, 'conditions'>, answers: Answers): boolean {
  return field.conditions.every((cond) => {
    const answer = answers[cond.field]
    switch (cond.operator) {
      case 'is_set':
        return !isBlank(answer)
      case 'is_not_set':
        return isBlank(answer)
      case 'equals':
        return Array.isArray(answer)
          ? answer.map(String).includes(cond.value ?? '')
          : conditionText(answer) === (cond.value ?? '')
      case 'not_equals':
        return Array.isArray(answer)
          ? !answer.map(String).includes(cond.value ?? '')
          : conditionText(answer) !== (cond.value ?? '')
      default:
        return true
    }
  })
}

/** The initial (empty) value of a field. */
export function emptyValue(field: DeskPortalField): FieldValue {
  if (field.type === 'multiselect') return []
  if (field.type === 'checkbox') return false
  return ''
}

/**
 * What a field's form value means as an answer: an unticked checkbox is "not
 * set" (so a required checkbox has to be ticked), a number is sent as one.
 */
function answerOf(field: DeskPortalField, value: FieldValue | undefined): unknown {
  if (value === undefined) return undefined
  if (field.type === 'checkbox') return value === true ? true : undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (field.type === 'number') {
      const n = Number(trimmed)
      return Number.isFinite(n) ? n : trimmed
    }
    return trimmed
  }
  return value
}

/** Answers keyed like the server's: field values plus `title` and `description`. */
export function answersOf(
  type: DeskPortalRequestType,
  title: string,
  description: string,
  values: Record<string, FieldValue>,
): Answers {
  const answers: Answers = { [TITLE_KEY]: title, [DESCRIPTION_KEY]: description }
  for (const field of type.fields) answers[field.key] = answerOf(field, values[field.key])
  return answers
}

/**
 * The fields shown for these answers, in form order. A hidden field's answer
 * is not sent, so the server judges conditions without it; answers of hidden
 * fields are therefore cleared and the conditions re-checked until nothing
 * changes, which makes this the same set the server will see.
 */
export function shownFields(type: DeskPortalRequestType, answers: Answers): DeskPortalField[] {
  let shown = type.fields.filter((field) => isFieldShown(field, answers))
  for (let i = 0; i < type.fields.length; i++) {
    const visible = new Set(shown.map((f) => f.key))
    const next: Answers = { ...answers }
    for (const field of type.fields) if (!visible.has(field.key)) next[field.key] = undefined
    const again = type.fields.filter((field) => isFieldShown(field, next))
    if (again.length === shown.length && again.every((f, idx) => f.key === shown[idx]?.key)) break
    shown = again
  }
  return shown
}

/** The `fields` payload: shown fields that have an answer. Hidden ones are dropped. */
export function fieldsPayload(type: DeskPortalRequestType, answers: Answers): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of shownFields(type, answers)) {
    const answer = answers[field.key]
    if (!isBlank(answer)) out[field.key] = answer
  }
  return out
}

/** The keys of required inputs left empty: title, description, then shown fields. */
export function missingRequired(type: DeskPortalRequestType, answers: Answers): string[] {
  const missing: string[] = []
  if (isBlank(String(answers[TITLE_KEY] ?? '').trim())) missing.push(TITLE_KEY)
  if (type.descriptionLabel !== null && type.descriptionRequired && isBlank(String(answers[DESCRIPTION_KEY] ?? '').trim())) {
    missing.push(DESCRIPTION_KEY)
  }
  for (const field of shownFields(type, answers)) {
    if (field.required && isBlank(answers[field.key])) missing.push(field.key)
  }
  return missing
}
