// Bounded bidirectional message-id map, so edits and deletes can follow a
// bridged message to its copy on the other side. In-memory only — a restart
// forgets history, which just means very old messages stop syncing edits.
export class IdMap {
  constructor(max = 5000) {
    this.max = max
    this.forward = new Map()  // sourceKey -> { peerKey, ...meta }
    this.backward = new Map() // peerKey  -> { sourceKey, ...meta }
  }

  link(sourceKey, peerKey, meta = {}) {
    this._evict()
    this.forward.set(sourceKey, { peerKey, ...meta })
    this.backward.set(peerKey, { sourceKey, ...meta })
  }

  bySource(k) { return this.forward.get(k) || null }
  byPeer(k) { return this.backward.get(k) || null }

  _evict() {
    while (this.forward.size >= this.max) {
      const oldest = this.forward.keys().next().value
      const rec = this.forward.get(oldest)
      this.forward.delete(oldest)
      if (rec) this.backward.delete(rec.peerKey)
    }
  }
}
