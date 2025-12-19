/**
 * OfflineManager V7 - De "Snapshot" Editie
 * Past het advies toe: Gebruikt een onafhankelijk record voor de outbox.
 */
import DataGateway from './datagateway.js';

export default class OfflineManager {
  constructor(baseUrl, clientId, appName) {
    this.appName = appName;
    this.gateway = new DataGateway(baseUrl, clientId, appName);
    this.db = new Dexie(`AppCache_${appName}_${clientId}`);
    
    this.db.version(8).stores({ 
      data: "++id, collection, _id", 
      outbox: "++id, action, collection, payload"
    });
  }

  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Slaat een document op met een gegarandeerde snapshot voor de outbox.
   */
async saveSmartDocument(collectionName, data) {
    const record = JSON.parse(JSON.stringify(data));
    const serverId = record._id || null;
    const action = serverId ? 'PUT' : 'POST';

    // 1. Optimistic UI: Sla lokaal op INCLUSIEF de collection tag voor Dexie
    const localRecord = { ...record, collection: collectionName };
    
    if (serverId) {
      const existing = await this.db.data
        .where({ collection: collectionName, _id: serverId })
        .first();
      if (existing) {
        await this.db.data.update(existing.id, localRecord);
      } else {
        await this.db.data.add(localRecord);
      }
    } else {
      await this.db.data.add(localRecord);
    }

    // 2. Outbox: Sla de data op, maar we zorgen dat de syncOutbox straks de rommel opruimt
    await this.db.outbox.add({
      action: action,
      collection: collectionName,
      payload: record, 
      timestamp: Date.now()
    });

    if (navigator.onLine) {
      this.syncOutbox();
    }
    return record;
  }

  /**
   * Verwerkt de outbox.
   */
async syncOutbox() {
    if (!navigator.onLine) return;
    const items = await this.db.outbox.orderBy('id').toArray();
    if (items.length === 0) return;

    for (const item of items) {
      try {
        let finalPayload = JSON.parse(JSON.stringify(item.payload));

        // --- DE FIX: VERWIJDER INTERNE VELDEN VOOR VERZENDING ---
        delete finalPayload.collection; // Dit hoort niet in MongoDB
        delete finalPayload.id;         // Dit is het lokale Dexie-id, mag niet naar MongoDB
        
        // Converteer binaire data
        for (const key in finalPayload) {
          if (finalPayload[key] && (finalPayload[key] instanceof File || finalPayload[key] instanceof Blob)) {
            finalPayload[key] = await this._blobToBase64(finalPayload[key]);
          }
        }

        // Verstuur naar gateway
        const response = await this.gateway.saveDocument(item.collection, finalPayload);
        
        if (item.action === 'POST' && response && response._id) {
          await this._linkServerId(item.collection, item.payload, response._id);
        }

        await this.db.outbox.delete(item.id);
      } catch (err) {
        console.error(`[Sync Fout]`, err);
        continue; 
      }
    }
  }

  async _linkServerId(collectionName, originalPayload, newServerId) {
    const localRecord = await this.db.data
      .where({ collection: collectionName })
      .filter(doc => !doc._id && (doc.name?.trim() === originalPayload.name?.trim()))
      .first();

    if (localRecord) {
      await this.db.data.update(localRecord.id, { _id: newServerId });
    }
  }

  async getSmartCollection(collectionName) {
    let localData = await this.db.data.where({ collection: collectionName }).toArray();
    const seen = new Set();
    localData = localData.filter(item => {
      const identifier = item._id || `local-${item.id}`;
      if (seen.has(identifier)) return false;
      seen.add(identifier);
      return true;
    });

    if (navigator.onLine) {
      this.refreshCache(collectionName);
    }
    return localData;
  }

  async refreshCache(collectionName) {
    try {
      const freshData = await this.gateway.getCollection(collectionName);
      const outboxItems = await this.db.outbox.where({ collection: collectionName }).toArray();
      const pendingIds = new Set(outboxItems.map(i => i.payload._id).filter(id => id));
      const pendingNewNames = new Set(outboxItems.filter(i => !i.payload._id).map(i => i.payload.name));

      await this.db.data.where({ collection: collectionName })
        .filter(doc => {
            if (!doc._id) return !pendingNewNames.has(doc.name);
            return !pendingIds.has(doc._id);
        })
        .delete();
      
      const taggedData = freshData.map(d => ({ ...d, collection: collectionName }));
      await this.db.data.bulkPut(taggedData);
    } catch (err) {
      console.warn("[Cache] Refresh mislukt:", err);
    }
  }

  async clearSmartCollection(collectionName) {
    await this.db.data.where({ collection: collectionName }).delete();
    await this.db.outbox.add({ action: 'CLEAR', collection: collectionName });
    if (navigator.onLine) this.syncOutbox();
  }
}
