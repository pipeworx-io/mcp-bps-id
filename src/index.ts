interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * BPS — Badan Pusat Statistik (Statistics Indonesia) WebAPI MCP.
 *
 * Indonesia's official statistics: subjects, variables, dynamic table data,
 * static tables, publications, press releases, and news.
 *
 * REQUIRES A KEY: BPS issues a free "App ID" (sign up at
 * https://webapi.bps.go.id/developer/). The key is a PATH segment in every
 * request (.../key/{APP_ID}/), passed to every tool via _apiKey.
 *
 * Discovery flow for an LLM caller:
 *   1. list(model="subject")  → discover subject ids (subjectId)
 *   2. list(model="var", ...) → discover variable ids (var) under a subject
 *   3. get_data(var=<id>)     → pull the dynamic table data for that variable
 *   4. list/view for statictable, publication, pressrelease, news as needed.
 *
 * domain "0000" = national. Regional domains are BPS region codes (provinces/
 * regencies), discoverable via list(model="domain") on the human docs.
 *
 * Docs: https://webapi.bps.go.id/documentation/
 *
 * Tools:
 * - bps_list:     generic list for a model (subject/var/statictable/...).
 * - bps_get_data: dynamic table data for a variable id (model=data).
 * - bps_view:     fetch a single object by id (statictable/publication/...).
 *
 * NOTE: BPS sits behind Cloudflare bot protection and may return a 403
 * "Just a moment..." challenge to non-browser clients. This is detected at
 * runtime and surfaced as a clear error.
 */


const BASE = 'https://webapi.bps.go.id/v1/api';
const UA = 'pipeworx-mcp-bps-id/1.0 (+https://pipeworx.io)';

// Valid list models per BPS WebAPI docs.
const LIST_MODELS = [
  'subject',
  'subcat', // subject category
  'subcsa', // subcategory
  'var', // variable
  'vervar', // vertical (region) variable
  'turvar', // derived variable
  'th', // period / year
  'data',
  'statictable',
  'pressrelease',
  'publication',
  'news',
  'newscategory',
  'infographic',
  'kbli', // standard industrial classification
  'kbki', // standard commodity classification
] as const;

// Models addressable by `view` (single-object) endpoint.
const VIEW_MODELS = ['statictable', 'publication', 'pressrelease', 'news'] as const;

// ── Helpers ───────────────────────────────────────────────────────────

function extractKey(args: Record<string, unknown>): string {
  const key = args._apiKey as string;
  delete args._apiKey;
  if (!key || typeof key !== 'string' || !key.trim()) {
    throw new Error(
      'BPS App ID (API key) required. Register free at https://webapi.bps.go.id/developer/ to get an App ID, then pass it via _apiKey.',
    );
  }
  return key.trim();
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  }
  return v.trim();
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  return String(v).trim();
}

/** Build a BPS path-segment URL: keys/values are appended as /k/v/ pairs. */
function buildUrl(prefix: string, segments: Array<[string, string]>, key: string): string {
  const parts = segments.map(([k, v]) => `${k}/${encodeURIComponent(v)}`);
  // key is always the final segment, with a trailing slash.
  return `${BASE}/${prefix}/${parts.join('/')}/key/${encodeURIComponent(key)}/`;
}

