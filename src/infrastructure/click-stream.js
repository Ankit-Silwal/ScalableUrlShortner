import { createHash } from 'node:crypto';

// Fixed across all versions/replicas. Changing partition count requires a drain/migration.
export const CLICK_PARTITIONS = 16;
export const streamFor = (prefix, partition) => prefix + ':clicks:' + partition;
export const partitionFor = (code) => createHash('sha256').update(code).digest().readUInt32BE(0) % CLICK_PARTITIONS;

// Never trim unprocessed events to make room. Preserve the existing backlog.
const appendScript = `
  if redis.call('XLEN', KEYS[1]) >= tonumber(ARGV[1]) then return false end
  return redis.call('XADD', KEYS[1], '*', 'code', ARGV[2], 'at', ARGV[3])
`;

export class ClickStream {
  constructor(redis, { prefix, maxLength, metrics }) {
    this.redis = redis;
    this.prefix = prefix;
    this.maxLength = maxLength;
    this.metrics = metrics;
  }
  async record(code, now) {
    try {
      const id = await this.redis.eval(appendScript, 1, streamFor(this.prefix, partitionFor(code)),
        String(this.maxLength), code, now.toISOString());
      this.metrics?.analytics.inc({ result: id ? 'queued' : 'dropped_full' });
    } catch {
      // Analytics is explicitly best effort at enqueue time; redirect availability wins.
      this.metrics?.analytics.inc({ result: 'dropped_error' });
    }
  }
}
