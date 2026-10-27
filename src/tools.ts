import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { TwoGisApiError, type TwoGisClient } from './client.js';

const BRANCH_FIELDS = 'contactGroupsWithSplittedPhone,schedule,country,rubrics';

const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

const confirmField = z
  .boolean()
  .default(false)
  .describe('false = dry run: only show what would be sent. Set true only after the user approved the exact change.');

/** Write tools never touch 2GIS until the caller explicitly confirms. */
async function guarded(confirm: boolean, preview: Record<string, unknown>, run: () => Promise<unknown>) {
  if (!confirm) {
    return json({ dryRun: true, note: 'Nothing was sent. Repeat with confirm=true after user approval.', ...preview });
  }
  return json({ dryRun: false, ...preview, response: await run() });
}

interface RawReview {
  id: string;
  rating: number;
  text: string;
  dateCreated: string;
  dateEdited?: string | null;
  url?: string;
  catalog?: { id: string; name: string };
  user?: { name?: string; reviewsCount?: number };
  commentsCount?: number;
  hasCompanyComment?: boolean;
  firstAnswer?: unknown;
  attributes?: { isHidden?: boolean; isRated?: boolean; pinStatus?: string; hasUnresolvedComplains?: boolean };
  allowedActions?: Record<string, boolean>;
  photos?: unknown[];
}

interface ReviewList {
  items: RawReview[];
  totalCount?: number;
  '2gisReviewsCount'?: number;
  '2gisRating'?: unknown;
  rdReviewsCount?: number;
}

const compactReview = (r: RawReview) => ({
  id: r.id,
  rating: r.rating,
  text: r.text,
  date: r.dateCreated,
  edited: r.dateEdited ?? undefined,
  author: r.user?.name,
  catalog: r.catalog?.id,
  url: r.url,
  answered: r.hasCompanyComment ?? false,
  firstAnswer: r.firstAnswer ?? undefined,
  commentsCount: r.commentsCount,
  photos: r.photos?.length || undefined,
  hidden: r.attributes?.isHidden || undefined,
  /** false = unconfirmed review, excluded from the company rating */
  rated: r.attributes?.isRated,
  pinStatus: r.attributes?.pinStatus,
  canReply: r.allowedActions?.reply,
});

const scope = {
  orgId: z.string().optional().describe('Organization id (from list_orgs or the cabinet URL /orgs/{orgId})'),
  branchId: z.string().optional().describe('Branch (filial) id; takes precedence over orgId'),
};

function scopePath(prefix: string, suffix: string, a: { orgId?: string; branchId?: string }) {
  if (a.branchId) return `${prefix}/branch/${a.branchId}/${suffix}`;
  if (a.orgId) return `${prefix}/org/${a.orgId}/${suffix}`;
  throw new Error('Pass orgId or branchId');
}

const time = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM');
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

type Stars = '1' | '2' | '3' | '4' | '5';
interface RatingBucket {
  start: string;
  end: string;
  value: Record<Stars, number>;
}

/** 2GIS returns star counts per period; add the totals the cabinet shows. */
function summarizeRating(items: RatingBucket[]) {
  const counts: Record<Stars, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const { value } of items) for (const k of Object.keys(counts) as Stars[]) counts[k] += value[k] ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const sum = (Object.keys(counts) as Stars[]).reduce((a, k) => a + Number(k) * counts[k], 0);
  return {
    total,
    average: total ? Math.round((sum / total) * 100) / 100 : null,
    counts,
    items: items.filter((i) => Object.values(i.value).some(Boolean)),
  };
}

