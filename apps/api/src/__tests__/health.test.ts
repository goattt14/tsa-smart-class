import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';

const app = createApp();

describe('GET /api/v1/health', () => {
  it('reports the service as ok without touching the database', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.service).toBe('tsa-api');
  });

  it('returns a request id header on every response', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-request-id']).toMatch(/[\w-]{8,}/);
  });

  it('echoes a client supplied request id', async () => {
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'trace-abc-12345');
    expect(res.headers['x-request-id']).toBe('trace-abc-12345');
  });
});

describe('unknown routes', () => {
  it('returns a structured 404 instead of an HTML error page', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(res.body.error.requestId).toBeTruthy();
  });
});
