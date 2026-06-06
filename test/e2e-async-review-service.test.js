import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { collectEvent } from '../src/collect-event.js';
import { startServiceServer } from '../src/service/server.js';
import { enqueueReviewJob } from '../src/service/service-client.js';

test('async service enqueues review job and exposes queued status on session detail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-bypass-e2e-async-'));
  const sessionId = 'sess_async_service';

  await collectEvent({
    root,
    payload: {
      runtime: 'codex',
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      prompt: 'Document the async local review service',
    },
  });

  const service = await startServiceServer({ root, startWorker: false, port: 0 });
  try {
    const enqueue = await enqueueReviewJob({
      url: service.url,
      job: { session_id: sessionId, runtime: 'codex', root },
    });
    assert.equal(enqueue.enqueued, true);

    const response = await fetch(`${service.url}/api/sessions/${encodeURIComponent(sessionId)}`);
    assert.equal(response.status, 200);
    const detail = await response.json();

    assert.equal(detail.session_id, sessionId);
    assert.equal(detail.job.status, 'queued');
  } finally {
    await service.close();
  }
});
