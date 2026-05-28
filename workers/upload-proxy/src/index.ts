import type { Env } from './schemas';
import { authenticate } from './auth';
import { handleHealth, jsonErr } from './handlers/health';
import { handleUpload } from './handlers/upload';
import { handleFeedback } from './handlers/feedback';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return handleHealth();
    }

    if (request.method === 'POST' && url.pathname === '/upload') {
      const authResult = await authenticate(request, env);
      if (authResult instanceof Response) return authResult;
      return handleUpload(request, env, ctx, authResult);
    }

    if (request.method === 'POST' && url.pathname === '/feedback') {
      const authResult = await authenticate(request, env);
      if (authResult instanceof Response) return authResult;
      return handleFeedback(request, env, ctx, authResult);
    }

    return jsonErr(404, 'not found');
  },
};
