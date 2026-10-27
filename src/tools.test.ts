import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { TwoGisApiError, type TwoGisClient } from './client.js';
import { registerTools } from './tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function setup(responses: Record<string, unknown> = {}) {
  const handlers = new Map<string, { handler: Handler; schema: { parse(v: unknown): Record<string, unknown> } }>();
  const server = {
    registerTool: (name: string, cfg: { inputSchema: never }, handler: Handler) =>
      handlers.set(name, { handler, schema: cfg.inputSchema }),
  } as unknown as McpServer;
  const api = {
    get: vi.fn(async (path: string) => responses[path] ?? {}),
    post: vi.fn(async () => ({ id: 'c1' })),
    put: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({})),
  };
  registerTools(server, api as unknown as TwoGisClient);
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = handlers.get(name)!;
    const res = await t.handler(t.schema.parse(args));
    return JSON.parse(res.content[0].text);
  };
  return { api, call };
}

describe('write tools', () => {
  it('reply_to_review is a dry run unless confirmed', async () => {
    const { api, call } = setup();
    const dry = await call('reply_to_review', { reviewId: 'r1', text: 'Спасибо!' });
    expect(dry.dryRun).toBe(true);
    expect(dry.body).toEqual({ text: 'Спасибо!', catalog: '2gis', isOfficialAnswer: true });
    expect(api.post).not.toHaveBeenCalled();

    const sent = await call('reply_to_review', { reviewId: 'r1', text: 'Спасибо!', confirm: true });
    expect(sent.dryRun).toBe(false);
    expect(api.post).toHaveBeenCalledWith('presence/reviews/r1/comments', {
      text: 'Спасибо!',
      catalog: '2gis',
      isOfficialAnswer: true,
    });
  });

  it('update_schedule merges only the given days into the current schedule', async () => {
    const current = {
      schedule: {
        days: { Mon: { from: '09:00', to: '18:00' }, Sat: { from: null, to: null } },
        comment: null,
        isTemporarilyClosed: false,
      },
    };
    const { api, call } = setup({ 'branches/b1': current });
    const res = await call('update_schedule', { branchId: 'b1', days: { Sat: { from: '10:00', to: '15:00' } }, confirm: true });
    expect(res.after.days).toEqual({ Mon: { from: '09:00', to: '18:00' }, Sat: { from: '10:00', to: '15:00' } });
    expect(api.put).toHaveBeenCalledWith('branches/b1', { schedule: res.after });
  });

  it('every write tool defaults to dry run', async () => {
    const { api, call } = setup({ 'branches/b1': { schedule: { days: {} } } });
    await call('delete_review_reply', { reviewId: 'r', commentId: 'c', type: 't' });
    await call('update_schedule', { branchId: 'b1', days: {} });
    await call('update_branch', { branchId: 'b1', changes: { name: 'x' } });
    await call('update_branch_contacts', { branchId: 'b1', contacts: [] });
    await call('update_branch_attributes', { branchId: 'b1', payload: {} });
    await call('set_special_days', { branchId: 'b1', payload: [] });
    expect(api.put).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });
});

describe('list_reviews', () => {
  it('compacts items and returns a pagination cursor', async () => {
    const item = (id: string, date: string) => ({ id, rating: 5, text: 't', dateCreated: date, user: { name: 'A' }, hasCompanyComment: false });
    const { api, call } = setup({
      'presence/org/o1/reviews': { totalCount: 3, items: [item('1', 'd1'), item('2', 'd2')] },
    });
    const res = await call('list_reviews', { orgId: 'o1', withoutAnswer: true, limit: 2 });
    expect(api.get).toHaveBeenCalledWith('presence/org/o1/reviews', expect.objectContaining({ withoutAnswer: 'true', limit: 2, catalogs: '2gis' }));
    expect(res.items[0]).toMatchObject({ id: '1', author: 'A', answered: false });
    expect(res.nextOffsetDate).toBe('d2');
  });
});

describe('get_rating', () => {
  const bucket = (start: string, value: Record<string, number>) => ({ start, end: start, value: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, ...value } });

  it('sends the required period params and summarizes the distribution', async () => {
    const { api, call } = setup({
      'presence/org/o1/rating': { items: [bucket('2026-06-01', {}), bucket('2026-07-01', { 5: 2 }), bucket('2026-08-01', { 1: 1 })] },
    });
    const res = await call('get_rating', { orgId: 'o1', periodStart: '2026-01-01', periodEnd: '2026-10-27' });
    expect(api.get).toHaveBeenCalledWith('presence/org/o1/rating', { group: 'month', periodStart: '2026-01-01', periodEnd: '2026-10-27' });
    expect(res).toMatchObject({ total: 3, average: 3.67, counts: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 2 } });
    expect(res.items.map((i: { start: string }) => i.start)).toEqual(['2026-07-01', '2026-08-01']);
  });

  it('defaults to the last 12 months', async () => {
    const { api, call } = setup({ 'presence/branch/b1/rating': { items: [] } });
    await call('get_rating', { branchId: 'b1', periodEnd: '2026-10-27' });
    expect(api.get).toHaveBeenCalledWith('presence/branch/b1/rating', { group: 'month', periodStart: '2025-10-27', periodEnd: '2026-10-27' });
  });

  it('treats 404 as a period without reviews', async () => {
    const { api, call } = setup();
    api.get.mockRejectedValueOnce(new TwoGisApiError(404, 'Not found'));
    const res = await call('get_rating', { branchId: 'b1', periodStart: '2026-01-01', periodEnd: '2026-10-27' });
    expect(res).toMatchObject({ total: 0, average: null, items: [] });
  });

  it('rejects non-ISO dates', async () => {
    const { call } = setup();
    await expect(call('get_rating', { orgId: 'o1', periodStart: '01.01.2026' })).rejects.toThrow();
  });
});

describe('get_review', () => {
  it('passes the catalog and a comments limit the API requires', async () => {
    const review = { id: 'r1', rating: 1, text: 't', dateCreated: 'd', attributes: { isRated: false } };
    const { api, call } = setup({ 'presence/reviews/r1': review, 'presence/reviews/r1/comments': { items: [] } });
    const res = await call('get_review', { reviewId: 'r1' });
    expect(api.get).toHaveBeenCalledWith('presence/reviews/r1', { catalog: '2gis' });
    expect(api.get).toHaveBeenCalledWith('presence/reviews/r1/comments', { catalog: '2gis', limit: 100 });
    expect(res.review).toMatchObject({ id: 'r1', rated: false });
  });
});