async function bpsGet(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
  });

  const body = await res.text();

  // Cloudflare bot-protection interstitial: BPS frequently serves a 403 (or
  // even a 200) HTML "Just a moment..." challenge to non-browser clients.
  const head = body.slice(0, 200);
  if (head.trimStart().startsWith('<!DOCTYPE html') || /Just a moment/i.test(head)) {
    throw new Error('BPS: blocked by upstream bot protection (Cloudflare challenge)');
  }

  if (!res.ok) {
    throw new Error(`BPS: ${res.status} ${body.slice(0, 200)}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`BPS: unexpected non-JSON response: ${body.slice(0, 200)}`);
  }

  return interpretEnvelope(data);
}

/**
 * BPS wraps results in an envelope:
 *   { status: "OK"|"Error", "data-availability": "available"|"not-available",
 *     data: [...], ...page metadata... }
 * status "Error" / "not-available" means no data — surface the message as a
 * structured no-data result rather than throwing.
 */
function interpretEnvelope(data: unknown): unknown {
  if (data && typeof data === 'object') {
    const env = data as Record<string, unknown>;
    const status = typeof env.status === 'string' ? env.status : undefined;
    const availability = env['data-availability'];
    const notAvailable = availability === 'not-available';
    if ((status && status.toLowerCase() === 'error') || notAvailable) {
      return {
        found: false,
        reason: 'no_data',
        provider: 'bps-id',
        status: status ?? null,
        data_availability: availability ?? null,
        message:
          (typeof env.message === 'string' && env.message) ||
          'BPS returned no data for this request (status Error / data not-available). Verify the domain, model, and id/var via bps_list.',
      };
    }
  }
  return data;
}

// ── Tool definitions ──────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'bps_list',
    description:
      'List BPS (Statistics Indonesia) objects for a given model — the workhorse for discovery. ' +
      'Use model="subject" to find subject ids, then model="var" (optionally filtered by subject) to find variable ids for bps_get_data. ' +
      'Other models: statictable, publication, pressrelease, news, subcat/subcsa, vervar, turvar, th. ' +
      'domain "0000" = national; regional domains are BPS region codes. Returns the BPS envelope { status, data-availability, data: [...] }.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _apiKey: { type: 'string', description: 'BPS App ID (API key)' },
        model: {
          type: 'string',
          description:
            'Object type to list. One of: subject, subcat, subcsa, var, vervar, turvar, th, data, statictable, pressrelease, publication, news, newscategory, infographic, kbli, kbki. Default "subject".',
        },
        domain: {
          type: 'string',
          description: 'BPS domain/region code. "0000" = national (default). Regional = province/regency codes.',
        },
        lang: { type: 'string', description: 'Language: "eng" (default) or "ind".' },
        var: {
          type: 'string',
          description: 'Optional variable id to filter by (e.g. when listing model="data").',
        },
        subject: {
          type: 'string',
          description: 'Optional subject id (subjectId) to filter variables by, when model="var".',
        },
        page: { type: 'string', description: 'Optional 1-based page number for paginated results.' },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'bps_get_data',
    description:
      'Get dynamic statistical table data for a BPS variable id (model=data). Returns the datacontent values keyed by ' +
      'composite dimension codes, plus the dimension label arrays (var, vervar/region, turvar, tahun/period, turtahun) ' +
      'needed to decode them. Discover the variable id first via bps_list(model="var"). domain "0000" = national.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _apiKey: { type: 'string', description: 'BPS App ID (API key)' },
        var: {
          type: 'string',
          description: 'Variable id (varId) to fetch data for. Discover via bps_list(model="var").',
        },
        domain: {
          type: 'string',
          description: 'BPS domain/region code. "0000" = national (default).',
        },
        lang: { type: 'string', description: 'Language: "eng" (default) or "ind".' },
        th: { type: 'string', description: 'Optional period/year id to filter the data by.' },
        page: { type: 'string', description: 'Optional 1-based page number.' },
      },
      required: ['_apiKey', 'var'],
    },
  },
  {
    name: 'bps_view',
    description:
      'Fetch a single BPS object by id — full detail for one statictable, publication, pressrelease, or news item. ' +
      'Discover ids first via bps_list with the matching model. domain "0000" = national.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _apiKey: { type: 'string', description: 'BPS App ID (API key)' },
        model: {
          type: 'string',
          description: 'Object type: one of statictable, publication, pressrelease, news.',
        },
        id: { type: 'string', description: 'The object id (from bps_list results).' },
        domain: {
          type: 'string',
          description: 'BPS domain/region code. "0000" = national (default).',
        },
        lang: { type: 'string', description: 'Language: "eng" (default) or "ind".' },
      },
      required: ['_apiKey', 'model', 'id'],
    },
  },
];

// ── callTool dispatcher ───────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const key = extractKey(args);

  switch (name) {
    case 'bps_list':
      return listModel(key, args);
    case 'bps_get_data':
      return getData(key, args);
    case 'bps_view':
      return viewObject(key, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Tool implementations ─────────────────────────────────────────────

async function listModel(key: string, args: Record<string, unknown>): Promise<unknown> {
  const model = (optStr(args, 'model') ?? 'subject').toLowerCase();
  if (!(LIST_MODELS as readonly string[]).includes(model)) {
    throw new Error(`Unknown model "${model}". Valid models: ${LIST_MODELS.join(', ')}.`);
  }
  const domain = optStr(args, 'domain') ?? '0000';
  const lang = normalizeLang(optStr(args, 'lang'));

  const segments: Array<[string, string]> = [
    ['model', model],
    ['lang', lang],
    ['domain', domain],
  ];

  const subject = optStr(args, 'subject');
  if (subject) segments.push(['subject', subject]);
  const varId = optStr(args, 'var');
  if (varId) segments.push(['var', varId]);
  const page = optStr(args, 'page');
  if (page) segments.push(['page', page]);

  return bpsGet(buildUrl('list', segments, key));
}

async function getData(key: string, args: Record<string, unknown>): Promise<unknown> {
  const varId = reqStr(args, 'var', '"7" (find ids via bps_list model="var")');
  const domain = optStr(args, 'domain') ?? '0000';
  const lang = normalizeLang(optStr(args, 'lang'));

  const segments: Array<[string, string]> = [
    ['model', 'data'],
    ['lang', lang],
    ['domain', domain],
    ['var', varId],
  ];

  const th = optStr(args, 'th');
  if (th) segments.push(['th', th]);
  const page = optStr(args, 'page');
  if (page) segments.push(['page', page]);

  return bpsGet(buildUrl('list', segments, key));
}

async function viewObject(key: string, args: Record<string, unknown>): Promise<unknown> {
  const model = reqStr(args, 'model', '"publication"').toLowerCase();
  if (!(VIEW_MODELS as readonly string[]).includes(model)) {
    throw new Error(`view supports models: ${VIEW_MODELS.join(', ')}. Got "${model}".`);
  }
  const id = reqStr(args, 'id', '"123" (find ids via bps_list)');
  const domain = optStr(args, 'domain') ?? '0000';
  const lang = normalizeLang(optStr(args, 'lang'));

  const segments: Array<[string, string]> = [
    ['model', model],
    ['lang', lang],
    ['domain', domain],
    ['id', id],
  ];

  return bpsGet(buildUrl('view', segments, key));
}

function normalizeLang(lang: string | undefined): string {
  const l = (lang ?? 'eng').toLowerCase();
  return l === 'ind' || l === 'id' ? 'ind' : 'eng';
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
