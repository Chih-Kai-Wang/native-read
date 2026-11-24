export function redactSecrets(input) {
  let str = typeof input === 'string' ? input : String(input ?? '');
  if (!str) return str;
  // Google API keys, OpenAI/Anthropic/DeepSeek/OpenRouter/Groq/HF/xAI keys, AQ tokens, auth headers, #nr_sync payloads
  str = str.replace(/AIza[0-9A-Za-z_-]{16,}/g, '[REDACTED_API_KEY]');
  str = str.replace(/\bsk-(?:ant-|or-|proj-)?[0-9A-Za-z_-]{12,}/g, '[REDACTED_API_KEY]');
  str = str.replace(/\bgsk_[0-9A-Za-z_-]{12,}/g, '[REDACTED_API_KEY]');
  str = str.replace(/\bhf_[0-9A-Za-z_-]{12,}/g, '[REDACTED_API_KEY]');
  str = str.replace(/\bxai-[0-9A-Za-z_-]{12,}/g, '[REDACTED_API_KEY]');
  str = str.replace(/\bAQ\.[0-9A-Za-z_.-]{16,}/g, '[REDACTED_API_KEY]');
  str = str.replace(/(Authorization["':\s]+Bearer\s+)[^\s"',}]+/gi, '$1[REDACTED_TOKEN]');
  str = str.replace(/(x-goog-api-key["':\s]+)[^\s"',}]+/gi, '$1[REDACTED_TOKEN]');
  str = str.replace(/(x-api-key["':\s]+)[^\s"',}]+/gi, '$1[REDACTED_TOKEN]');
  str = str.replace(/(api-key["':\s]+)[^\s"',}]+/gi, '$1[REDACTED_TOKEN]');
  str = str.replace(/(#nr_sync=)[A-Za-z0-9_%-]{16,}/g, '$1[REDACTED_SYNC_PAYLOAD]');
  return str;
}

export class AssertionError extends Error {
  constructor(message) {
    super(redactSecrets(message));
    this.name = 'AssertionError';
  }
}

export function formatValue(val) {
  try {
    if (typeof val === 'string') return redactSecrets(JSON.stringify(val));
    if (val instanceof RegExp) return val.toString();
    if (typeof val === 'undefined') return 'undefined';
    return redactSecrets(JSON.stringify(val));
  } catch (_) {
    return redactSecrets(String(val));
  }
}

export function assert(condition, message = 'Assertion failed') {
  if (!condition) {
    throw new AssertionError(message);
  }
}

export function assertEqual(actual, expected, message = '') {
  if (!Object.is(actual, expected)) {
    const prefix = message ? `${message}: ` : '';
    throw new AssertionError(`${prefix}expected ${formatValue(expected)}, got ${formatValue(actual)}`);
  }
}

export function assertNotEqual(actual, unexpected, message = '') {
  if (Object.is(actual, unexpected)) {
    const prefix = message ? `${message}: ` : '';
    throw new AssertionError(`${prefix}expected value not equal to ${formatValue(unexpected)}`);
  }
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

export function assertDeepEqual(actual, expected, message = '') {
  if (!deepEqual(actual, expected)) {
    const prefix = message ? `${message}: ` : '';
    throw new AssertionError(`${prefix}expected ${formatValue(expected)}, got ${formatValue(actual)}`);
  }
}

export function assertMatch(actual, regex, message = '') {
  const str = String(actual ?? '');
  if (!regex.test(str)) {
    const prefix = message ? `${message}: ` : '';
    throw new AssertionError(`${prefix}expected ${formatValue(str)} to match ${regex}`);
  }
}

export function assertNotMatch(actual, regex, message = '') {
  const str = String(actual ?? '');
  if (regex.test(str)) {
    const prefix = message ? `${message}: ` : '';
    throw new AssertionError(`${prefix}expected ${formatValue(str)} NOT to match ${regex}`);
  }
}

export function assertIncludes(container, needle, message = '') {
  const prefix = message ? `${message}: ` : '';
  if (typeof container === 'string') {
    if (!container.includes(String(needle))) {
      throw new AssertionError(`${prefix}expected string to include ${formatValue(needle)}`);
    }
    return;
  }
  if (Array.isArray(container)) {
    if (!container.includes(needle)) {
      throw new AssertionError(`${prefix}expected array to include ${formatValue(needle)}`);
    }
    return;
  }
  if (container && typeof container.has === 'function') {
    if (!container.has(needle)) {
      throw new AssertionError(`${prefix}expected collection to contain ${formatValue(needle)}`);
    }
    return;
  }
  throw new AssertionError(`${prefix}unsupported container type for assertIncludes`);
}

export function assertNotIncludes(container, needle, message = '') {
  const prefix = message ? `${message}: ` : '';
  if (typeof container === 'string') {
    if (container.includes(String(needle))) {
      throw new AssertionError(`${prefix}expected string NOT to include ${formatValue(needle)}`);
    }
    return;
  }
  if (Array.isArray(container)) {
    if (container.includes(needle)) {
      throw new AssertionError(`${prefix}expected array NOT to include ${formatValue(needle)}`);
    }
    return;
  }
  if (container && typeof container.has === 'function') {
    if (container.has(needle)) {
      throw new AssertionError(`${prefix}expected collection NOT to contain ${formatValue(needle)}`);
    }
    return;
  }
  throw new AssertionError(`${prefix}unsupported container type for assertNotIncludes`);
}

export function assertLessThanOrEqual(actual, max, message = '') {
  if (!(typeof actual === 'number' && Number.isFinite(actual) && actual <= max)) {
    const prefix = message ? `${message}: ` : '';
    throw new AssertionError(`${prefix}expected ${formatValue(actual)} <= ${formatValue(max)}`);
  }
}

export function assertGreaterThanOrEqual(actual, min, message = '') {
  if (!(typeof actual === 'number' && Number.isFinite(actual) && actual >= min)) {
    const prefix = message ? `${message}: ` : '';
    throw new AssertionError(`${prefix}expected ${formatValue(actual)} >= ${formatValue(min)}`);
  }
}

export function assertThrows(fn, expectedMatcher = null, message = '') {
  const prefix = message ? `${message}: ` : '';
  let threw = false;
  let caught = null;
  try {
    fn();
  } catch (err) {
    threw = true;
    caught = err;
  }
  if (!threw) {
    throw new AssertionError(`${prefix}expected function to throw`);
  }
  if (expectedMatcher instanceof RegExp) {
    assertMatch(caught?.message || String(caught), expectedMatcher, message);
  } else if (typeof expectedMatcher === 'function') {
    if (!(caught instanceof expectedMatcher)) {
      throw new AssertionError(`${prefix}expected error instance of ${expectedMatcher.name}, got ${caught?.name}`);
    }
  }
  return caught;
}

export async function assertRejects(promiseOrFn, expectedMatcher = null, message = '') {
  const prefix = message ? `${message}: ` : '';
  let rejected = false;
  let caught = null;
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (err) {
    rejected = true;
    caught = err;
  }
  if (!rejected) {
    throw new AssertionError(`${prefix}expected promise to reject`);
  }
  if (expectedMatcher instanceof RegExp) {
    assertMatch(caught?.message || String(caught), expectedMatcher, message);
  } else if (typeof expectedMatcher === 'function') {
    if (!(caught instanceof expectedMatcher)) {
      throw new AssertionError(`${prefix}expected rejection instance of ${expectedMatcher.name}, got ${caught?.name}`);
    }
  }
  return caught;
}
