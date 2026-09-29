export class LinkCache {
  constructor(redis, { prefix, ttlSeconds, negativeTtlSeconds = 5 }) {
    this.redis = redis;
    this.prefix = prefix;
    this.ttl = ttlSeconds;
    this.negativeTtl = negativeTtlSeconds;
  }
  key(code) { return this.prefix + ':link:' + code; }
  async get(code) {
    const value = await this.redis.get(this.key(code));
    return value === null ? undefined : JSON.parse(value);
  }
  async remember(code, link) {
    // NX prevents an in-flight database read from overwriting a deletion tombstone.
    const ttl = link ? this.ttl : this.negativeTtl;
    await this.redis.set(this.key(code), JSON.stringify(link), 'EX', ttl, 'NX');
  }
  async created(link) {
    // Replace any negative cache entry from a lookup before creation.
    await this.redis.set(this.key(link.code), JSON.stringify(link), 'EX', this.ttl);
  }
  async deleted(code) {
    await this.redis.set(this.key(code), 'null', 'EX', Math.max(this.ttl, 60));
  }
}
