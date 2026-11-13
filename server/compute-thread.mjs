import { parentPort, workerData } from 'node:worker_threads';
import { optimize } from './optimizer.mjs';

try {
  const result = await optimize(workerData.input, {
    onProgress: async (progress, stage) => parentPort.postMessage({ type: 'progress', progress, stage }),
  });
  parentPort.postMessage({ type: 'result', result });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error.message });
}