function yearBefore(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}
const day = z
  .object({
    from: time.nullable(),
    to: time.nullable(),
    breaks: z.array(z.object({ from: time, to: time })).optional(),
  })
  .describe('from/to null = day off');
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function registerTools(server: McpServer, api: TwoGisClient) {
  const read = { readOnlyHint: true, openWorldHint: true } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

  // ---------- organizations & branches ----------

  server.registerTool(
    'list_orgs',
    {
      title: 'List organizations',
      description: 'Organizations the 2GIS business account manages.',
      inputSchema: z.object({}),
      annotations: read,
    },
    async () => json(await api.get('orgs', { fields: 'orgDetails' })),
  );

  server.registerTool(
    'list_branches',
    {
      title: 'List branches',
      description: 'Branches (filials) of an organization with address and status.',
      inputSchema: z.object({
        orgId: z.string(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(50),
      }),
      annotations: read,
    },
    async ({ orgId, page, pageSize }) => json(await api.get('branches', { orgId, page, pageSize })),
  );

  server.registerTool(
    'get_branch',
    {
      title: 'Get branch card',
      description: 'Full branch card: name, address, rubrics, schedule, contacts.',
      inputSchema: z.object({
        branchId: z.string(),
        fields: z.string().default(BRANCH_FIELDS).describe('Comma-separated extra fields'),
      }),
      annotations: read,
    },
    async ({ branchId, fields }) => json(await api.get(`branches/${branchId}`, { fields })),
  );

  server.registerTool(
    'get_branch_attributes',
    {
      title: 'Get branch attributes',
      description: 'Branch attributes (payment methods, parking, Wi-Fi, …) with current values.',
      inputSchema: z.object({ branchId: z.string(), language: z.string().default('ru') }),
      annotations: read,
    },
    async ({ branchId, language }) => json(await api.get(`branches/${branchId}/attributes`, { language })),
  );

  server.registerTool(
    'get_special_days',
    {
      title: 'Get special days',
      description: 'Holiday / special working hours of a branch.',
      inputSchema: z.object({ branchId: z.string() }),
      annotations: read,
    },
    async ({ branchId }) => json(await api.get(`branches/${branchId}/special-days`)),
  );

  // ---------- reviews ----------

  server.registerTool(
    'list_reviews',
    {
      title: 'List reviews',
      description:
        'Reviews of an organization or branch, newest first. For the next page pass nextOffsetDate from the previous result as offsetDate.',
      inputSchema: z.object({
        ...scope,
        withoutAnswer: z.boolean().optional().describe('Only reviews without a company reply'),
        rating: z.enum(['positive', 'negative']).optional(),
        catalogs: z.string().default('2gis').describe('Review source, e.g. 2gis or flamp'),
        limit: z.number().int().min(1).max(50).default(20),
        offsetDate: z.string().optional().describe('Pagination cursor'),
      }),
      annotations: read,
    },
    async ({ orgId, branchId, withoutAnswer, rating, catalogs, limit, offsetDate }) => {
      const res = await api.get<ReviewList>(scopePath('presence', 'reviews', { orgId, branchId }), {
        withoutAnswer: withoutAnswer ? 'true' : undefined,
        rating,
        catalogs,
        limit,
        offsetDate,
      });
      const items = (res.items ?? []).map(compactReview);
      return json({
        totalCount: res.totalCount,
        reviewsCount2gis: res['2gisReviewsCount'],
        rating2gis: res['2gisRating'],
        items,
        nextOffsetDate: items.length === limit ? items[items.length - 1].date : null,
      });
    },
  );

  server.registerTool(
    'get_review',
    {
      title: 'Get review',
      description: 'One review with its company replies.',
      inputSchema: z.object({ reviewId: z.string(), catalog: z.string().default('2gis') }),
      annotations: read,
    },
    async ({ reviewId, catalog }) => {
      const [review, comments] = await Promise.all([
        api.get<RawReview>(`presence/reviews/${reviewId}`, { catalog }),
        api.get(`presence/reviews/${reviewId}/comments`, { catalog, limit: 100 }),
      ]);
      return json({ review: compactReview(review), comments });
    },
  );

  server.registerTool(
    'get_rating',
    {
      title: 'Get rating',
      description:
        'Star distribution of reviews for a period: totals, average and non-empty buckets per day or month. Defaults to the last 12 months.',
      inputSchema: z.object({
        ...scope,
        group: z.enum(['month', 'day']).default('month').describe('Bucket size'),
        periodStart: isoDay.optional().describe('Default: one year before periodEnd'),
        periodEnd: isoDay.optional().describe('Default: today'),
      }),
      annotations: read,
    },
    async ({ group, periodStart, periodEnd, ...a }) => {
      const end = periodEnd ?? new Date().toISOString().slice(0, 10);
      const start = periodStart ?? yearBefore(end);
      let items: RatingBucket[];
      try {
        const res = await api.get<{ items?: RatingBucket[] }>(scopePath('presence', 'rating', a), {
          group,
          periodStart: start,
          periodEnd: end,
        });
        items = res.items ?? [];
      } catch (e) {
        // 2GIS answers 404 when the scope has no reviews in the period.
        if (!(e instanceof TwoGisApiError && e.status === 404)) throw e;
        items = [];
      }
      return json({ periodStart: start, periodEnd: end, group, ...summarizeRating(items) });
    },
  );

  server.registerTool(
    'reply_to_review',
    {
      title: 'Reply to review',
      description:
        'Publish a public company reply to a review. Dry run by default: show the draft to the user and call again with confirm=true only after approval.',
      inputSchema: z.object({
        reviewId: z.string(),
        text: z.string().min(1).max(4000),
        catalog: z.string().default('2gis'),
        isOfficialAnswer: z.boolean().default(true).describe('Mark as the official company answer'),
        confirm: confirmField,
      }),
      annotations: write,
    },
    async ({ reviewId, text, catalog, isOfficialAnswer, confirm }) => {
      const body = { text, catalog, isOfficialAnswer };
      return guarded(confirm, { action: 'POST reply', reviewId, body }, () =>
        api.post(`presence/reviews/${reviewId}/comments`, body),
      );
    },
  );

  server.registerTool(
    'delete_review_reply',
    {
      title: 'Delete review reply',
      description: 'Delete a company reply. Take commentId and type from get_review comments.',
      inputSchema: z.object({
        reviewId: z.string(),
        commentId: z.string(),
        type: z.string().describe('Comment type as returned by get_review'),
        catalog: z.string().default('2gis'),
        confirm: confirmField,
      }),
      annotations: { ...write, destructiveHint: true },
    },
    async ({ reviewId, commentId, type, catalog, confirm }) =>
      guarded(confirm, { action: 'DELETE reply', reviewId, commentId, type, catalog }, () =>
        api.delete(`presence/reviews/${reviewId}/comments/${commentId}`, { catalog, type }),
      ),
  );

  // ---------- company card edits ----------

  server.registerTool(
    'update_schedule',
    {
      title: 'Update working hours',
      description:
        'Change the weekly schedule of a branch. Only listed days change; the rest keep their current hours. Dry run shows current vs new.',
      inputSchema: z.object({
        branchId: z.string(),
        days: z.object(Object.fromEntries(DAYS.map((d) => [d, day.optional()])) as Record<(typeof DAYS)[number], z.ZodOptional<typeof day>>),
        comment: z.string().nullable().optional().describe('Schedule comment shown in the card'),
        isTemporarilyClosed: z.boolean().optional(),
        confirm: confirmField,
      }),
      annotations: write,
    },
    async ({ branchId, days, comment, isTemporarilyClosed, confirm }) => {
      const current = await api.get<{ schedule?: Schedule }>(`branches/${branchId}`, { fields: 'schedule' });
      const before: Schedule = current.schedule ?? { days: {} };
      const schedule: Schedule = {
        ...before,
        days: { ...before.days, ...Object.fromEntries(Object.entries(days).filter(([, v]) => v)) },
        ...(comment !== undefined && { comment }),
        ...(isTemporarilyClosed !== undefined && { isTemporarilyClosed }),
      };
      return guarded(confirm, { action: 'PUT schedule', branchId, before, after: schedule }, () =>
        api.put(`branches/${branchId}`, { schedule }),
      );
    },
  );

  server.registerTool(
    'update_branch',
    {
      title: 'Update branch fields',
      description:
        'Low-level partial update of a branch card (PUT branches/{id} with only the changed fields). Prefer update_schedule for hours. Read the card with get_branch first to mirror its field format.',
      inputSchema: z.object({
        branchId: z.string(),
        changes: z.record(z.string(), z.unknown()).describe('Changed fields only, e.g. {"name": "..."}'),
        confirm: confirmField,
      }),
      annotations: write,
    },
    async ({ branchId, changes, confirm }) =>
      guarded(confirm, { action: 'PUT branch', branchId, changes }, () => api.put(`branches/${branchId}`, changes)),
  );

  server.registerTool(
    'update_branch_contacts',
    {
      title: 'Update branch contacts',
      description:
        'Replace branch contacts (phones, sites, socials). Pass the FULL list in the same format get_branch returns in contactGroups[].contacts — omitted contacts are removed.',
      inputSchema: z.object({
        branchId: z.string(),
        contacts: z.array(z.record(z.string(), z.unknown())),
        confirm: confirmField,
      }),
      annotations: { ...write, destructiveHint: true },
    },
    async ({ branchId, contacts, confirm }) =>
      guarded(confirm, { action: 'PUT contacts', branchId, contacts }, () =>
        api.put(`branches/${branchId}/contacts`, { contacts }),
      ),
  );

  server.registerTool(
    'update_branch_attributes',
    {
      title: 'Update branch attributes',
      description: 'Set branch attributes. Payload must mirror the structure returned by get_branch_attributes.',
      inputSchema: z.object({
        branchId: z.string(),
        payload: z.unknown(),
        confirm: confirmField,
      }),
      annotations: write,
    },
    async ({ branchId, payload, confirm }) =>
      guarded(confirm, { action: 'PUT attributes', branchId, payload }, () =>
        api.put(`branches/${branchId}/attributes`, payload),
      ),
  );

  server.registerTool(
    'set_special_days',
    {
      title: 'Set special days',
      description: 'Set holiday / special working hours. Payload must mirror get_special_days.',
      inputSchema: z.object({
        branchId: z.string(),
        payload: z.unknown(),
        confirm: confirmField,
      }),
      annotations: write,
    },
    async ({ branchId, payload, confirm }) =>
      guarded(confirm, { action: 'PUT special days', branchId, payload }, () =>
        api.put(`branches/${branchId}/special-days`, payload),
      ),
  );
}

interface Schedule {
  days: Record<string, unknown>;
  comment?: string | null;
  isTemporarilyClosed?: boolean;
}
