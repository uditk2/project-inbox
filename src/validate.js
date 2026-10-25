// Small input validators shared by the API modules. Each returns the cleaned value or throws a 400 HttpError.
import {HttpError} from './core.js';

const bad = message => new HttpError(400, message);

export function text(value, label, max, required = false) {
  const out = value === undefined || value === null ? '' : value;
  if (typeof out !== 'string' || out.length > max || (required && !out.trim())) throw bad(`${label} must be ${required ? 'present and ' : ''}text of up to ${max} characters`);
  return out.trim();
}
export function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw bad(`${label} must be one of ${allowed.join(', ')}`);
  return value;
}
export function slug(value, label, max) {
  const out = text(value, label, max);
  if (out && !/^[a-z0-9-]+$/.test(out)) throw bad(`${label} must use lowercase letters, numbers and hyphens`);
  return out;
}
export function httpUrl(value, label, max = 2000) {
  const out = text(value, label, max);
  if (out && !/^https?:\/\/[^\s<>"]+$/i.test(out)) throw bad(`${label} must be an http or https link`);
  return out;
}
export const isCalendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
export function calendarDate(value, label) {
  if (!isCalendarDate(value)) throw bad(`${label} must be a real date in YYYY-MM-DD form`);
  return value;
}
export function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(`${label} must be an object`);
  return value;
}
// Accepts either {key:[...]} or a single item, and bounds how many can arrive in one request.
export function batchItems(body, key, max, label) {
  const items = Array.isArray(body?.[key]) ? body[key] : [body];
  if (!items.length || items.length > max) throw bad(`Send between 1 and ${max} ${label}`);
  return items;
}
